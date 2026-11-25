import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, describe, test } from "node:test";
import { CHECK_IDS } from "../src/checks.ts";
import { type Finding, SIGN_UP_QUERY } from "../src/doctor-track.ts";
import { main } from "../src/main.ts";
import { type FakeOptions, fakeSystem, RELEASE, readsOnly } from "./fake.ts";

const homes: string[] = [];
after(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

type Fake = ReturnType<typeof fakeSystem>;

/** Deploys on the fake first, so there is a record, as after a real `gateweave deploy track`. */
async function deployed(options: FakeOptions = {}, args: string[] = []): Promise<Fake> {
	const fake = fakeSystem(options);
	homes.push(fake.home);
	assert.equal(await main(["deploy", "track", "--yes", ...args], fake.sys), 0);
	fake.output.out = "";
	fake.output.err = "";
	fake.calls.length = 0;
	return fake;
}

async function doctor(fake: Fake, args: string[] = []) {
	fake.output.out = "";
	const code = await main(["doctor", "track", "--json", ...args], fake.sys);
	const findings = JSON.parse(fake.output.out) as Finding[];
	const by = (id: string) => findings.find((finding) => finding.id === id);
	return { code, findings, by, ...fake };
}

function fresh(options: FakeOptions = {}): Fake {
	const fake = fakeSystem(options);
	homes.push(fake.home);
	return fake;
}

const statuses = (findings: Finding[]) =>
	Object.fromEntries(findings.map(({ id, status }) => [id, status]));

const OUTSIDE_OK = Object.fromEntries(CHECK_IDS.map((id) => [`outside-${id}`, "ok"]));

describe("gateweave doctor track, on a deployment this tool made", () => {
	test("a new deployment: the release is current, sign-up open and no account are warnings", async () => {
		const { code, findings, by } = await doctor(await deployed());
		assert.equal(code, 0);
		assert.deepEqual(statuses(findings), {
			worker: "ok",
			"secret-better-auth-secret": "ok",
			release: "ok",
			migrations: "ok",
			"sign-up": "warn",
			"first-account": "warn",
			mcp: "warn",
			...OUTSIDE_OK,
		});
		assert.match(by("worker")?.message ?? "", /Rehearsal \(a1b2c3\)/);
		assert.match(by("first-account")?.message ?? "", /first owns/);
		assert.match(by("mcp")?.fix ?? "", /secret put BETTER_AUTH_URL --name gateweave-track/);
		for (const finding of findings) {
			assert.ok(finding.message.length > 0);
			assert.ok(finding.status === "ok" || finding.fix);
		}
	});

	test("a release older than the newest is a warning that names both", async () => {
		const { code, by } = await doctor(await deployed({}, ["--release", "v0.49.0"]));
		assert.equal(code, 0);
		assert.equal(by("release")?.status, "warn");
		assert.match(by("release")?.message ?? "", /v0\.49\.0 is older than v0\.50\.0/);
	});

	test("a missing required secret is a fail that names it and the fix, and exits 1", async () => {
		const fake = await deployed();
		fake.cloud.secrets.set("gateweave-track", new Set());
		const { code, by } = await doctor(fake);
		assert.equal(code, 1);
		assert.equal(by("secret-better-auth-secret")?.status, "fail");
		assert.match(by("secret-better-auth-secret")?.message ?? "", /BETTER_AUTH_SECRET is not set/);
		assert.match(
			by("secret-better-auth-secret")?.fix ?? "",
			/wrangler@4\.166\.0 secret put BETTER_AUTH_SECRET --name gateweave-track/,
		);
	});

	test("a Worker that is gone is one fail, and the rest is not tried", async () => {
		const fake = await deployed();
		fake.cloud.workers.clear();
		const { code, findings } = await doctor(fake);
		assert.equal(code, 1);
		assert.deepEqual(statuses(findings), { worker: "fail" });
		assert.match(findings[0]?.fix ?? "", /gateweave deploy track --name gateweave-track/);
	});

	test("migrations not applied yet are a fail that lists them", async () => {
		const fake = await deployed({ pending: ["0017_workspace_deletion.sql", "0018_x.sql"] });
		const { code, by } = await doctor(fake);
		assert.equal(code, 1);
		assert.equal(by("migrations")?.status, "fail");
		assert.match(
			by("migrations")?.message ?? "",
			/2 migrations.*0017_workspace_deletion\.sql, 0018_x\.sql/,
		);
	});

	test("reads the migrations in the checkout the deploy made, with the deployment's names", async () => {
		const fake = await deployed({}, ["--name", "gwcli-s2-a1b2c3"]);
		const { calls } = await doctor(fake, ["--name", "gwcli-s2-a1b2c3"]);
		const list = calls.find((call) => call.argv.includes("migrations"));
		assert.match(list?.cwd ?? "", /v0\.50\.0-gwcli-s2-a1b2c3$/);
		assert.equal(calls.filter((call) => call.argv.includes("clone")).length, 0);
	});

	test("a database deleted by hand is a fail", async () => {
		const fake = await deployed();
		fake.cloud.databases.clear();
		const { code, by } = await doctor(fake);
		assert.equal(code, 1);
		assert.equal(by("migrations")?.status, "fail");
		assert.match(by("migrations")?.message ?? "", /no D1 database named gateweave-track/);
	});

	test("takes the address from the record, and --url overrides it", async () => {
		const fake = await deployed();
		await doctor(fake);
		assert.ok(
			fake.events.some((event) =>
				event.includes("https://gateweave-track.rehearsal.workers.dev/login"),
			),
		);
		fake.events.length = 0;
		await doctor(fake, ["--url", "https://track.example.com"]);
		assert.ok(fake.events.some((event) => event.includes("https://track.example.com/login")));
		assert.ok(!fake.events.some((event) => event.includes("rehearsal.workers.dev")));
	});
});

describe("gateweave doctor track, on a deployment this tool did not make", () => {
	const existing = {
		workers: ["legacy-track"],
		databases: ["legacy-track"],
	} satisfies FakeOptions;
	const args = ["--name", "legacy-track", "--url", "https://legacy-track.someone.workers.dev"];

	test("works from --name and --url alone, and says the release cannot be known", async () => {
		const { code, findings, by, calls } = await doctor(fresh(existing), args);
		assert.equal(code, 0);
		assert.deepEqual(statuses(findings), {
			worker: "ok",
			"secret-better-auth-secret": "ok",
			release: "warn",
			migrations: "ok",
			"sign-up": "warn",
			"first-account": "warn",
			mcp: "warn",
			...OUTSIDE_OK,
		});
		assert.match(by("release")?.message ?? "", /unknown.*newest is v0\.50\.0/);
		// With no record to say where its files are, the newest release is fetched into the cache.
		const clone = calls.find((call) => call.argv.includes("clone"));
		assert.ok(clone?.argv.includes(RELEASE));
	});

	test("migrations are measured against the newest release and only warn", async () => {
		const { code, by } = await doctor(fresh({ ...existing, pending: ["0018_x.sql"] }), args);
		assert.equal(code, 0);
		assert.equal(by("migrations")?.status, "warn");
		assert.match(by("migrations")?.message ?? "", /0018_x\.sql.*older one/);
	});

	test("no D1 database of that name is a warning, not a guess", async () => {
		const { code, by } = await doctor(fresh({ workers: ["legacy-track"] }), args);
		assert.equal(code, 0);
		assert.equal(by("migrations")?.status, "warn");
		assert.equal(by("sign-up"), undefined);
	});

	test("without an address nothing is checked from outside, and it says so", async () => {
		const { code, by } = await doctor(fresh(existing), ["--name", "legacy-track"]);
		assert.equal(code, 0);
		assert.equal(by("outside")?.status, "warn");
		assert.match(by("outside")?.fix ?? "", /--url/);
	});

	test("a missing Worker is a fail", async () => {
		const { code, findings } = await doctor(fresh(), args);
		assert.equal(code, 1);
		assert.deepEqual(statuses(findings), { worker: "fail" });
	});

	test("a secret the release requires and the Worker lacks is a fail", async () => {
		const { code, by } = await doctor(
			fresh({ ...existing, secrets: { "legacy-track": [] } }),
			args,
		);
		assert.equal(code, 1);
		assert.equal(by("secret-better-auth-secret")?.status, "fail");
	});
});

describe("sign-up and MCP", () => {
	const existing = { workers: ["legacy-track"], databases: ["legacy-track"] };
	const args = ["--name", "legacy-track", "--url", "https://legacy-track.someone.workers.dev"];

	test("by invitation: the sign-in page says so, and the database is not asked", async () => {
		const { by, calls } = await doctor(
			fresh({
				...existing,
				respond: {
					"/login": {
						status: 200,
						headers: {},
						text: "<title>Gateweave Track</title><p>This server takes new accounts by invitation.</p>",
					},
				},
			}),
			args,
		);
		assert.equal(by("sign-up")?.status, "ok");
		assert.equal(by("first-account"), undefined);
		assert.equal(calls.filter((call) => call.argv.includes("execute")).length, 0);
	});

	test("by invitation, read from the database", async () => {
		const { by } = await doctor(
			fresh({ ...existing, deployment: { signUp: "closed", hasAccounts: true } }),
			args,
		);
		assert.equal(by("sign-up")?.status, "ok");
		assert.equal(by("first-account"), undefined);
	});

	test("open with accounts: sign-up is a warning and there is no first-account finding", async () => {
		const { code, by } = await doctor(
			fresh({ ...existing, deployment: { signUp: "open", hasAccounts: true } }),
			args,
		);
		assert.equal(code, 0);
		assert.equal(by("sign-up")?.status, "warn");
		assert.match(by("sign-up")?.fix ?? "", /self-hosting\.md#who-may-sign-up/);
		assert.equal(by("first-account"), undefined);
	});

	test("a closed server with no account yet is still a first-account warning", async () => {
		const { by } = await doctor(
			fresh({ ...existing, deployment: { signUp: null, hasAccounts: false } }),
			args,
		);
		assert.equal(by("sign-up")?.status, "ok");
		assert.equal(by("first-account")?.status, "warn");
	});

	test("a database that cannot be read is an unknown, not a pass", async () => {
		const { code, by } = await doctor(fresh({ ...existing, signUpQueryFails: true }), args);
		assert.equal(code, 0);
		assert.equal(by("sign-up")?.status, "warn");
		assert.match(by("sign-up")?.message ?? "", /could not be told.*no such table/);
	});

	test("BETTER_AUTH_URL among the secrets means MCP is on", async () => {
		const { by } = await doctor(
			fresh({
				...existing,
				secrets: { "legacy-track": ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL"] },
			}),
			args,
		);
		assert.equal(by("mcp")?.status, "ok");
	});

	test("BETTER_AUTH_URL as a text variable shows in the endpoint's answer", async () => {
		const { by } = await doctor(
			fresh({
				...existing,
				respond: {
					"/mcp": { status: 401, headers: { "www-authenticate": "Bearer realm=x" }, text: "" },
				},
			}),
			args,
		);
		assert.equal(by("mcp")?.status, "ok");
	});
});

describe("the checks from outside", () => {
	const existing = { workers: ["legacy-track"], databases: ["legacy-track"] };
	const args = ["--name", "legacy-track", "--url", "https://legacy-track.someone.workers.dev"];

	test("a failing check is a fail with the same words the deploy uses, and exits 1", async () => {
		const { code, by } = await doctor(
			fresh({
				...existing,
				respond: { "/api/sync/deploy-check/snapshot": { status: 200, headers: {}, text: "" } },
			}),
			args,
		);
		assert.equal(code, 1);
		assert.equal(by("outside-sync-gateway")?.status, "fail");
		assert.match(by("outside-sync-gateway")?.message ?? "", /sync gateway.*answered 200, not 401/);
	});

	test("each is tried once: doctor does not wait for an address to come up", async () => {
		const fake = fresh({ ...existing, slowStart: 100 });
		const { code, findings } = await doctor(fake, args);
		assert.equal(code, 1);
		// The MCP check accepts a 404, so the three others are the ones that fail.
		assert.deepEqual(
			findings.filter(({ id }) => id.startsWith("outside-")).map(({ status }) => status),
			["fail", "fail", "fail", "ok"],
		);
		assert.ok(!fake.events.some((event) => event.startsWith("sleep")));
	});
});

describe("what doctor never does", () => {
	test("only reading commands reach Cloudflare, on a recorded and on a foreign deployment", async () => {
		const recorded = await deployed();
		const foreign = fresh({ workers: ["legacy-track"], databases: ["legacy-track"] });
		await doctor(recorded);
		await doctor(foreign, [
			"--name",
			"legacy-track",
			"--url",
			"https://legacy-track.x.workers.dev",
		]);
		for (const { calls } of [recorded, foreign]) {
			assert.ok(calls.length > 0);
			const wrangler = calls.filter((call) => / wrangler@/.test(call.argv.join(" ")));
			assert.ok(wrangler.length > 0);
			// Every Wrangler command is one of: whoami, secret list, d1 list, d1 migrations list, and
			// the one fixed d1 execute.
			assert.deepEqual(
				wrangler.filter((call) => !readsOnly(call)),
				[],
			);
			assert.ok(
				wrangler.every((call) => call.argv.some((arg) => ["whoami", "secret", "d1"].includes(arg))),
			);
			for (const call of wrangler) {
				const text = call.argv.join(" ");
				assert.doesNotMatch(
					text,
					/secret (put|delete|bulk)|d1 (create|delete)|migrations apply|r2 |\bdeploy\b|versions|--file|--secrets-file/,
				);
				if (text.includes(" execute ")) assert.equal(call.argv.at(-1), SIGN_UP_QUERY);
			}
			// Nothing is installed or built; the only other program is git, to fetch a release.
			assert.ok(calls.every((call) => !call.argv.join(" ").includes("pnpm@")));
			const others = calls.filter((call) => !readsOnly(call) && !wrangler.includes(call));
			assert.ok(others.every((call) => call.argv[0] === "git" && call.argv.includes("clone")));
		}
	});

	test("the one query is a single fixed SELECT", () => {
		assert.match(SIGN_UP_QUERY, /^SELECT /);
		assert.doesNotMatch(
			SIGN_UP_QUERY,
			/;|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA)\b/i,
		);
	});

	test("changes no record and no file it did not need: the record is the one the deploy wrote", async () => {
		const fake = await deployed();
		const { readFileSync } = await import("node:fs");
		const { recordPath } = await import("../src/record.ts");
		const before = readFileSync(recordPath(fake.sys), "utf8");
		await doctor(fake);
		assert.equal(readFileSync(recordPath(fake.sys), "utf8"), before);
	});

	test("prints names and never a token or a value", async () => {
		const fake = await deployed({ env: { CLOUDFLARE_API_TOKEN: "cf-token-0123456789abcdef" } });
		for (const args of [[], ["--url", "https://x.example.com"]]) {
			fake.output.out = "";
			fake.output.err = "";
			await main(["doctor", "track", ...args], fake.sys);
			assert.doesNotMatch(fake.output.out + fake.output.err, /cf-token-0123456789abcdef/);
		}
	});
});

describe("usage and stops", () => {
	test("prints words for people without --json, with the fix under each finding", async () => {
		const fake = await deployed();
		const code = await main(["doctor", "track"], fake.sys);
		assert.equal(code, 0);
		assert.match(fake.output.out, /^Track in Rehearsal \(a1b2c3\):/);
		assert.match(fake.output.out, /WARN {2}Sign-up is open/);
		assert.match(fake.output.out, /Fix: /);
		assert.match(fake.output.out, /0 to fix, 3 to look at, 8 fine\./);
	});

	test("refuses the options of the other command", async () => {
		const fake = fresh();
		assert.equal(await main(["doctor", "track", "--release", "v0.49.0", "--json"], fake.sys), 2);
		assert.equal(JSON.parse(fake.output.out).code, "usage");
		const other = fresh();
		assert.equal(
			await main(["deploy", "track", "--url", "https://x.example.com", "--yes"], other.sys),
			2,
		);
		assert.equal(other.calls.length, 0);
	});

	test("refuses an address that is not one", async () => {
		const fake = fresh();
		assert.equal(
			await main(["doctor", "track", "--url", "track.example.com", "--json"], fake.sys),
			2,
		);
		assert.equal(JSON.parse(fake.output.out).code, "bad-url");
	});

	test("a sign-in that is missing stops it with exit 3, a choice of accounts with exit 4", async () => {
		const out = fresh({ signedIn: false });
		assert.equal(await main(["doctor", "track", "--json"], out.sys), 3);
		const several = fresh({
			accounts: [
				{ id: "a1", name: "One" },
				{ id: "a2", name: "Two" },
			],
		});
		assert.equal(await main(["doctor", "track", "--json"], several.sys), 4);
	});

	test("--help shows the doctor's usage", async () => {
		const fake = fresh();
		assert.equal(await main(["doctor", "track", "--help"], fake.sys), 0);
		assert.match(fake.output.err, /Usage: gateweave doctor track/);
		assert.equal(fake.calls.length, 0);
	});
});
