# Gateweave CLI

One command line for [Gateweave](https://gateweave.com): deploy Track into your own Cloudflare
account and check the deployment.

**Status: early.** `gateweave deploy track` and `gateweave doctor track` are written and tested
against a fake Wrangler, git and pnpm, and have not yet been rehearsed against a real Cloudflare
account. Nothing else exists yet. Each release is a tarball you run with `npx` (see
[Install](#install)); it is not on npm.

## Commands

| Command                  | Purpose                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `gateweave deploy track` | Create what Track needs in your Cloudflare account, set its secrets, apply migrations, deploy, and check the result from outside |
| `gateweave doctor track` | Say what is wrong with a Track deployment, in words                                                                              |

## `gateweave deploy track`

```
gateweave deploy track [--name <name>] [--release vX.Y.Z] [--account <id>] [--no-attachments] [--yes] [--json]
```

It needs Node 22 or newer with npm, git, and Wrangler signed in (`npx wrangler login`, or
`CLOUDFLARE_API_TOKEN`). It installs nothing globally and writes nothing into the folder you run it
from.

1. **Looks, changing nothing:** the account (with several, it stops and lists them: choose one with
   `--account` or `CLOUDFLARE_ACCOUNT_ID`), whether R2 is on, Track's newest release (or
   `--release`), and that no Worker, D1 database or R2 bucket of the planned names exists. A name in
   use that this tool did not make stops it.
2. **Shows the plan and waits for a yes:** the account, the release, the Worker and the D1 database
   (`<name>`, default `gateweave-track`), the R2 bucket (`<name>-files`, none with
   `--no-attachments`), the Durable Objects `WorkspaceDO` and `RateLimiter`, and the secret
   `BETTER_AUTH_SECRET` by name. `--yes` answers for you; without a terminal and without `--yes` it
   stops at once.
3. **Fetches the release** into your cache folder, installs it with the pnpm version Track names,
   and writes the names into its `wrangler.jsonc`.
4. **Runs Track's own `pnpm run deploy`**, which creates the database, the bucket and the Durable
   Objects, sets `BETTER_AUTH_SECRET` to a value nobody sees, and applies the migrations. Its
   output goes to stderr.
5. **Checks the address from outside** for up to two minutes: the sign-in page is Track's, accounts
   are looked up, and the sync gateway and MCP turn away a request without a session or token.
6. **Says what it created** and what to do next: open the address and create the first account,
   which owns the server; MCP stays off until `BETTER_AUTH_URL` is set.

It keeps a record of what it made, names and ids only, in `%APPDATA%\gateweave` on Windows and
`~/.config/gateweave` elsewhere. Run the same command again and it finishes what is left, or only
checks a deployment that is done. A database counts as its own only while its id matches the record,
and once the Worker it deployed is gone the record is ignored, so a name someone else took after a
removal by hand is refused.

With `--json`, stdout holds one object: the result, or `{ "ok": false, "code", "reason" }`.

| Exit code | Meaning                                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| 0         | Deployed, or already deployed, and every check passed                                     |
| 1         | Something unexpected; the reason says what                                                |
| 2         | Wrong usage: an unknown command or option, a bad name, a release that does not exist      |
| 3         | A requirement is missing: Node, git, npm, a Wrangler sign-in, or a list it could not read |
| 4         | The account: several to choose from, or the one named is not reachable                    |
| 5         | R2 is off in the account: turn it on, or use `--no-attachments`                           |
| 6         | A planned name is taken by something this tool did not make; nothing was changed          |
| 7         | No yes: declined, or no terminal and no `--yes`; nothing was created                      |
| 8         | Fetching, installing or Track's deploy failed; run it again to finish                     |
| 9         | Deployed, but a check from outside failed, or the address is unknown                      |

## `gateweave doctor track`

```
gateweave doctor track [--name <name>] [--url <address>] [--account <id>] [--json]
```

Says what is wrong with a Track deployment, in words. It reads and changes nothing in your
Cloudflare account, prints names and never a secret's value, and needs the same sign-in as
`deploy track`. It works from the record `deploy track` keeps, or, for a deployment made another
way (the Deploy button, a clone), from `--name` (the Worker, and a D1 database of the same name)
and `--url`.

Each finding is `ok`, `warn` or `fail`, with one sentence and the fix, a command or a link to
Track's [self-hosting guide](https://github.com/gateweavehq/track/blob/main/docs/self-hosting.md):

| Finding id        | What it says                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `worker`          | The Worker exists in the account, shown by name and id. If not, nothing else is tried.                                             |
| `secret-<name>`   | One for each secret in `secrets.required` of the release's `wrangler.jsonc`: set, or missing (`fail`)                              |
| `release`         | Against the newest tag of Track: older is a `warn`. A deployment this tool did not make has an unknown release.                    |
| `migrations`      | Migrations not applied yet (`fail`, or `warn` when the release is only guessed to be the newest)                                   |
| `sign-up`         | Open is a `warn`, by invitation is `ok`. From the sign-in page when it says so, else one fixed `SELECT` on the deployment's own D1 |
| `first-account`   | No account yet is a `warn`: whoever opens the address first owns the server                                                        |
| `mcp`             | `BETTER_AUTH_URL` unset: MCP is off, a `warn` with the command                                                                     |
| `outside-<check>` | The checks `deploy track` ends with, tried once each                                                                               |

Without `--url` and without a record, nothing can be checked from outside and `outside` says so.
The migrations and the sign-up query run in the release's files in the cache folder (the
checkout `deploy track` made, or a shallow clone of the release when there is none), with the
deployment's names in its `wrangler.jsonc`, written again on every run. Everything run against
Cloudflare reads: `whoami`, `secret list`, `d1 list`, that one `d1 execute` and, only when it
finds Wrangler's migrations table, `d1 migrations list` (Wrangler would create the table if it were
missing, so a database without it gets a `warn` and is left alone).

With `--json`, stdout is an array of `{ "id", "status", "message", "fix" }`. The exit code is 0
without a `fail` and 1 with one; a sign-in or an account to choose stops it earlier with the exit
codes 3 and 4 above, and a usage error with 2.

## Install

The package isn't on npm yet. Each release is a tarball on `pkg.gateweave.com`, which `npx` runs
from its address, with Node 22 or newer and nothing else installed:

```sh
npx --yes https://pkg.gateweave.com/cli/<version>/gateweave-<version>.tgz --version
```

[`cli/latest.json`](https://pkg.gateweave.com/cli/latest.json) names the newest release with its
address, SHA-256, the `integrity` that npm keeps in a lockfile and the commit it was built from. Each
release's folder has a `SHA256SUMS` too, so a download checks with `sha256sum -c SHA256SUMS`. A
release never changes once it is there. Since it doesn't come from a registry, `npm update`,
Dependabot and Renovate don't see a new version: change the address to move to it.

## Principles

- A thin layer over Wrangler and each product's own repository at a release tag. A product stays
  deployable without this tool.
- It shows the account and every resource it will create before it creates anything, and never
  binds to, changes or deletes something that already exists unless you name it.
- No secret is printed, logged or written into the working directory.
- Every command has `--json` and exits non-zero with a reason an agent can act on.

## Layout

```
packages/cli        the command line (TypeScript, Node 22 or newer, bin `gateweave`)
```

## Development

```sh
pnpm install
pnpm verify        # Biome, typecheck, tests, build
node packages/cli/dist/bin.js deploy track --help
```

The tests fake Wrangler, git and pnpm and never reach Cloudflare. Rehearse a real deploy only in a
separate, empty Cloudflare account.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems as described in
[SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE).
