import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src", import.meta.url));

// The product's own deploy does these; the tool holds no copy of that logic.
test("the source never deploys, migrates or makes a secret itself", () => {
	for (const file of readdirSync(src)) {
		const text = readFileSync(join(src, file), "utf8");
		for (const pattern of [
			/["'`]deploy["'`]\s*,\s*["'`]--/,
			/migrations\s+apply|["'`]migrations["'`]\s*,\s*["'`]apply/,
			/--secrets-file/,
			/randomBytes|randomUUID|getRandomValues/,
			/"secret",\s*"put"/,
		]) {
			assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
		}
	}
});
