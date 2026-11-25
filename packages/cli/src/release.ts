import { parse } from "jsonc-parser";
import { CliError } from "./errors.ts";
import type { System } from "./system.ts";

export const TRACK_REPOSITORY = "https://github.com/gateweavehq/track.git";
const TRACK_RAW = "https://raw.githubusercontent.com/gateweavehq/track";

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function compareTags(a: string, b: string): number {
	const pa = RELEASE_TAG.exec(a)?.slice(1).map(Number) ?? [];
	const pb = RELEASE_TAG.exec(b)?.slice(1).map(Number) ?? [];
	for (let i = 0; i < 3; i++) {
		const difference = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The release tags of the product, newest first, read with `git ls-remote`. */
export async function releaseTags(sys: System, cwd: string): Promise<string[]> {
	const result = await sys.run("git", ["ls-remote", "--tags", "--refs", TRACK_REPOSITORY], {
		cwd,
		env: sys.env,
	});
	if (result.status !== 0) {
		throw new CliError(
			"requirement",
			"release-unreachable",
			`Could not list Track's releases from ${TRACK_REPOSITORY}: ${result.stderr.trim()}`,
		);
	}
	return result.stdout
		.split("\n")
		.map((line) => line.split("refs/tags/")[1]?.trim() ?? "")
		.filter((tag) => RELEASE_TAG.test(tag))
		.sort((a, b) => compareTags(b, a));
}

export async function chooseRelease(
	sys: System,
	cwd: string,
	wanted: string | undefined,
): Promise<string> {
	const tags = await releaseTags(sys, cwd);
	if (wanted) {
		if (!tags.includes(wanted)) {
			throw new CliError(
				"usage",
				"release-not-found",
				`Track has no release ${wanted}. The newest is ${tags[0] ?? "unknown"}.`,
			);
		}
		return wanted;
	}
	const latest = tags[0];
	if (!latest) {
		throw new CliError("requirement", "release-not-found", "Track has no release tag yet.");
	}
	return latest;
}

export interface Pins {
	/** The pnpm version from `packageManager`, such as `12.4.2`. */
	pnpm: string;
	/** The Wrangler version the release deploys with. */
	wrangler: string;
	/** The oldest Node major the release accepts. */
	nodeMajor: number;
	/** The Durable Object classes its top-level `wrangler.jsonc` binds. */
	durableObjects: string[];
	/** The secrets its `wrangler.jsonc` lists under `secrets.required`. */
	requiredSecrets: string[];
}

async function rawFile(sys: System, release: string, path: string): Promise<string> {
	const url = `${TRACK_RAW}/${release}/${path}`;
	const response = await sys.fetch(url);
	if (response.status !== 200) {
		throw new CliError(
			"requirement",
			"release-unreadable",
			`Could not read ${path} of Track ${release} (HTTP ${response.status}).`,
		);
	}
	return response.text;
}

/**
 * The versions the release itself names, so the tool runs the same pnpm and Wrangler the product
 * was tested with instead of holding versions of its own.
 */
export async function readPins(sys: System, release: string): Promise<Pins> {
	const [rootManifest, webManifest, workspace, wranglerConfig] = await Promise.all([
		rawFile(sys, release, "package.json"),
		rawFile(sys, release, "apps/web/package.json"),
		rawFile(sys, release, "pnpm-workspace.yaml"),
		rawFile(sys, release, "wrangler.jsonc"),
	]);
	const config = parse(wranglerConfig) as {
		durable_objects?: { bindings?: { class_name?: string }[] };
		secrets?: { required?: unknown };
	};
	const durableObjects = (config.durable_objects?.bindings ?? [])
		.map(({ class_name }) => class_name)
		.filter((name): name is string => typeof name === "string");
	const required = config.secrets?.required;
	const requiredSecrets = Array.isArray(required)
		? required.filter((name): name is string => typeof name === "string")
		: [];
	const root = JSON.parse(rootManifest) as {
		packageManager?: string;
		engines?: { node?: string };
	};
	const web = JSON.parse(webManifest) as { devDependencies?: Record<string, string> };

	const pnpm = /^pnpm@(\d+\.\d+\.\d+)/.exec(root.packageManager ?? "")?.[1];
	let wrangler = web.devDependencies?.wrangler;
	if (wrangler === "catalog:") {
		wrangler = /^catalog:\s*\n(?:[ \t]+.*\n)*?[ \t]+wrangler:\s*"?([\d.]+)"?/m.exec(workspace)?.[1];
	}
	const nodeMajor = Number(/>=\s*(\d+)/.exec(root.engines?.node ?? "")?.[1] ?? 22);
	if (!pnpm || !wrangler || !/^\d+\.\d+\.\d+$/.test(wrangler)) {
		throw new CliError(
			"requirement",
			"release-unreadable",
			`Track ${release} does not name an exact pnpm and Wrangler version.`,
		);
	}
	return { pnpm, wrangler, nodeMajor, durableObjects, requiredSecrets };
}
