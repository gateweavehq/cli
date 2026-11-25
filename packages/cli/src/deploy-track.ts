import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CheckResult, checkFromOutside } from "./checks.ts";
import { CliError } from "./errors.ts";
import { cacheDir, npxCli } from "./paths.ts";
import { findRecord, type Step, saveRecord } from "./record.ts";
import { chooseRelease, type Pins, readPins, TRACK_REPOSITORY } from "./release.ts";
import type { RunResult, System } from "./system.ts";
import { nameTrack, type TrackNames } from "./wrangler-config.ts";

export interface DeployTrackOptions {
	name: string;
	release?: string;
	account?: string;
	attachments: boolean;
	yes: boolean;
}

export interface DeployTrackResult {
	ok: true;
	product: "track";
	release: string;
	account: { id: string; name: string };
	address: string;
	worker: string;
	database: { name: string; id: string | null };
	bucket: string | null;
	durableObjects: string[];
	secrets: { name: string; set: true; shown: false }[];
	/** False when an earlier run had already deployed it and this one only checked it. */
	deployedNow: boolean;
	checks: CheckResult[];
	next: string;
}

interface Account {
	id: string;
	name: string;
}

/** Parses the JSON a command printed, skipping anything before it. */
function json<T>(text: string): T {
	const start = text.search(/[[{]/);
	if (start < 0) throw new Error("no JSON in the output");
	return JSON.parse(text.slice(start)) as T;
}

function addStep(steps: Step[], step: Step): Step[] {
	return steps.includes(step) ? steps : [...steps, step];
}

export async function deployTrack(
	sys: System,
	options: DeployTrackOptions,
): Promise<DeployTrackResult> {
	const say = (line = "") => sys.err(`${line}\n`);
	const npx = npxCli(sys);
	const cache = cacheDir(sys);
	// Helper commands run in the cache, never in the working directory, so a Wrangler
	// configuration that happens to be there cannot choose the account or the names.
	await mkdir(cache, { recursive: true });

	// Preflight. Everything up to the yes only reads.
	const nodeMajor = Number(sys.nodeVersion.split(".")[0]);
	if (nodeMajor < 22) {
		throw new CliError(
			"requirement",
			"node-too-old",
			`Node ${sys.nodeVersion} is too old: use Node 22 or newer.`,
		);
	}
	const git = await sys.run("git", ["--version"], { cwd: cache, env: sys.env });
	if (git.status !== 0) {
		throw new CliError("requirement", "git-missing", "git is not installed or not on the PATH.");
	}
	const npxVersion = await sys.run(sys.execPath, [npx, "--version"], { cwd: cache, env: sys.env });
	if (npxVersion.status !== 0) {
		throw new CliError(
			"requirement",
			"npx-missing",
			`npm's npx was not found next to this Node (${npx}). Install Node with npm.`,
		);
	}

	let release = await chooseRelease(sys, cache, options.release);
	let pins = await readPins(sys, release);
	if (nodeMajor < pins.nodeMajor) {
		throw new CliError(
			"requirement",
			"node-too-old",
			`Track ${release} needs Node ${pins.nodeMajor} or newer; this is Node ${sys.nodeVersion}.`,
		);
	}

	let env: Record<string, string | undefined> = sys.env;
	const wrangler = (args: string[]): Promise<RunResult> =>
		sys.run(sys.execPath, [npx, "--yes", `wrangler@${pins.wrangler}`, ...args], {
			cwd: cache,
			env,
		});

	const account = await chooseAccount(sys, wrangler, pins, options.account);
	env = { ...sys.env, CLOUDFLARE_ACCOUNT_ID: account.id };

	const names: TrackNames = {
		worker: options.name,
		database: options.name,
		bucket: options.attachments ? `${options.name}-files` : null,
	};
	const record = await findRecord(sys, account.id, names.worker);
	if (record) {
		if (options.release && options.release !== record.release) {
			throw new CliError(
				"usage",
				"release-differs",
				`${names.worker} was deployed by this tool at Track ${record.release}. Moving it to another release is an update, which this version cannot do yet.`,
			);
		}
		if (record.bucket !== names.bucket) {
			throw new CliError(
				"usage",
				"attachments-differ",
				`${names.worker} was deployed ${record.bucket ? "with" : "without"} attachments. Run the command ${record.bucket ? "without" : "with"} --no-attachments, as the first time.`,
			);
		}
		// A second run finishes the first one's release, not whatever is newest now.
		if (record.release !== release) {
			release = record.release;
			pins = await readPins(sys, release);
		}
	}

	const existing = await lookUp(wrangler, names);
	const ours = (field: "worker" | "database" | "bucket", name: string | null) =>
		name !== null && record?.[field] === name;
	const taken: string[] = [];
	if (existing.worker && !ours("worker", names.worker)) taken.push(`the Worker ${names.worker}`);
	if (existing.databaseId && !ours("database", names.database)) {
		taken.push(`the D1 database ${names.database}`);
	}
	if (existing.bucket && !ours("bucket", names.bucket)) taken.push(`the R2 bucket ${names.bucket}`);
	if (taken.length > 0) {
		throw new CliError(
			"name-taken",
			"name-taken",
			`${taken.join(", ")} already exist${taken.length === 1 ? "s" : ""} in ${account.name}, and this tool did not make ${taken.length === 1 ? "it" : "them"}. Nothing was changed. Choose another name with --name.`,
		);
	}

	const deployedBefore = Boolean(record?.steps.includes("deployed") && existing.worker);
	const state = (exists: boolean) => (exists ? "made by an earlier run" : "new");

	// The plan.
	say(`Deploy Track ${release} into the Cloudflare account ${account.name} (${account.id}):`);
	say(`  Worker               ${names.worker}  (${state(existing.worker)})`);
	say(`  D1 database          ${names.database}  (${state(existing.databaseId !== null)})`);
	say(
		names.bucket
			? `  R2 bucket            ${names.bucket}  (${state(existing.bucket)})`
			: "  R2 bucket            none: attachments off",
	);
	say(`  Durable Objects      ${pins.durableObjects.join(", ")}`);
	say("  Secret               BETTER_AUTH_SECRET  (generated by Track's deploy, never shown)");
	say();

	let steps: Step[] = record?.steps ?? [];
	let address = record?.address ?? null;
	let databaseId = existing.databaseId;

	const save = () =>
		saveRecord(sys, {
			product: "track",
			accountId: account.id,
			accountName: account.name,
			release,
			worker: names.worker,
			database: names.database,
			databaseId,
			bucket: names.bucket,
			address,
			steps,
			updatedAt: new Date(sys.now()).toISOString(),
		});

	if (deployedBefore) {
		say("An earlier run deployed this already; nothing will be created. Checking it.");
	} else {
		await confirm(sys, options.yes);
		// Recorded before anything exists, so a run cut short is recognised as this tool's.
		await save();

		const checkout = join(cache, "track", `${release}-${names.worker}`);
		await fetchRelease(sys, npx, pins, release, checkout, names);
		steps = addStep(steps, "fetched");
		await save();

		say(`Running Track's own deploy (pnpm run deploy) in ${checkout}`);
		const deploy = await sys.run(
			sys.execPath,
			[npx, "--yes", `pnpm@${pins.pnpm}`, "run", "deploy"],
			{
				cwd: checkout,
				env,
				stream: true,
			},
		);
		if (deploy.status !== 0) {
			throw new CliError(
				"deploy-failed",
				"deploy-failed",
				`Track's deploy stopped (exit ${deploy.status}); its output is above. Run the same command again to finish: it recognises what this run made.`,
			);
		}
		const pattern = new RegExp(`https://${names.worker}\\.[a-z0-9-]+\\.workers\\.dev`);
		address = pattern.exec(`${deploy.stdout}\n${deploy.stderr}`)?.[0] ?? address;
		databaseId = (await lookUp(wrangler, { ...names, bucket: null })).databaseId;
		steps = addStep(steps, "deployed");
		await save();
	}

	if (!address) {
		throw new CliError(
			"checks-failed",
			"address-unknown",
			`Track is deployed, but its workers.dev address was not found in Wrangler's output, so it was not checked. Turn on workers.dev for ${names.worker} in the dashboard and run the command again.`,
		);
	}

	say(`Checking ${address} from outside (up to two minutes while it comes up)`);
	const checks = await checkFromOutside(sys, address);
	for (const check of checks)
		say(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
	const failed = checks.filter(({ ok }) => !ok);
	if (failed.length > 0) {
		throw new CliError(
			"checks-failed",
			"checks-failed",
			`Track is deployed at ${address}, but ${failed.map(({ name, detail }) => `${name} (${detail})`).join("; ")}.`,
		);
	}
	steps = addStep(steps, "checked");
	await save();

	return {
		ok: true,
		product: "track",
		release,
		account,
		address,
		worker: names.worker,
		database: { name: names.database, id: databaseId },
		bucket: names.bucket,
		durableObjects: pins.durableObjects,
		secrets: [{ name: "BETTER_AUTH_SECRET", set: true, shown: false }],
		deployedNow: !deployedBefore,
		checks,
		next:
			`Open ${address} now and create the first account: it owns this server. ` +
			`MCP stays off until BETTER_AUTH_URL is set to the address: ` +
			`npx wrangler@${pins.wrangler} secret put BETTER_AUTH_URL --name ${names.worker}`,
	};
}

async function chooseAccount(
	sys: System,
	wrangler: (args: string[]) => Promise<RunResult>,
	pins: Pins,
	wanted: string | undefined,
): Promise<Account> {
	const whoami = await wrangler(["whoami", "--json"]);
	let accounts: Account[] = [];
	try {
		const user = json<{ loggedIn?: boolean; accounts?: Account[] }>(whoami.stdout);
		if (whoami.status === 0 && user.loggedIn) accounts = user.accounts ?? [];
		else throw new Error("signed out");
	} catch {
		throw new CliError(
			"requirement",
			"not-signed-in",
			`Wrangler is not signed in to Cloudflare. Run \`npx wrangler@${pins.wrangler} login\`, or set CLOUDFLARE_API_TOKEN.`,
		);
	}
	const list = accounts.map(({ id, name }) => `  ${name}  ${id}`).join("\n");
	const id = wanted ?? sys.env.CLOUDFLARE_ACCOUNT_ID;
	if (id) {
		const account = accounts.find((candidate) => candidate.id === id);
		if (!account) {
			throw new CliError(
				"account",
				"account-not-found",
				`The account ${id} is not one this sign-in reaches. It reaches:\n${list}`,
			);
		}
		return account;
	}
	const [only, ...more] = accounts;
	if (!only) throw new CliError("account", "no-account", "This sign-in reaches no account.");
	if (more.length > 0) {
		throw new CliError(
			"account",
			"account-ambiguous",
			`This sign-in reaches several accounts; choose one with --account <id> or CLOUDFLARE_ACCOUNT_ID:\n${list}`,
		);
	}
	return only;
}

/** Whether each planned name is in use in the account. Only lists; changes nothing. */
async function lookUp(
	wrangler: (args: string[]) => Promise<RunResult>,
	names: TrackNames,
): Promise<{ worker: boolean; databaseId: string | null; bucket: boolean }> {
	const secrets = await wrangler(["secret", "list", "--name", names.worker, "--format", "json"]);
	const worker = secrets.status === 0;
	if (!worker && !/Worker ".+" not found/.test(secrets.stderr + secrets.stdout)) {
		throw new CliError(
			"requirement",
			"lookup-failed",
			`Could not tell whether the Worker ${names.worker} exists: ${secrets.stderr.trim()}`,
		);
	}

	const d1 = await wrangler(["d1", "list", "--json"]);
	let databases: { name: string; uuid: string }[];
	try {
		if (d1.status !== 0) throw new Error(d1.stderr.trim());
		databases = json(d1.stdout);
	} catch (error) {
		throw new CliError(
			"requirement",
			"lookup-failed",
			`Could not list the account's D1 databases: ${(error as Error).message}`,
		);
	}
	const databaseId = databases.find(({ name }) => name === names.database)?.uuid ?? null;

	let bucket = false;
	if (names.bucket) {
		const r2 = await wrangler(["r2", "bucket", "list"]);
		const output = r2.stderr + r2.stdout;
		if (r2.status !== 0 && /enable R2|\[code: 10042\]/.test(output)) {
			throw new CliError(
				"r2-off",
				"r2-off",
				"R2 is off in this Cloudflare account, and Track keeps attached files there. Either turn it on once in the dashboard (R2 Object Storage) and run the command again, or run it with --no-attachments to deploy Track without attachments.",
			);
		}
		if (r2.status !== 0) {
			throw new CliError(
				"requirement",
				"lookup-failed",
				`Could not list the account's R2 buckets, so the name ${names.bucket} could not be checked: ${r2.stderr.trim()}`,
			);
		}
		const listed = [...r2.stdout.matchAll(/^name:\s+(\S+)\s*$/gm)].map((match) => match[1]);
		bucket = listed.includes(names.bucket);
	}
	return { worker, databaseId, bucket };
}

async function confirm(sys: System, yes: boolean): Promise<void> {
	if (yes) return;
	if (!sys.interactive) {
		throw new CliError(
			"not-confirmed",
			"no-terminal",
			"Nothing was created: there is no terminal to answer on. Read the plan above and run the command again with --yes.",
		);
	}
	if (!(await sys.confirm("Create these? [y/N] "))) {
		throw new CliError("not-confirmed", "declined", "Nothing was created.");
	}
}

/**
 * A shallow clone of the release into the cache, its dependencies as locked, and the chosen names
 * in its `wrangler.jsonc`. Nothing else in the product changes.
 */
async function fetchRelease(
	sys: System,
	npx: string,
	pins: Pins,
	release: string,
	checkout: string,
	names: TrackNames,
): Promise<void> {
	const cache = join(checkout, "..");
	await mkdir(cache, { recursive: true });
	// A checkout left by a run cut short may be half written; start it again.
	await rm(checkout, { recursive: true, force: true });
	sys.err(`Fetching Track ${release} into ${checkout}\n`);
	const clone = await sys.run(
		"git",
		[
			"-c",
			"advice.detachedHead=false",
			"clone",
			"--depth",
			"1",
			"--branch",
			release,
			TRACK_REPOSITORY,
			checkout,
		],
		{ cwd: cache, env: sys.env, stream: true },
	);
	if (clone.status !== 0) {
		throw new CliError("deploy-failed", "fetch-failed", `Could not clone Track ${release}.`);
	}
	const install = await sys.run(
		sys.execPath,
		[npx, "--yes", `pnpm@${pins.pnpm}`, "install", "--frozen-lockfile"],
		{ cwd: checkout, env: sys.env, stream: true },
	);
	if (install.status !== 0) {
		throw new CliError(
			"deploy-failed",
			"install-failed",
			`Installing Track ${release}'s dependencies failed; pnpm's output is above.`,
		);
	}
	const config = join(checkout, "wrangler.jsonc");
	await writeFile(config, nameTrack(await readFile(config, "utf8"), names));
}
