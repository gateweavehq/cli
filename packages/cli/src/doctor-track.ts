import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHECK_IDS, checkFromOutside, mcpIsOn } from "./checks.ts";
import { type Account, chooseAccount, json, plain } from "./deploy-track.ts";
import { CliError } from "./errors.ts";
import { cacheDir, npxCli } from "./paths.ts";
import { type DeploymentRecord, findRecord } from "./record.ts";
import { compareTags, type Pins, readPins, releaseTags, TRACK_REPOSITORY } from "./release.ts";
import type { RunResult, System } from "./system.ts";
import { nameTrack } from "./wrangler-config.ts";

export type Status = "ok" | "warn" | "fail";

export interface Finding {
	/** Stable, for scripts: it does not change with the wording. */
	id: string;
	status: Status;
	/** One sentence. */
	message: string;
	/** A command or a link, or null when there is nothing to do. */
	fix: string | null;
}

export interface DoctorTrackOptions {
	name: string;
	account?: string;
	/** The address to look at from outside; the record's, when there is one. */
	url?: string;
}

export interface DoctorTrackResult {
	account: Account;
	/** Whether this tool deployed it and still has the record. */
	recorded: boolean;
	findings: Finding[];
}

const SELF_HOSTING = "https://github.com/gateweavehq/track/blob/main/docs/self-hosting.md";
const SIGN_UP_DOCS = `${SELF_HOSTING}#who-may-sign-up`;

/**
 * The one query doctor runs against the deployment's own database. It reads two facts the sign-up
 * pages do not show from outside, and whether Wrangler's migrations table exists: `d1 migrations
 * list` creates that table when it is missing, so doctor asks first and only lists when it is
 * there. The query is the same on every run: nothing a person typed goes into it.
 */
export const SIGN_UP_QUERY =
	"SELECT (SELECT sign_up FROM deployment WHERE id = 1) AS sign_up, EXISTS (SELECT 1 FROM user WHERE email NOT LIKE '%@agents.invalid') AS has_accounts, EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations') AS has_migrations_table";

interface DatabaseRow {
	sign_up: string | null;
	has_accounts: number;
	has_migrations_table: number;
}

/** What the fixed query found, or why it could not be asked. */
type DatabaseRead = { row: DatabaseRow } | { error: string };

/** What Track's login page says while its owner has closed sign-up. */
const CLOSED_SIGN_UP = /takes new accounts by invitation/i;

function secretFix(pins: Pins, worker: string, secret: string): string {
	const put = `npx wrangler@${pins.wrangler} secret put ${secret} --name ${worker}`;
	return secret === "BETTER_AUTH_SECRET"
		? `${put} (a long random value, for example from \`openssl rand -base64 32\`; setting a new one signs everyone out), or see ${SELF_HOSTING}`
		: `${put}, or see ${SELF_HOSTING}`;
}

/**
 * Looks at a Track deployment and says what is wrong with it. Everything it runs reads: Wrangler's
 * `whoami`, `secret list`, `d1 list`, `d1 migrations list` and the one fixed `d1 execute` above,
 * plus plain requests to the address. It writes only the cache, to have the release's migrations.
 */
export async function doctorTrack(
	sys: System,
	options: DoctorTrackOptions,
): Promise<DoctorTrackResult> {
	const npx = npxCli(sys);
	const cache = cacheDir(sys);
	await mkdir(cache, { recursive: true });

	// Without a release there is no Wrangler version to run, so nothing can be looked at.
	const tags = await releaseTags(sys, cache);
	const latest = tags[0];
	if (!latest) {
		throw new CliError("requirement", "release-not-found", "Track has no release tag yet.");
	}
	const latestPins = await readPins(sys, latest);

	let env: Record<string, string | undefined> = sys.env;
	const wrangler = (pins: Pins, args: string[], cwd = cache): Promise<RunResult> =>
		sys.run(sys.execPath, [npx, "--yes", `wrangler@${pins.wrangler}`, ...args], { cwd, env });

	const account = await chooseAccount(
		sys,
		(args) => wrangler(latestPins, args),
		latestPins,
		options.account,
	);
	env = { ...sys.env, CLOUDFLARE_ACCOUNT_ID: account.id };

	const record = await findRecord(sys, account.id, options.name);
	const worker = record?.worker ?? options.name;
	const findings: Finding[] = [];
	const finish = (): DoctorTrackResult => ({ account, recorded: record !== undefined, findings });

	// The Worker, through its list of secrets, which is also the list this tool checks.
	const listed = await wrangler(latestPins, [
		"secret",
		"list",
		"--name",
		worker,
		"--format",
		"json",
	]);
	if (listed.status !== 0) {
		if (!/Worker ".+" not found/.test(plain(listed.stderr + listed.stdout))) {
			throw new CliError(
				"requirement",
				"lookup-failed",
				`Could not tell whether the Worker ${worker} exists: ${listed.stderr.trim()}`,
			);
		}
		findings.push({
			id: "worker",
			status: "fail",
			message: `There is no Worker ${worker} in the Cloudflare account ${account.name} (${account.id}).`,
			fix: `Check --name and --account, or deploy it: gateweave deploy track --name ${worker}`,
		});
		return finish();
	}
	findings.push({
		id: "worker",
		status: "ok",
		message: `The Worker ${worker} exists in the Cloudflare account ${account.name} (${account.id}).`,
		fix: null,
	});
	let secrets: Set<string>;
	try {
		secrets = new Set(json<{ name: string }[]>(listed.stdout).map(({ name }) => name));
	} catch {
		throw new CliError(
			"requirement",
			"lookup-failed",
			`Could not read the secrets of ${worker}: Wrangler's list was not JSON.`,
		);
	}

	// The release this deployment runs, when known: the record's. Otherwise the newest stands in
	// for what to read the required secrets and the migrations from.
	const release = record?.release ?? latest;
	const pins = release === latest ? latestPins : await readPins(sys, release);

	for (const secret of pins.requiredSecrets) {
		const set = secrets.has(secret);
		findings.push({
			id: `secret-${secret.toLowerCase().replaceAll("_", "-")}`,
			status: set ? "ok" : "fail",
			message: set
				? `The secret ${secret} is set.`
				: `The secret ${secret} is not set on ${worker}, which Track ${release} requires.`,
			fix: set ? null : secretFix(pins, worker, secret),
		});
	}

	findings.push(releaseFinding(record, latest));

	const names = {
		worker,
		database: record?.database ?? options.name,
		bucket: record?.bucket ?? null,
	};
	const address = options.url ?? record?.address ?? null;

	const database = await databaseId(wrangler, latestPins, names.database);
	if (database === null) {
		findings.push({
			id: "migrations",
			status: record ? "fail" : "warn",
			message: `There is no D1 database named ${names.database} in the account, so its migrations and sign-up could not be read.`,
			fix: record
				? `Run gateweave deploy track --name ${worker} again to finish the deployment, or see ${SELF_HOSTING}`
				: `Name the Worker and its D1 database alike, or see ${SELF_HOSTING}`,
		});
	} else {
		const checkout = await ensureCheckout(sys, release, names);
		const read = await readDatabase(wrangler, pins, checkout);
		findings.push(
			await migrationsFinding(wrangler, pins, checkout, release, record !== undefined, read),
		);
		findings.push(...(await signUpFindings(sys, read, address)));
	}

	findings.push(await mcpFinding(sys, pins, worker, secrets, address));
	findings.push(...(await outsideFindings(sys, address)));
	return finish();
}

function releaseFinding(record: DeploymentRecord | undefined, latest: string): Finding {
	if (!record) {
		return {
			id: "release",
			status: "warn",
			message: `The release is unknown: this tool did not deploy it, and a deployment does not say which release it runs. The newest is ${latest}.`,
			fix: `Compare it with the release you deployed from: ${TRACK_REPOSITORY.replace(/\.git$/, "")}/releases`,
		};
	}
	if (compareTags(record.release, latest) < 0) {
		return {
			id: "release",
			status: "warn",
			message: `Track ${record.release} is older than ${latest}.`,
			fix: `Read what changed at ${TRACK_REPOSITORY.replace(/\.git$/, "")}/releases and update when it suits you.`,
		};
	}
	return {
		id: "release",
		status: "ok",
		message: `Track ${record.release} is the newest release.`,
		fix: null,
	};
}

async function databaseId(
	wrangler: (pins: Pins, args: string[]) => Promise<RunResult>,
	pins: Pins,
	name: string,
): Promise<string | null> {
	const listed = await wrangler(pins, ["d1", "list", "--json"]);
	try {
		if (listed.status !== 0) throw new Error(listed.stderr.trim());
		return (
			json<{ name: string; uuid: string }[]>(listed.stdout).find((db) => db.name === name)?.uuid ??
			null
		);
	} catch (error) {
		throw new CliError(
			"requirement",
			"lookup-failed",
			`Could not list the account's D1 databases: ${(error as Error).message}`,
		);
	}
}

/**
 * The release's own files in the cache, with the deployment's names in `wrangler.jsonc`, which
 * Wrangler needs to find the migrations and the database. A checkout the deploy made is reused,
 * and its names are written again. Null when it cannot be had.
 */
async function ensureCheckout(
	sys: System,
	release: string,
	names: { worker: string; database: string; bucket: string | null },
): Promise<string | null> {
	const parent = join(cacheDir(sys), "track");
	const checkout = join(parent, `${release}-${names.worker}`);
	const config = join(checkout, "wrangler.jsonc");
	let present = false;
	try {
		await access(config);
		present = true;
	} catch {
		// Not there yet.
	}
	if (!present) {
		if (!(await cloneRelease(sys, parent, release, checkout))) return null;
	}
	// Written again every time: a deploy cut short before it named the checkout leaves Track's own
	// database name in the file, and Wrangler would then read some other deployment's database.
	try {
		await writeFile(config, nameTrack(await readFile(config, "utf8"), names));
	} catch {
		return null;
	}
	return checkout;
}

async function cloneRelease(
	sys: System,
	parent: string,
	release: string,
	checkout: string,
): Promise<boolean> {
	await mkdir(parent, { recursive: true });
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
		{ cwd: parent, env: sys.env },
	);
	return clone.status === 0;
}

async function migrationsFinding(
	wrangler: (pins: Pins, args: string[], cwd?: string) => Promise<RunResult>,
	pins: Pins,
	checkout: string | null,
	release: string,
	recorded: boolean,
	read: DatabaseRead,
): Promise<Finding> {
	const unknown = (why: string): Finding => ({
		id: "migrations",
		status: "warn",
		message: `Whether migrations are waiting could not be told: ${why}`,
		fix: `Run npx wrangler@${pins.wrangler} d1 migrations list DB --remote in a checkout of Track ${release}, or see ${SELF_HOSTING}`,
	});
	if (!checkout) return unknown(`Track ${release} could not be fetched.`);
	if ("error" in read) return unknown(`the database could not be read (${read.error}).`);
	if (!read.row.has_migrations_table) {
		// `d1 migrations list` would create the table, which doctor must not do to a database that
		// may not even be Track's.
		return {
			id: "migrations",
			status: "warn",
			message: `The database has no migrations table, so no migration of Track ${release} has been applied through Wrangler (or it is not Track's database).`,
			fix: `Track's own deploy applies them: run \`pnpm run deploy\` in a checkout of the release, or see ${SELF_HOSTING}`,
		};
	}
	const listed = await wrangler(pins, ["d1", "migrations", "list", "DB", "--remote"], checkout);
	const output = plain(listed.stdout + listed.stderr);
	if (listed.status !== 0) return unknown(output.trim().split("\n").at(-1) ?? "Wrangler failed.");
	if (/No migrations to apply/i.test(output)) {
		return {
			id: "migrations",
			status: "ok",
			message: `Every migration of Track ${release} is applied.`,
			fix: null,
		};
	}
	if (!/Migrations to be applied/i.test(output))
		return unknown("Wrangler's answer was not understood.");
	const waiting = [...output.matchAll(/\b\d{4}_[\w-]+\.sql\b/g)].map((match) => match[0]);
	const count = waiting.length;
	// Without a record the release is the newest, which a deployment of an older one may lack.
	return {
		id: "migrations",
		status: recorded ? "fail" : "warn",
		message: `${count === 1 ? "One migration is" : `${count} migrations are`} not applied to the database yet (${waiting.join(", ")}).${recorded ? "" : ` That is measured against ${release}, the newest, and is expected if this deployment runs an older one.`}`,
		fix: `Track's own deploy applies them before new code goes live: run \`pnpm run deploy\` in a checkout of the release, or see ${SELF_HOSTING}`,
	};
}

/** The fixed query, once, for the migrations table check and the sign-up facts. */
async function readDatabase(
	wrangler: (pins: Pins, args: string[], cwd?: string) => Promise<RunResult>,
	pins: Pins,
	checkout: string | null,
): Promise<DatabaseRead> {
	if (!checkout) return { error: "the release's files could not be fetched" };
	const read = await wrangler(
		pins,
		["d1", "execute", "DB", "--remote", "--json", "--command", SIGN_UP_QUERY],
		checkout,
	);
	try {
		if (read.status !== 0) throw new Error(plain(read.stderr).trim().split("\n").at(-1));
		const row = json<{ results?: DatabaseRow[] }[]>(read.stdout)[0]?.results?.[0];
		if (!row) throw new Error("the answer had no row");
		return { row };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

/** Whether sign-up is open or by invitation, and whether any account exists yet. */
async function signUpFindings(
	sys: System,
	read: DatabaseRead,
	address: string | null,
): Promise<Finding[]> {
	const open: Finding = {
		id: "sign-up",
		status: "warn",
		message: "Sign-up is open: anyone who can reach the address can make an account.",
		fix: `To take accounts by invitation only, the owner chooses it under "This server" on their account page: ${SIGN_UP_DOCS}`,
	};
	const invitation: Finding = {
		id: "sign-up",
		status: "ok",
		message: "Sign-up is by invitation.",
		fix: null,
	};

	// The sign-in page says so while sign-up is closed: nothing more to ask then.
	if (address) {
		try {
			const page = await sys.fetch(new URL("/login", address).href);
			if (page.status === 200 && CLOSED_SIGN_UP.test(page.text)) return [invitation];
		} catch {
			// Not reachable from outside: the database is asked instead.
		}
	}

	const unknown = (why: string): Finding[] => [
		{
			id: "sign-up",
			status: "warn",
			message: `Whether sign-up is open could not be told: ${why}`,
			fix: SIGN_UP_DOCS,
		},
	];
	if ("error" in read) return unknown(`the database could not be read (${read.error}).`);
	const { row } = read;

	const findings = [row.sign_up === "open" ? open : invitation];
	if (!row.has_accounts) {
		findings.push({
			id: "first-account",
			status: "warn",
			message: "No account exists yet: whoever opens the address first owns this server.",
			fix: "Open the address now and create the first account.",
		});
	}
	return findings;
}

async function mcpFinding(
	sys: System,
	pins: Pins,
	worker: string,
	secrets: Set<string>,
	address: string | null,
): Promise<Finding> {
	const off: Finding = {
		id: "mcp",
		status: "warn",
		message: "BETTER_AUTH_URL is not set, so MCP is off.",
		fix: `npx wrangler@${pins.wrangler} secret put BETTER_AUTH_URL --name ${worker} (the address people use, such as ${address ?? "https://track.example.com"})`,
	};
	if (secrets.has("BETTER_AUTH_URL")) {
		return { id: "mcp", status: "ok", message: "BETTER_AUTH_URL is set, so MCP is on.", fix: null };
	}
	// It may be a text variable, which the secret list does not show: ask the endpoint.
	if (address && (await mcpIsOn(sys, address))) {
		return { id: "mcp", status: "ok", message: "MCP answers: BETTER_AUTH_URL is set.", fix: null };
	}
	return off;
}

/** The checks `gateweave deploy track` ends with, one finding each, tried once. */
async function outsideFindings(sys: System, address: string | null): Promise<Finding[]> {
	if (!address) {
		return [
			{
				id: "outside",
				status: "warn",
				message: "The address is unknown, so nothing was checked from outside.",
				fix: "Run again with --url https://<name>.<subdomain>.workers.dev",
			},
		];
	}
	const results = await checkFromOutside(sys, address, 0);
	return results.map((result, index) => ({
		id: `outside-${CHECK_IDS[index]}`,
		status: result.ok ? "ok" : "fail",
		message: result.ok
			? `From outside, ${result.name}.`
			: `From outside, ${result.name} failed: ${result.detail}.`,
		fix: result.ok
			? null
			: `Open ${address} and see ${SELF_HOSTING}; if the Worker was just deployed, wait a minute and run again.`,
	}));
}
