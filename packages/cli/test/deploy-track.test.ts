import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { parse } from "jsonc-parser";
import { CHECK_NAMES } from "../src/checks.ts";
import { main } from "../src/main.ts";
import { cacheDir } from "../src/paths.ts";
import { RECORD_FIELDS, recordPath } from "../src/record.ts";
import { type Call, type FakeOptions, fakeSystem, PNPM, RELEASE, readsOnly } from "./fake.ts";

const homes: string[] = [];
after(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

async function deploy(args: string[], options: FakeOptions = {}, fake = fakeSystem(options)) {
	homes.push(fake.home);
	const code = await main(["deploy", "track", ...args], fake.sys);
	const result = args.includes("--json") ? JSON.parse(fake.output.out) : undefined;
	return { code, result, ...fake };
}

const line = (call: Call) => call.argv.slice(1).join(" ");

describe("gateweave deploy track", () => {
	test("deploys into an empty account through Track's own deploy and says what it made", async () => {
		const { code, result, calls, cloud } = await deploy([
			"--name",
			"gwcli-s1-a1b2c3",
			"--yes",
			"--json",
		]);
		assert.equal(code, 0);
		assert.deepEqual(result, {
			ok: true,
			product: "track",
			release: RELEASE,
			account: { id: "a1b2c3", name: "Rehearsal" },
			address: "https://gwcli-s1-a1b2c3.rehearsal.workers.dev",
			worker: "gwcli-s1-a1b2c3",
			database: { name: "gwcli-s1-a1b2c3", id: "uuid-gwcli-s1-a1b2c3" },
			bucket: "gwcli-s1-a1b2c3-files",
			durableObjects: ["WorkspaceDO", "RateLimiter"],
			secrets: [{ name: "BETTER_AUTH_SECRET", set: true, shown: false }],
			deployedNow: true,
			checks: CHECK_NAMES.map((name) => ({ name, ok: true, detail: "passed" })),
			next: result.next,
		});
		assert.match(result.next, /first account/);
		assert.match(result.next, /BETTER_AUTH_URL/);
		assert.deepEqual([...cloud.workers], ["gwcli-s1-a1b2c3"]);

		// Every Cloudflare call is made in the account shown, after the account was known.
		const cloudflare = calls.filter((call) =>
			/wrangler@\S+ (?!whoami)|pnpm@\S+ run deploy/.test(line(call)),
		);
		assert.ok(cloudflare.length > 0);
		assert.ok(cloudflare.every((call) => call.accountId === "a1b2c3"));
	});

	test("the only deploy step is Track's `pnpm run deploy`", async () => {
		const { calls, sys } = await deploy(["--yes", "--json"]);
		const changes = calls.filter((call) => !readsOnly(call));
		assert.deepEqual(
			changes.map((call) =>
				call.argv
					.slice(call.argv[0] === "git" ? 1 : 2)
					.join(" ")
					.replace(join(cacheDir(sys), "track", `${RELEASE}-gateweave-track`), "<cache>"),
			),
			[
				`-c advice.detachedHead=false clone --depth 1 --branch ${RELEASE} https://github.com/gateweavehq/track.git <cache>`,
				`--yes pnpm@${PNPM} install --frozen-lockfile`,
				`--yes pnpm@${PNPM} run deploy`,
			],
		);
		for (const call of calls) {
			const text = line(call);
			assert.doesNotMatch(
				text,
				/wrangler@\S+ (deploy|versions|d1 (create|migrations)|r2 bucket create|secret (put|bulk))/,
			);
			assert.doesNotMatch(text, /--secrets-file/);
		}
	});

	test("writes only the chosen names into the release's wrangler.jsonc", async () => {
		const fake = fakeSystem();
		await deploy(["--name", "gwcli-s1-000001", "--yes"], {}, fake);
		const clone = fake.calls.find((call) => call.argv.includes("clone"));
		const checkout = clone?.argv.at(-1) ?? "";
		const config = parse(readFileSync(join(checkout, "wrangler.jsonc"), "utf8"));
		assert.equal(config.name, "gwcli-s1-000001");
		assert.equal(config.d1_databases[0].database_name, "gwcli-s1-000001");
		assert.equal(config.r2_buckets[0].bucket_name, "gwcli-s1-000001-files");
		assert.equal(config.env.cloud.name, "gateweave-track");
		assert.equal(checkout, join(cacheDir(fake.sys), "track", `${RELEASE}-gwcli-s1-000001`));
		assert.ok(checkout.startsWith(fake.home));
	});

	for (const [what, taken] of [
		["a Worker", { workers: ["gwcli-s1-taken1"] }],
		["a D1 database", { databases: ["gwcli-s1-taken1"] }],
		["an R2 bucket", { buckets: ["gwcli-s1-taken1-files"] }],
	] as const) {
		test(`refuses a name when ${what} of that name exists, before changing anything`, async () => {
			const { code, result, calls, events } = await deploy(
				["--name", "gwcli-s1-taken1", "--yes", "--json"],
				taken,
			);
			assert.equal(code, 6);
			assert.equal(result.ok, false);
			assert.equal(result.code, "name-taken");
			assert.match(result.reason, /gwcli-s1-taken1/);
			assert.ok(calls.length > 0);
			assert.deepEqual(
				calls.filter((call) => !readsOnly(call)),
				[],
			);
			assert.ok(!events.includes("confirm"));
		});
	}

	test("without a terminal and without --yes it stops at once, having changed nothing", async () => {
		const { code, result, calls, events } = await deploy(["--json"], { interactive: false });
		assert.equal(code, 7);
		assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: "no-terminal" });
		assert.deepEqual(
			calls.filter((call) => !readsOnly(call)),
			[],
		);
		assert.ok(!events.includes("confirm"));
		assert.ok(!events.some((event) => event.startsWith("sleep")));
	});

	test("asks before changing anything, and nothing changes before the yes", async () => {
		const { code, events, calls } = await deploy([], { interactive: true, answer: true });
		assert.equal(code, 0);
		const yes = events.indexOf("confirm");
		assert.ok(yes > 0);
		const callsBefore = events.slice(0, yes).filter((event) => event.startsWith("run ")).length;
		assert.ok(callsBefore > 0);
		for (const call of calls.slice(0, callsBefore)) assert.ok(readsOnly(call), line(call));
		assert.ok(
			!readsOnly(calls[callsBefore] as Call),
			"the first call after the yes changes something",
		);
	});

	test("a no changes nothing", async () => {
		const { code, calls, output } = await deploy([], { interactive: true, answer: false });
		assert.equal(code, 7);
		assert.deepEqual(
			calls.filter((call) => !readsOnly(call)),
			[],
		);
		assert.match(output.err, /Nothing was created/);
	});

	test("the plan names the account, the release and every resource before the question", async () => {
		const { output } = await deploy(["--name", "gwcli-s1-abcdef"], {
			interactive: true,
			answer: false,
		});
		for (const text of [
			"Rehearsal (a1b2c3)",
			RELEASE,
			"gwcli-s1-abcdef",
			"gwcli-s1-abcdef-files",
			"WorkspaceDO, RateLimiter",
			"BETTER_AUTH_SECRET",
		]) {
			assert.ok(output.err.includes(text), text);
		}
	});

	test("with several accounts and none chosen it stops and lists them", async () => {
		const accounts = [
			{ id: "1111", name: "First" },
			{ id: "2222", name: "Second" },
		];
		const { code, result, calls } = await deploy(["--yes", "--json"], { accounts });
		assert.equal(code, 4);
		assert.equal(result.code, "account-ambiguous");
		assert.match(result.reason, /First\s+1111/);
		assert.match(result.reason, /Second\s+2222/);
		assert.deepEqual(
			calls.filter((call) => !readsOnly(call)),
			[],
		);

		const chosen = await deploy(["--yes", "--json", "--account", "2222"], { accounts });
		assert.equal(chosen.code, 0);
		assert.deepEqual(chosen.result.account, { id: "2222", name: "Second" });
	});

	test("prints the account's id and name and nothing else of Wrangler's record", async () => {
		const raw = {
			id: "a1b2c3",
			name: "owner@example.invalid's Account",
			created_on: "2020-01-01T00:00:00Z",
			type: "standard",
			legacy_flags: { enterprise: false },
			settings: { abuse_contact_email: "owner@example.invalid", enforce_twofactor: false },
		};
		const { code, result } = await deploy(["--yes", "--json"], { accounts: [raw] });
		assert.equal(code, 0);
		assert.deepEqual(result.account, { id: "a1b2c3", name: raw.name });
		assert.doesNotMatch(JSON.stringify(result), /abuse_contact_email|legacy_flags|created_on/);
	});

	test("takes the account from CLOUDFLARE_ACCOUNT_ID", async () => {
		const accounts = [
			{ id: "1111", name: "First" },
			{ id: "2222", name: "Second" },
		];
		const { code, result } = await deploy(["--yes", "--json"], {
			accounts,
			env: { CLOUDFLARE_ACCOUNT_ID: "1111" },
		});
		assert.equal(code, 0);
		assert.equal(result.account.name, "First");
	});

	test("says how to sign in when Wrangler is signed out", async () => {
		const { code, result } = await deploy(["--yes", "--json"], { signedIn: false });
		assert.equal(code, 3);
		assert.equal(result.code, "not-signed-in");
		assert.match(result.reason, /wrangler@4\.166\.0 login/);
	});

	test("with R2 off it stops with both ways out", async () => {
		const { code, result, calls } = await deploy(["--yes", "--json"], { r2: "off" });
		assert.equal(code, 5);
		assert.equal(result.code, "r2-off");
		assert.match(result.reason, /turn it on/);
		assert.match(result.reason, /--no-attachments/);
		assert.deepEqual(
			calls.filter((call) => !readsOnly(call)),
			[],
		);
	});

	test("--no-attachments deploys without the bucket", async () => {
		const fake = fakeSystem({ r2: "off" });
		const { code, result, calls } = await deploy(["--no-attachments", "--yes", "--json"], {}, fake);
		assert.equal(code, 0);
		assert.equal(result.bucket, null);
		assert.ok(!calls.some((call) => line(call).includes("r2 bucket")));
		const checkout = calls.find((call) => call.argv.includes("clone"))?.argv.at(-1) ?? "";
		const config = parse(readFileSync(join(checkout, "wrangler.jsonc"), "utf8"));
		assert.equal(config.r2_buckets, undefined);
		assert.equal(config.env.cloud.r2_buckets.length, 1);
	});

	test("leaves the working folder empty", async () => {
		const empty = mkdtempSync(join(tmpdir(), "gateweave-cli-cwd-"));
		const previous = process.cwd();
		process.chdir(empty);
		try {
			const { code, calls } = await deploy(["--yes", "--json"]);
			assert.equal(code, 0);
			assert.ok(calls.every((call) => call.cwd !== empty));
		} finally {
			process.chdir(previous);
		}
		assert.deepEqual(readdirSync(empty), []);
		rmSync(empty, { recursive: true });
	});

	test("keeps a record with names and ids only", async () => {
		const { sys, home } = await deploy(["--name", "gwcli-s1-c0ffee", "--yes"]);
		const path = recordPath(sys);
		assert.ok(path.startsWith(join(home, "config", "gateweave")));
		const text = readFileSync(path, "utf8");
		const [record] = JSON.parse(text).deployments;
		assert.deepEqual(Object.keys(record), RECORD_FIELDS);
		assert.ok(!RECORD_FIELDS.some((field) => /secret|token|password|key/i.test(field)));
		assert.deepEqual(record.steps, ["fetched", "deployed", "checked"]);
		assert.equal(record.databaseId, "uuid-gwcli-s1-c0ffee");
		assert.equal(record.address, "https://gwcli-s1-c0ffee.rehearsal.workers.dev");
	});

	test("a second run recognises its own deployment and creates nothing", async () => {
		const fake = fakeSystem();
		const first = await deploy(["--name", "gwcli-s1-d00d00", "--yes", "--json"], {}, fake);
		assert.equal(first.code, 0);
		fake.calls.length = 0;
		fake.output.out = "";
		const second = await deploy(["--name", "gwcli-s1-d00d00", "--yes", "--json"], {}, fake);
		assert.equal(second.code, 0);
		assert.equal(second.result.deployedNow, false);
		assert.equal(second.result.database.id, "uuid-gwcli-s1-d00d00");
		assert.deepEqual(
			fake.calls.filter((call) => !readsOnly(call)),
			[],
		);
	});

	test("a second run after a deploy cut short finishes it", async () => {
		const fake = fakeSystem();
		const run = fake.sys.run;
		let cut = true;
		fake.sys.run = async (command, args, options) => {
			const result = await run(command, args, options);
			if (cut && args.includes("deploy") && args.includes("run")) {
				cut = false;
				return { ...result, status: 1 };
			}
			return result;
		};
		const first = await deploy(["--name", "gwcli-s1-0ff0ff", "--yes", "--json"], {}, fake);
		assert.equal(first.code, 8);
		// The database the failed deploy made is recorded by id, so the next run can tell it apart.
		const [record] = JSON.parse(readFileSync(recordPath(fake.sys), "utf8")).deployments;
		assert.equal(record.databaseId, "uuid-gwcli-s1-0ff0ff");
		fake.output.out = "";
		// The fake made the Worker before failing, as a deploy cut short after the upload would.
		const second = await deploy(["--name", "gwcli-s1-0ff0ff", "--yes", "--json"], {}, fake);
		assert.equal(second.code, 0);
		assert.equal(second.result.deployedNow, true);
	});

	for (const [what, take] of [
		[
			"Worker",
			(fake: ReturnType<typeof fakeSystem>, name: string) => {
				fake.cloud.workers.add(name);
			},
		],
		[
			"D1 database",
			(fake: ReturnType<typeof fakeSystem>, name: string) => {
				fake.cloud.databases.set(name, "someone-elses-uuid");
			},
		],
		[
			"R2 bucket",
			(fake: ReturnType<typeof fakeSystem>, name: string) => {
				fake.cloud.buckets.add(`${name}-files`);
			},
		],
	] as const) {
		test(`a record saved before creation does not claim someone else's ${what}`, async () => {
			const failing = { cloneFails: true };
			const fake = fakeSystem(failing);
			const name = "gwcli-s1-accede";
			const first = await deploy(["--name", name, "--yes", "--json"], {}, fake);
			assert.equal(first.code, 8);
			const [record] = JSON.parse(readFileSync(recordPath(fake.sys), "utf8")).deployments;
			assert.deepEqual(record.steps, []);
			take(fake, name);
			failing.cloneFails = false;
			fake.calls.length = 0;
			fake.output.out = "";
			const second = await deploy(["--name", name, "--yes", "--json"], {}, fake);
			assert.equal(second.code, 6);
			assert.equal(second.result.code, "name-taken");
			assert.deepEqual(
				fake.calls.filter((call) => !readsOnly(call)),
				[],
			);
		});
	}

	test("a taken name with a record for another name is still refused", async () => {
		const fake = fakeSystem();
		await deploy(["--name", "gwcli-s1-111111", "--yes"], {}, fake);
		fake.cloud.databases.set("gwcli-s1-222222", "someone-elses");
		fake.calls.length = 0;
		fake.output.out = "";
		const { code } = await deploy(["--name", "gwcli-s1-222222", "--yes", "--json"], {}, fake);
		assert.equal(code, 6);
		assert.deepEqual(
			fake.calls.filter((call) => !readsOnly(call)),
			[],
		);
	});

	/** A first run, then everything it made removed by hand, as there is no remove command. */
	async function deployedThenRemoved(name: string) {
		const fake = fakeSystem();
		const first = await deploy(["--name", name, "--yes"], {}, fake);
		assert.equal(first.code, 0);
		fake.cloud.workers.delete(name);
		fake.cloud.databases.delete(name);
		fake.cloud.buckets.delete(`${name}-files`);
		fake.calls.length = 0;
		fake.output.out = "";
		return fake;
	}

	for (const [what, take] of [
		[
			"D1 database",
			(fake: ReturnType<typeof fakeSystem>, name: string) => {
				fake.cloud.databases.set(name, "someone-elses-uuid");
			},
		],
		[
			"R2 bucket",
			(fake: ReturnType<typeof fakeSystem>, name: string) => {
				fake.cloud.buckets.add(`${name}-files`);
			},
		],
	] as const) {
		test(`after a removal by hand, a record does not claim someone else's ${what} of the same name`, async () => {
			const fake = await deployedThenRemoved("gwcli-s1-5ca1e0");
			take(fake, "gwcli-s1-5ca1e0");
			const { code, result } = await deploy(
				["--name", "gwcli-s1-5ca1e0", "--yes", "--json"],
				{},
				fake,
			);
			assert.equal(code, 6);
			assert.equal(result.code, "name-taken");
			assert.match(result.reason, new RegExp(`the ${what}`));
			assert.deepEqual(
				fake.calls.filter((call) => !readsOnly(call)),
				[],
			);
		});
	}

	test("after a removal by hand with the names still free, it deploys afresh", async () => {
		const fake = await deployedThenRemoved("gwcli-s1-f4e5h0");
		const { code, result } = await deploy(
			["--name", "gwcli-s1-f4e5h0", "--yes", "--json"],
			{},
			fake,
		);
		assert.equal(code, 0);
		assert.equal(result.deployedNow, true);
		assert.match(fake.output.err, /no longer exists; the record is ignored/);
	});

	test("a D1 database with the recorded name but another id is not claimed", async () => {
		const fake = fakeSystem();
		await deploy(["--name", "gwcli-s1-1d1d1d", "--yes"], {}, fake);
		// The Worker stays; the database was deleted and someone else made one of the same name.
		fake.cloud.databases.set("gwcli-s1-1d1d1d", "someone-elses-uuid");
		fake.calls.length = 0;
		fake.output.out = "";
		const { code, result } = await deploy(
			["--name", "gwcli-s1-1d1d1d", "--yes", "--json"],
			{},
			fake,
		);
		assert.equal(code, 6);
		assert.match(result.reason, /the D1 database gwcli-s1-1d1d1d/);
		assert.deepEqual(
			fake.calls.filter((call) => !readsOnly(call)),
			[],
		);
	});

	test("refuses a taken R2 bucket when Wrangler colours its output", async () => {
		const { code, result, calls } = await deploy(["--name", "gwcli-s1-c010e0", "--yes", "--json"], {
			buckets: ["gwcli-s1-c010e0-files"],
			color: true,
		});
		assert.equal(code, 6);
		assert.match(result.reason, /the R2 bucket gwcli-s1-c010e0-files/);
		assert.deepEqual(
			calls.filter((call) => !readsOnly(call)),
			[],
		);
	});

	test("waits for a new address to come up", async () => {
		const { code, events } = await deploy(["--yes", "--json"], { slowStart: 3 });
		assert.equal(code, 0);
		assert.equal(events.filter((event) => event.startsWith("sleep")).length, 3);
	});

	test("reports a failed check by name after two minutes", async () => {
		const { code, result } = await deploy(["--yes", "--json"], {
			respond: { "/api/sync/deploy-check/snapshot": { status: 200, headers: {}, text: "{}" } },
		});
		assert.equal(code, 9);
		assert.equal(result.code, "checks-failed");
		assert.match(
			result.reason,
			/the sync gateway turns away a request without a session \(answered 200/,
		);
	});

	test("rejects a name that cannot name a Worker and a bucket", async () => {
		const { code, result, calls } = await deploy(["--name", "Not_A_Name", "--json"]);
		assert.equal(code, 2);
		assert.equal(result.code, "bad-name");
		assert.deepEqual(calls, []);
	});

	test("rejects an unknown release", async () => {
		const { code, result } = await deploy(["--release", "v9.9.9", "--yes", "--json"]);
		assert.equal(code, 2);
		assert.equal(result.code, "release-not-found");
	});

	test("prints nothing on stdout but the result", async () => {
		const fake = fakeSystem();
		await deploy(["--yes"], {}, fake);
		assert.match(fake.output.out, /^Track v0\.50\.0 is deployed in Rehearsal\./);
		assert.ok(!fake.output.out.includes("Fetching"));
		assert.ok(existsSync(recordPath(fake.sys)));
	});
});
