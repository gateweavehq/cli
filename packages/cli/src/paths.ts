import { join } from "node:path";
import type { System } from "./system.ts";

/** Where the record of deployments lives: `%APPDATA%\gateweave` or `~/.config/gateweave`. */
export function configDir(sys: System): string {
	if (sys.platform === "win32") {
		return join(sys.env.APPDATA ?? join(sys.homedir, "AppData", "Roaming"), "gateweave");
	}
	return join(sys.env.XDG_CONFIG_HOME || join(sys.homedir, ".config"), "gateweave");
}

/** Where releases are checked out, never the working directory. */
export function cacheDir(sys: System): string {
	if (sys.platform === "win32") {
		return join(
			sys.env.LOCALAPPDATA ?? join(sys.homedir, "AppData", "Local"),
			"gateweave",
			"cache",
		);
	}
	if (sys.platform === "darwin") return join(sys.homedir, "Library", "Caches", "gateweave");
	return join(sys.env.XDG_CACHE_HOME || join(sys.homedir, ".cache"), "gateweave");
}

/**
 * npm's npx, run with this Node. Node will not start the `.cmd` shims on Windows without a shell,
 * so the products' own scripts start JavaScript entry points this way too.
 */
export function npxCli(sys: System): string {
	const nodeDir = join(sys.execPath, "..");
	return sys.platform === "win32"
		? join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js")
		: join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js");
}
