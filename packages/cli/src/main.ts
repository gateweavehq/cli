import { parseArgs } from "node:util";
import { type DeployTrackResult, deployTrack } from "./deploy-track.ts";
import { type DoctorTrackResult, doctorTrack } from "./doctor-track.ts";
import { CliError } from "./errors.ts";
import type { System } from "./system.ts";
import { version } from "./version.ts";

const USAGE = `Usage: gateweave deploy track [options]

Deploys Gateweave Track into your own Cloudflare account from a release, checks it from outside
and says what it created. It shows the account and everything it will create, and waits for a yes.

Options:
  --name <name>       Names the Worker, the D1 database and the R2 bucket (<name>-files).
                      Default: gateweave-track
  --release <vX.Y.Z>  A release of Track. Default: the newest.
  --account <id>      The Cloudflare account, when the sign-in reaches several.
                      Default: CLOUDFLARE_ACCOUNT_ID.
  --no-attachments    Deploy without the R2 bucket: attached files are off.
  --yes               Create without asking. Needed when there is no terminal.
  --json              Print the result, or the failure, as one JSON object on stdout.
  --help              Show this.
  --version           Print the version.
`;

const DOCTOR_USAGE = `Usage: gateweave doctor track [options]

Says what is wrong with a Track deployment, in words. It reads and changes nothing in your
Cloudflare account, and never shows a secret's value.

It works from the record \`gateweave deploy track\` keeps or, for a deployment made another way (the
Deploy button, a clone), from --name and --url.

Options:
  --name <name>       The Worker, and the D1 database of the same name. Default: gateweave-track
  --url <address>     The address to check from outside. Default: the record's.
  --account <id>      The Cloudflare account, when the sign-in reaches several.
                      Default: CLOUDFLARE_ACCOUNT_ID.
  --json              Print the findings as a JSON array on stdout.
  --help              Show this.

Each finding is ok, warn or fail. The exit code is 1 when there is a fail, else 0.
`;

// Worker and bucket names allow lowercase letters, digits and dashes; the bucket adds "-files"
// and must stay within 63 characters.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,55}[a-z0-9])?$/;

function describe(result: DeployTrackResult): string {
	const lines = [
		`Track ${result.release} is ${result.deployedNow ? "deployed" : "already deployed"} in ${result.account.name}.`,
		"",
		`  Address              ${result.address}`,
		`  Worker               ${result.worker}`,
		`  D1 database          ${result.database.name}  (${result.database.id ?? "id unknown"})`,
		`  R2 bucket            ${result.bucket ?? "none: attachments off"}`,
		`  Durable Objects      ${result.durableObjects.join(", ")}`,
		"  Secret               BETTER_AUTH_SECRET is set; its value is never shown.",
		"",
		...result.checks.map((check) => `  ok  ${check.name}`),
		"",
		`Next: ${result.next}`,
	];
	return `${lines.join("\n")}\n`;
}

const MARK = { ok: "ok  ", warn: "WARN", fail: "FAIL" } as const;

function describeDoctor(result: DoctorTrackResult): string {
	const lines = [`Track in ${result.account.name} (${result.account.id}):`, ""];
	for (const { status, message, fix } of result.findings) {
		lines.push(`  ${MARK[status]}  ${message}`);
		if (fix) lines.push(`        Fix: ${fix}`);
	}
	const count = (status: string) =>
		result.findings.filter((found) => found.status === status).length;
	lines.push("", `${count("fail")} to fix, ${count("warn")} to look at, ${count("ok")} fine.`);
	return `${lines.join("\n")}\n`;
}

/** Runs the command line and returns its exit code. */
export async function main(argv: string[], sys: System): Promise<number> {
	let json = argv.includes("--json");
	const fail = (error: CliError): number => {
		if (json)
			sys.out(`${JSON.stringify({ ok: false, code: error.code, reason: error.message })}\n`);
		else sys.err(`gateweave: ${error.message}\n`);
		return error.exitCode;
	};

	try {
		let parsed: ReturnType<typeof parse>;
		try {
			parsed = parse(argv);
		} catch (error) {
			throw new CliError("usage", "usage", `${(error as Error).message}\n\n${USAGE}`);
		}
		const { values, positionals } = parsed;
		json = values.json === true;
		const command = positionals.join(" ");
		const doctor = command === "doctor track";
		if (values.version) {
			sys.out(`${version()}\n`);
			return 0;
		}
		if (values.help) {
			sys.err(doctor ? DOCTOR_USAGE : USAGE);
			return 0;
		}
		if (command !== "deploy track" && !doctor) {
			throw new CliError(
				"usage",
				"usage",
				`This version knows two commands, \`gateweave deploy track\` and \`gateweave doctor track\`.\n\n${USAGE}`,
			);
		}
		// Another command's options are refused, not ignored, so a typo cannot pass for a choice.
		const foreign = (doctor ? ["release", "no-attachments", "yes"] : ["url"]).filter(
			(option) => values[option as keyof typeof values] !== undefined,
		);
		if (foreign.length > 0) {
			throw new CliError(
				"usage",
				"usage",
				`\`gateweave ${command}\` has no option --${foreign[0]}.\n\n${doctor ? DOCTOR_USAGE : USAGE}`,
			);
		}
		const name = values.name ?? "gateweave-track";
		if (!NAME.test(name)) {
			throw new CliError(
				"usage",
				"bad-name",
				`"${name}" cannot name a Worker and a bucket: use lowercase letters, digits and dashes, at most 57 characters, not starting or ending with a dash.`,
			);
		}
		if (doctor) {
			if (values.url !== undefined && !/^https?:\/\/[^\s/]+/.test(values.url)) {
				throw new CliError(
					"usage",
					"bad-url",
					`"${values.url}" is not an address: use https://<host>.`,
				);
			}
			const found = await doctorTrack(sys, { name, account: values.account, url: values.url });
			sys.out(json ? `${JSON.stringify(found.findings)}\n` : describeDoctor(found));
			return found.findings.some(({ status }) => status === "fail") ? 1 : 0;
		}
		const result = await deployTrack(sys, {
			name,
			release: values.release,
			account: values.account,
			attachments: values["no-attachments"] !== true,
			yes: values.yes === true,
		});
		sys.out(json ? `${JSON.stringify(result)}\n` : describe(result));
		return 0;
	} catch (error) {
		if (error instanceof CliError) return fail(error);
		return fail(new CliError("unexpected", "unexpected", (error as Error).message));
	}
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			name: { type: "string" },
			url: { type: "string" },
			release: { type: "string" },
			account: { type: "string" },
			"no-attachments": { type: "boolean" },
			yes: { type: "boolean", short: "y" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean" },
		},
	});
}
