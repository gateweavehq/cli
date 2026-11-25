/**
 * Every way a command can stop, with the exit code an agent can act on. The README lists them;
 * keep the two in step.
 */
export const EXIT = {
	unexpected: 1,
	usage: 2,
	requirement: 3,
	account: 4,
	"r2-off": 5,
	"name-taken": 6,
	"not-confirmed": 7,
	"deploy-failed": 8,
	"checks-failed": 9,
} as const;

export type ErrorKind = keyof typeof EXIT;

/** A stop with a reason in words. `code` is stable for scripts; `reason` is for people. */
export class CliError extends Error {
	readonly kind: ErrorKind;
	readonly code: string;

	constructor(kind: ErrorKind, code: string, reason: string) {
		super(reason);
		this.kind = kind;
		this.code = code;
	}

	get exitCode(): number {
		return EXIT[this.kind];
	}
}
