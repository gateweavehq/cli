import type { HttpResponse, System } from "./system.ts";

export interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

interface Check {
	name: string;
	request(address: string): {
		path: string;
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	};
	/** Null when it passed, else what was wrong. */
	judge(response: HttpResponse): string | null;
}

/**
 * The checks in Track's smoke tests (apps/web/smoke/deployment.spec.ts) that need no browser, made
 * with plain HTTP. They sign in to nothing and change nothing.
 */
const CHECKS: Check[] = [
	{
		name: "the sign-in page answers and is Track's",
		request: () => ({ path: "/login" }),
		judge: ({ status, text }) => {
			if (status !== 200) return `answered ${status}`;
			return /<title>[^<]*Gateweave Track[^<]*<\/title>/.test(text)
				? null
				: "answered 200, but not with Track's sign-in page";
		},
	},
	{
		name: "accounts are looked up",
		request: (address) => ({
			path: "/api/auth/sign-in/email",
			method: "POST",
			headers: { origin: new URL(address).origin, "content-type": "application/json" },
			body: JSON.stringify({
				email: "deploy-check@example.invalid",
				password: "not-a-real-password",
			}),
		}),
		judge: ({ status }) =>
			status === 401 || status === 403 ? null : `answered ${status}, not 401 or 403`,
	},
	{
		name: "the sync gateway turns away a request without a session",
		request: () => ({ path: "/api/sync/deploy-check/snapshot" }),
		judge: ({ status }) => (status === 401 ? null : `answered ${status}, not 401`),
	},
	{
		name: "the MCP endpoint turns away a request without a token",
		request: () => ({
			path: "/mcp",
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		}),
		// MCP is only there once BETTER_AUTH_URL pins the address; until then it is not found.
		judge: ({ status, headers }) => {
			if (status === 404) return null;
			if (status === 401 && /^Bearer /.test(headers["www-authenticate"] ?? "")) return null;
			return `answered ${status}, not 401 with a Bearer challenge or 404`;
		},
	},
];

export const CHECK_NAMES = CHECKS.map(({ name }) => name);

/**
 * Runs every check against the address, retrying each for up to `withinMs` while a new
 * `workers.dev` address comes up.
 */
export async function checkFromOutside(
	sys: System,
	address: string,
	withinMs = 120_000,
): Promise<CheckResult[]> {
	const deadline = sys.now() + withinMs;
	const results: CheckResult[] = [];
	for (const check of CHECKS) {
		const { path, ...request } = check.request(address);
		let problem = "not tried";
		for (;;) {
			try {
				problem = check.judge(await sys.fetch(new URL(path, address).href, request)) ?? "";
			} catch (error) {
				problem = `no answer (${(error as Error).message})`;
			}
			if (problem === "" || sys.now() >= deadline) break;
			await sys.sleep(5_000);
		}
		results.push({ name: check.name, ok: problem === "", detail: problem || "passed" });
	}
	return results;
}
