# Gateweave CLI

One command line for [Gateweave](https://gateweave.com): deploy a product into your own Cloudflare
account, update it, connect products to each other and check a deployment.

**Status: `gateweave deploy track` works: it deploys Track from a release into your own Cloudflare
account, checks it from outside and says what it created. Nothing else runs yet, and it is not
published, so run it from a checkout (see [Development](#development)).** The repository is
private until the first version has deployed Track into an empty Cloudflare account and checked it
from outside.

## What it will do

| Command                      | Purpose                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `gateweave deploy <product>` | Create what the product needs in your Cloudflare account, set its secrets, apply migrations, deploy, and check the result from outside |
| `gateweave update <product>` | Bring a deployment to a release, keeping its names and ids                                                                             |
| `gateweave doctor [product]` | Say what is wrong with a deployment, in words                                                                                          |
| `gateweave connect <a> <b>`  | Connect two products by one approval                                                                                                   |
| `gateweave runner`           | Work the issues assigned to an agent in Track with a coding agent on this machine                                                      |

The first version is `deploy track` and `doctor track`.

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
checks a deployment that is done.

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

## License

[AGPL-3.0](LICENSE).
