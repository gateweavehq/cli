import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { nameTrack } from "../src/wrangler-config.ts";

const source = readFileSync(new URL("./fixtures/wrangler.jsonc", import.meta.url), "utf8");

test("changes the three top-level names and keeps everything else", () => {
	const text = nameTrack(source, { worker: "w", database: "d", bucket: "b" });
	const config = parse(text);
	assert.equal(config.name, "w");
	assert.equal(config.d1_databases[0].database_name, "d");
	assert.equal(config.d1_databases[0].migrations_dir, "apps/web/migrations");
	assert.equal(config.r2_buckets[0].bucket_name, "b");
	assert.deepEqual(config.env, parse(source).env);
	assert.match(text, /\/\/ Workspace directory and auth\./);
	// Only the three values differ, line for line.
	const before = source.split("\n");
	const changed = text.split("\n").filter((line, i) => line !== before[i]);
	assert.equal(changed.length, 3);
});

test("removes r2_buckets at the top level only, to run without attachments", () => {
	const text = nameTrack(source, { worker: "w", database: "d", bucket: null });
	const config = parse(text);
	assert.equal(config.r2_buckets, undefined);
	// The binding's lines go, with the comment above them; no other line is touched.
	const kept = new Set(source.split("\n"));
	const lines = text.split("\n");
	assert.equal(source.split("\n").length - lines.length, 2);
	assert.equal(lines.filter((line) => !kept.has(line)).length, 2);
	assert.equal(config.env.cloud.r2_buckets[0].bucket_name, "gateweave-track-files-eu");
	assert.deepEqual(config.durable_objects, parse(source).durable_objects);
});
