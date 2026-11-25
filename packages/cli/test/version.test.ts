import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { main } from "../src/main.ts";
import { fakeSystem } from "./fake.ts";

test("--version prints the version in package.json and nothing else", async () => {
	const { sys, output, home } = fakeSystem();
	try {
		const code = await main(["--version"], sys);
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.equal(code, 0);
		assert.equal(output.out, `${manifest.version}\n`);
		assert.equal(output.err, "");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
