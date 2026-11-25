import { readFileSync } from "node:fs";

/**
 * The version in package.json, which sits one folder above both src/ and the built dist/. It is
 * read, not written a second time, so a release cannot say one version and print another.
 */
export function version(): string {
	const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
	return String((JSON.parse(raw) as { version: unknown }).version);
}
