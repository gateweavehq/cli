import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export interface RunOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	/** Copies the child's output to stderr as it comes, besides returning it. */
	stream?: boolean;
}

export interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export interface HttpRequest {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

/**
 * Everything the commands do to the world outside the process, in one place, so tests can put a
 * fake in its stead that records each call and answers with canned output.
 */
export interface System {
	/** Starts a program without a shell, its arguments as an array. */
	run(command: string, args: string[], options: RunOptions): Promise<RunResult>;
	fetch(url: string, request?: HttpRequest): Promise<HttpResponse>;
	/** The result: the only thing that goes to stdout. */
	out(text: string): void;
	/** Progress, the plan and the product's own output. */
	err(text: string): void;
	/** Whether a person can answer a question on this terminal. */
	interactive: boolean;
	confirm(question: string): Promise<boolean>;
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homedir: string;
	execPath: string;
	nodeVersion: string;
	sleep(ms: number): Promise<void>;
	now(): number;
}

export function realSystem(): System {
	return {
		run(command, args, options) {
			return new Promise((resolve) => {
				const child = spawn(command, args, {
					cwd: options.cwd,
					env: options.env ?? process.env,
					shell: false,
					// Nothing a child asks can be answered: this tool asks its one question itself.
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					stdout += chunk;
					if (options.stream) process.stderr.write(chunk);
				});
				child.stderr.on("data", (chunk: string) => {
					stderr += chunk;
					if (options.stream) process.stderr.write(chunk);
				});
				child.on("error", (error) => resolve({ status: -1, stdout, stderr: String(error) }));
				child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
			});
		},
		async fetch(url, request = {}) {
			const response = await fetch(url, {
				method: request.method ?? "GET",
				headers: request.headers,
				body: request.body,
				redirect: "manual",
				signal: AbortSignal.timeout(15_000),
			});
			return {
				status: response.status,
				headers: Object.fromEntries(response.headers),
				text: await response.text(),
			};
		},
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
		interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
		async confirm(question) {
			const rl = createInterface({ input: process.stdin, output: process.stderr });
			try {
				const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
				return /^y(es)?$/i.test(answer.trim());
			} finally {
				rl.close();
			}
		},
		env: process.env,
		platform: process.platform,
		homedir: homedir(),
		execPath: process.execPath,
		nodeVersion: process.versions.node,
		sleep: (ms) => delay(ms),
		now: () => Date.now(),
	};
}
