import { applyEdits, type JSONPath, modify, parse } from "jsonc-parser";

export interface TrackNames {
	worker: string;
	database: string;
	/** Null runs Track without attachments. */
	bucket: string | null;
}

interface TopLevel {
	name?: unknown;
	d1_databases?: { binding?: string }[];
	r2_buckets?: { binding?: string }[];
}

// Without formatting options an edit touches only the value it changes (or the lines it removes),
// so the rest of the product's file stays byte for byte.
const edit = (text: string, path: JSONPath, value: string | undefined) =>
	applyEdits(text, modify(text, path, value, {}));

/**
 * Writes the chosen names into the top level of the release's `wrangler.jsonc`, the three edits
 * Track's self-hosting guide names, and removes the `r2_buckets` lines to run without attachments.
 * Comments and every environment below stay as they are.
 */
export function nameTrack(source: string, names: TrackNames): string {
	const config = parse(source) as TopLevel;
	const database = config.d1_databases?.findIndex(({ binding }) => binding === "DB") ?? -1;
	if (typeof config.name !== "string" || database < 0) {
		throw new Error('wrangler.jsonc has no top-level "name" or D1 database bound as "DB"');
	}
	let text = edit(source, ["name"], names.worker);
	text = edit(text, ["d1_databases", database, "database_name"], names.database);
	if (names.bucket === null) return edit(text, ["r2_buckets"], undefined);
	const bucket = config.r2_buckets?.findIndex(({ binding }) => binding === "FILES") ?? -1;
	if (bucket < 0) throw new Error('wrangler.jsonc has no R2 bucket bound as "FILES"');
	return edit(text, ["r2_buckets", bucket, "bucket_name"], names.bucket);
}
