import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./paths.ts";
import type { System } from "./system.ts";

export const STEPS = ["fetched", "deployed", "checked"] as const;
export type Step = (typeof STEPS)[number];

/**
 * What this tool made, so a second run can tell its own resources from someone else's and finish
 * what is left. It holds names and ids only: there is no field for a secret, and none may be added.
 */
export interface DeploymentRecord {
	product: "track";
	accountId: string;
	accountName: string;
	release: string;
	worker: string;
	/** True once the Worker was seen after the plan showed its name free. */
	workerCreated: boolean;
	database: string;
	databaseId: string | null;
	bucket: string | null;
	/** True once the bucket was seen after the plan showed its name free. */
	bucketCreated: boolean;
	address: string | null;
	steps: Step[];
	updatedAt: string;
}

export const RECORD_FIELDS: readonly (keyof DeploymentRecord)[] = [
	"product",
	"accountId",
	"accountName",
	"release",
	"worker",
	"workerCreated",
	"database",
	"databaseId",
	"bucket",
	"bucketCreated",
	"address",
	"steps",
	"updatedAt",
];

interface RecordFile {
	version: 1;
	deployments: DeploymentRecord[];
}

export function recordPath(sys: System): string {
	return join(configDir(sys), "deployments.json");
}

async function readAll(sys: System): Promise<RecordFile> {
	try {
		const file = JSON.parse(await readFile(recordPath(sys), "utf8")) as RecordFile;
		return { version: 1, deployments: Array.isArray(file.deployments) ? file.deployments : [] };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, deployments: [] };
		throw error;
	}
}

export async function findRecord(
	sys: System,
	accountId: string,
	worker: string,
): Promise<DeploymentRecord | undefined> {
	const { deployments } = await readAll(sys);
	return deployments.find(
		(record) =>
			record.product === "track" && record.accountId === accountId && record.worker === worker,
	);
}

/** Saves a record, keeping only the known fields, so nothing else can slip into the file. */
export async function saveRecord(sys: System, record: DeploymentRecord): Promise<void> {
	const file = await readAll(sys);
	const clean = Object.fromEntries(
		RECORD_FIELDS.map((field) => [field, record[field]]),
	) as unknown as DeploymentRecord;
	const others = file.deployments.filter(
		(other) =>
			!(
				other.product === clean.product &&
				other.accountId === clean.accountId &&
				other.worker === clean.worker
			),
	);
	const path = recordPath(sys);
	await mkdir(configDir(sys), { recursive: true });
	// Written beside and moved into place, so an interrupted write never leaves half a record.
	await writeFile(
		`${path}.tmp`,
		`${JSON.stringify({ version: 1, deployments: [...others, clean] }, null, "\t")}\n`,
	);
	await rename(`${path}.tmp`, path);
}
