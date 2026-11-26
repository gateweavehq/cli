import assert from "node:assert/strict";
import { test } from "node:test";
import {
	checkPackage,
	compareVersions,
	readTar,
	releaseKeys,
	sha256sums,
	tarballName,
} from "../scripts/release.mjs";

/** A ustar header for a file of this name and size, with a pax header first for a long name. */
function tar(entries: [name: string, body: string][]): Uint8Array {
	const blocks: Buffer[] = [];
	const header = (name: string, size: number, type: string) => {
		const block = Buffer.alloc(512);
		block.write(name.slice(0, 100), 0);
		block.write("0000644\0", 100);
		block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
		block.write(type, 156);
		block.write("ustar\u000000", 257);
		return block;
	};
	const pad = (body: Buffer) =>
		Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
	for (const [name, text] of entries) {
		const body = Buffer.from(text);
		if (name.length > 100) {
			const record = ` path=${name}\n`;
			const pax = Buffer.from(`${record.length + String(record.length).length}${record}`);
			blocks.push(header("PaxHeader", pax.length, "x"), pad(pax));
		}
		blocks.push(header(name, body.length, "0"), pad(body));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

const AGPL = "                    GNU AFFERO GENERAL PUBLIC LICENSE\n";

function packed(changes: Record<string, string | undefined> = {}) {
	const manifest = {
		name: "gateweave",
		version: "1.2.3",
		repository: { type: "git", url: "git+https://github.com/gateweavehq/cli.git" },
		license: "AGPL-3.0-only",
		bin: { gateweave: "dist/bin.js" },
		dependencies: { "jsonc-parser": "3.3.1" },
	};
	const files: Record<string, string | undefined> = {
		"package/package.json": JSON.stringify(manifest),
		"package/README.md": "# gateweave\n",
		"package/LICENSE": AGPL,
		"package/dist/bin.js": "#!/usr/bin/env node\nexport {};\n",
		"package/dist/main.js": "export {};\n",
		...changes,
	};
	const entries = Object.entries(files).filter((entry): entry is [string, string] => !!entry[1]);
	return readTar(tar(entries));
}

test("readTar reads the plain files of an archive, with a pax header's long name", () => {
	const long = `package/dist/${"a".repeat(120)}.js`;
	const files = readTar(
		tar([
			["package/a.txt", "hello"],
			[long, "x".repeat(700)],
		]),
	);
	assert.deepEqual([...files.keys()], ["package/a.txt", long]);
	assert.equal(files.get("package/a.txt")?.toString(), "hello");
	assert.equal(files.get(long)?.length, 700);
});

test("checkPackage passes a package that holds what it ships", () => {
	assert.deepEqual(checkPackage(packed(), "1.2.3"), []);
});

test("checkPackage finds what shouldn't be there, and what should be and isn't", () => {
	const problems = checkPackage(
		packed({
			"package/src/main.ts": "export {};\n",
			"package/dist/main.js.map": "{}",
			"package/.dev.vars": "SECRET=1\n",
			"package/LICENSE": undefined,
		}),
		"1.2.3",
	);
	assert.deepEqual(problems, [
		"package/src/main.ts shouldn't be in the package.",
		"package/dist/main.js.map shouldn't be in the package.",
		"package/.dev.vars shouldn't be in the package.",
		"The package has no LICENSE.",
		"LICENSE isn't the AGPL.",
	]);
});

test("checkPackage wants the version, a runnable command, a public package from this repository and real dependencies", () => {
	const manifest = {
		name: "gateweave",
		version: "1.2.4",
		private: true,
		license: "AGPL-3.0-only",
		bin: { gateweave: "dist/missing.js" },
		dependencies: { shared: "workspace:*", "jsonc-parser": "3.3.1" },
	};
	const problems = checkPackage(
		packed({
			"package/package.json": JSON.stringify(manifest),
			"package/dist/bin.js": "export {};\n",
		}),
		"1.2.3",
	);
	assert.deepEqual(problems, [
		"dist/bin.js doesn't start with a shebang, so it won't run as a command.",
		"package.json isn't version 1.2.3.",
		"package.json is private, so npm would refuse to publish it.",
		"package.json's repository isn't git+https://github.com/gateweavehq/cli.git.",
		"package.json's bin names dist/missing.js, which the package doesn't hold.",
		"dependencies has shared as workspace:*, which only this workspace has.",
	]);
});

test("compareVersions orders versions as semver does", () => {
	const ordered = [
		"0.1.0",
		"0.2.0-alpha",
		"0.2.0-alpha.1",
		"0.2.0-alpha.beta",
		"0.2.0-beta.2",
		"0.2.0-beta.11",
		"0.2.0-rc.1",
		"0.2.0",
		"0.10.0",
		"1.0.0",
	];
	assert.deepEqual([...ordered].reverse().sort(compareVersions), ordered);
	assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("a release lives under its version, with sums sha256sum checks", () => {
	assert.equal(tarballName("0.1.0"), "gateweave-0.1.0.tgz");
	assert.deepEqual(releaseKeys("0.1.0"), {
		tarball: "cli/0.1.0/gateweave-0.1.0.tgz",
		sums: "cli/0.1.0/SHA256SUMS",
		latest: "cli/latest.json",
	});
	assert.equal(sha256sums([["gateweave-0.1.0.tgz", "ab12"]]), "ab12  gateweave-0.1.0.tgz\n");
});
