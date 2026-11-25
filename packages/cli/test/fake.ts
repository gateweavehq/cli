import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "jsonc-parser";
import type { HttpRequest, HttpResponse, RunOptions, RunResult, System } from "../src/system.ts";

export const RELEASE = "v0.50.0";
export const WRANGLER = "4.166.0";
export const PNPM = "12.4.2";

const WRANGLER_CONFIG = readFileSync(new URL("./fixtures/wrangler.jsonc", import.meta.url), "utf8");

const RAW: Record<string, string> = {
	"package.json": JSON.stringify({ packageManager: `pnpm@${PNPM}`, engines: { node: ">=22" } }),
	"apps/web/package.json": JSON.stringify({ devDependencies: { wrangler: "catalog:" } }),
	"pnpm-workspace.yaml": `packages:\n  - apps/*\n\ncatalog:\n  typescript: 7.0.2\n  wrangler: ${WRANGLER}\n  zod: 4.6.7\n`,
	"wrangler.jsonc": WRANGLER_CONFIG,
};

export interface Call {
	argv: string[];
	cwd: string;
	accountId: string | undefined;
}

export interface Account {
	id: string;
	name: string;
	/** What Wrangler's real record adds: settings, legacy flags, dates. None may reach the output. */
	[extra: string]: unknown;
}

export interface FakeOptions {
	accounts?: Account[];
	/** Names already in use in the account. */
	workers?: readonly string[];
	databases?: readonly string[];
	buckets?: readonly string[];
	r2?: "on" | "off";
	/** Colours Wrangler's human output, as it does when FORCE_COLOR is set. */
	color?: boolean;
	interactive?: boolean;
	answer?: boolean;
	env?: Record<string, string>;
	/** How many times the address answers 404 before it comes up. */
	slowStart?: number;
	/** Overrides the answer of a path on the deployed address. */
	respond?: Record<string, HttpResponse>;
	signedIn?: boolean;
	/** The secrets of a Worker, by name. A Worker not listed has the ones its release requires. */
	secrets?: Record<string, readonly string[]>;
	/** Migrations the database has not applied yet. */
	pending?: readonly string[];
	/** What the deployment's database holds. Default: open, with no account. */
	deployment?: { signUp: "open" | "closed" | null; hasAccounts: boolean };
	/** Makes the sign-up query fail, as on a database whose tables are missing. */
	signUpQueryFails?: boolean;
	/** Whether the database has Wrangler's migrations table. Default: it has. */
	migrationsTable?: boolean;
	/** Makes `d1 migrations list` fail. */
	migrationsListFails?: boolean;
	/** Makes `git clone` fail. */
	cloneFails?: boolean;
}

/**
 * A System that records every program it is asked to start, and answers like git, npx, pnpm and
 * Wrangler would, keeping a pretend Cloudflare account in memory.
 */
export function fakeSystem(options: FakeOptions = {}) {
	const home = mkdtempSync(join(tmpdir(), "gateweave-cli-test-"));
	const accounts = options.accounts ?? [{ id: "a1b2c3", name: "Rehearsal" }];
	const cloud = {
		workers: new Set(options.workers ?? []),
		databases: new Map((options.databases ?? []).map((name) => [name, `uuid-${name}`])),
		buckets: new Set(options.buckets ?? []),
		secrets: new Map(
			Object.entries(options.secrets ?? {}).map(([name, list]) => [name, new Set(list)]),
		),
		/** Set when a command created the migrations table, as the real `d1 migrations list` does. */
		migrationsTableCreated: false,
	};
	const secretsOf = (worker: string) =>
		cloud.secrets.get(worker) ?? new Set(["BETTER_AUTH_SECRET"]);
	const calls: Call[] = [];
	/** Calls, questions and pauses in the order they happened. */
	const events: string[] = [];
	const output = { out: "", err: "" };
	let clock = 0;
	let slowStart = options.slowStart ?? 0;

	const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
	const failed = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });

	function wrangler(args: string[], accountId: string | undefined, cwd: string): RunResult {
		const [first, second] = args;
		if (first === "whoami") {
			if (options.signedIn === false) return failed('{"loggedIn":false}');
			return ok(JSON.stringify({ loggedIn: true, authType: "OAuth Token", accounts }));
		}
		if (!accountId) return failed("More than one account available but unable to select one");
		if (first === "secret" && second === "list") {
			const name = args[args.indexOf("--name") + 1] ?? "";
			return cloud.workers.has(name)
				? ok(
						JSON.stringify(
							[...secretsOf(name)].map((secret) => ({ name: secret, type: "secret_text" })),
						),
					)
				: failed(`✘ [ERROR] Worker "${name}" not found.\n`);
		}
		if (first === "d1" && second === "list") {
			return ok(JSON.stringify([...cloud.databases].map(([name, uuid]) => ({ name, uuid }))));
		}
		if (first === "r2" && second === "bucket" && args[2] === "list") {
			if (options.r2 === "off") {
				return failed("✘ [ERROR] Please enable R2 through the Cloudflare Dashboard. [code: 10042]");
			}
			// Wrangler 4.166.0 prints each bucket through formatLabelledValues: the label in white, the
			// value in gray, aligned on the longest label.
			const white = (text: string) => (options.color ? `\u001b[37m${text}\u001b[39m` : text);
			const gray = (text: string) => (options.color ? `\u001b[90m${text}\u001b[39m` : text);
			const bucket = (name: string) =>
				`${white("name:")}           ${gray(name)}\n${white("creation_date:")}  ${gray("2026-11-01T00:00:00.000Z")}`;
			return ok(`Listing buckets...\n${[...cloud.buckets].map(bucket).join("\n\n")}\n`);
		}
		if (first === "d1" && (second === "migrations" || second === "execute")) {
			// Both read the database named in the wrangler.jsonc of the folder they run in.
			let database: string | undefined;
			try {
				const config = parse(readFileSync(join(cwd, "wrangler.jsonc"), "utf8")) as {
					d1_databases: { binding: string; database_name: string }[];
				};
				database = config.d1_databases.find(({ binding }) => binding === "DB")?.database_name;
			} catch {
				return failed("✘ [ERROR] Couldn't find a Wrangler configuration file.");
			}
			if (!database || !cloud.databases.has(database)) {
				return failed(`✘ [ERROR] Couldn't find a D1 DB with the name or binding "DB"`);
			}
			if (second === "migrations" && args[2] === "list") {
				if (options.migrationsListFails) return failed("✘ [ERROR] Something went wrong.");
				if (options.migrationsTable === false) cloud.migrationsTableCreated = true;
				const pending = options.pending ?? [];
				if (pending.length === 0)
					return ok("Resource location: remote\n✅ No migrations to apply!\n");
				const rows = pending.map((name) => `│ ${name} │`).join("\n");
				return ok(
					`Resource location: remote\nMigrations to be applied:\n┌──────┐\n│ name │\n├──────┤\n${rows}\n└──────┘\n`,
				);
			}
			if (second === "execute") {
				if (options.signUpQueryFails) return failed("✘ [ERROR] no such table: deployment");
				const state = options.deployment ?? { signUp: "open", hasAccounts: false };
				return ok(
					JSON.stringify([
						{
							results: [
								{
									sign_up: state.signUp,
									has_accounts: state.hasAccounts ? 1 : 0,
									has_migrations_table: options.migrationsTable === false ? 0 : 1,
								},
							],
							success: true,
							meta: {},
						},
					]),
				);
			}
		}
		return failed(`the fake does not know wrangler ${args.join(" ")}`);
	}

	function deploy(cwd: string): RunResult {
		const config = parse(readFileSync(join(cwd, "wrangler.jsonc"), "utf8")) as {
			name: string;
			secrets?: { required?: string[] };
			d1_databases: { database_name: string }[];
			r2_buckets?: { bucket_name: string }[];
		};
		const worker = config.name;
		const database = config.d1_databases[0]?.database_name ?? "";
		const bucket = config.r2_buckets?.[0]?.bucket_name;
		cloud.workers.add(worker);
		cloud.secrets.set(worker, new Set(config.secrets?.required ?? []));
		if (!cloud.databases.has(database)) cloud.databases.set(database, `uuid-${database}`);
		if (bucket) cloud.buckets.add(bucket);
		return ok(
			`Uploaded ${worker}\nDeployed ${worker} triggers\n  https://${worker}.rehearsal.workers.dev\n`,
		);
	}

	const sys: System = {
		async run(command: string, args: string[], runOptions: RunOptions) {
			const argv = [command, ...args];
			const accountId = runOptions.env?.CLOUDFLARE_ACCOUNT_ID;
			calls.push({ argv, cwd: runOptions.cwd, accountId });
			events.push(`run ${argv.join(" ")}`);
			if (command === "git") {
				if (args[0] === "--version") return ok("git version 2.50.0");
				if (args[0] === "ls-remote") {
					return ok(
						["v0.9.0", "v0.49.0", RELEASE, "v0.50.0-rc.1"]
							.map((tag) => `abc123\trefs/tags/${tag}`)
							.join("\n"),
					);
				}
				if (args.includes("clone")) {
					if (options.cloneFails) return failed("fatal: unable to access the repository");
					const target = args[args.length - 1] ?? "";
					mkdirSync(target, { recursive: true });
					writeFileSync(join(target, "wrangler.jsonc"), WRANGLER_CONFIG);
					return ok();
				}
			}
			if (command === sys.execPath && basename(args[0] ?? "") === "npx-cli.js") {
				const rest = args.slice(1);
				if (rest[0] === "--version") return ok("11.6.0");
				if (rest[1] === `wrangler@${WRANGLER}`)
					return wrangler(rest.slice(2), accountId, runOptions.cwd);
				if (rest[1] === `pnpm@${PNPM}`) {
					if (rest[2] === "install") return ok();
					if (rest[2] === "run" && rest[3] === "deploy") return deploy(runOptions.cwd);
				}
			}
			return failed(`the fake does not know ${argv.join(" ")}`);
		},
		async fetch(url: string, request: HttpRequest = {}) {
			const raw = /^https:\/\/raw\.githubusercontent\.com\/gateweavehq\/track\/[^/]+\/(.+)$/.exec(
				url,
			);
			if (raw) {
				const text = RAW[raw[1] ?? ""];
				return text ? { status: 200, headers: {}, text } : { status: 404, headers: {}, text: "" };
			}
			events.push(`fetch ${request.method ?? "GET"} ${url}`);
			if (slowStart > 0) {
				slowStart--;
				return { status: 404, headers: {}, text: "There is nothing here yet" };
			}
			const path = new URL(url).pathname;
			const canned = options.respond?.[path];
			if (canned) return canned;
			if (path === "/login") {
				return {
					status: 200,
					headers: {},
					text: "<html><head><title>Gateweave Track</title></head></html>",
				};
			}
			if (path === "/api/auth/sign-in/email") return { status: 401, headers: {}, text: "" };
			if (path.startsWith("/api/sync/")) return { status: 401, headers: {}, text: "" };
			if (path === "/mcp") return { status: 404, headers: {}, text: "" };
			return { status: 404, headers: {}, text: "" };
		},
		out: (text) => {
			output.out += text;
		},
		err: (text) => {
			output.err += text;
		},
		interactive: options.interactive ?? false,
		async confirm() {
			events.push("confirm");
			return options.answer ?? true;
		},
		env: {
			PATH: process.env.PATH,
			APPDATA: join(home, "config"),
			LOCALAPPDATA: join(home, "cache"),
			XDG_CONFIG_HOME: join(home, "config"),
			XDG_CACHE_HOME: join(home, "cache"),
			...options.env,
		},
		platform: process.platform,
		homedir: home,
		execPath: join(home, "node", "node"),
		nodeVersion: "24.11.0",
		async sleep(ms: number) {
			events.push(`sleep ${ms}`);
			clock += ms;
		},
		now: () => clock,
	};

	return { sys, calls, events, output, cloud, home };
}

const READ_ONLY = [
	/^git --version$/,
	/^git ls-remote /,
	/npx-cli\.js --version$/,
	/ wrangler@[\d.]+ whoami --json$/,
	/ wrangler@[\d.]+ secret list --name \S+ --format json$/,
	/ wrangler@[\d.]+ d1 list --json$/,
	/ wrangler@[\d.]+ d1 migrations list DB --remote$/,
	/ wrangler@[\d.]+ d1 execute DB --remote --json --command SELECT [^;]*$/,
	/ wrangler@[\d.]+ r2 bucket list$/,
];

/** Whether a recorded call only reads. Anything not known to read counts as a change. */
export function readsOnly(call: Call): boolean {
	const line = call.argv.join(" ");
	return READ_ONLY.some((pattern) => pattern.test(line));
}
