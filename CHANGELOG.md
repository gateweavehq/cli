# Changelog

Notable changes to the Gateweave CLI, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before moving to it.

Each release is a tarball on `pkg.gateweave.com`, not a package on npm, so nothing updates it for
you: change the address to move to a new version. See [Install](README.md#install).

## [0.1.0] - 2026-11-26

The first release, with two commands for Gateweave Track. The tests fake Wrangler, git and pnpm.
Both commands were also rehearsed in a real, empty Cloudflare account, `deploy track` also from
the packed tarball. It is still early, so if you can, deploy first into an account that holds
nothing else. The README describes each command in full.

### Added

- `gateweave deploy track` puts Track into your own Cloudflare account. It needs Node 22 or newer
  with npm, git, and Wrangler signed in (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN`).
  - It first reads, changing nothing in Cloudflare: the account (with several, it lists them and
    stops; choose one with `--account` or `CLOUDFLARE_ACCOUNT_ID`), Track's newest release (or
    `--release`), whether R2 is on when attachments are wanted, and whether a Worker, D1 database
    or R2 bucket of the planned names already exists. An existing one stops it, unless its
    deployment record names it; for the D1 database, a recorded database id must match too.
  - It shows the plan and asks before creating anything. The plan lists:
    - the account and the release
    - the Worker and the D1 database, named by `--name` (default `gateweave-track`)
    - the R2 bucket `<name>-files`, unless you pass `--no-attachments`
    - the Durable Objects the release declares
    - the secret `BETTER_AUTH_SECRET`, by name only

    `--yes` answers for you. If it needs to deploy and has neither a terminal nor `--yes`, it
    exits 7.
  - It then runs Track's own `pnpm run deploy` at that release tag. That script creates the
    resources, sets `BETTER_AUTH_SECRET` and applies the migrations.
  - It checks the address from outside, retrying for about two minutes. If every check passes, it
    says what it made and what to do next: create the first account, which owns the server, and
    set `BETTER_AUTH_URL` for MCP. If a check fails, it exits 9.
  - It keeps a record of names, ids and progress in `deployments.json`, with no secrets in it.
    The file is under `%APPDATA%\gateweave` on Windows, and under `$XDG_CONFIG_HOME/gateweave` or
    `~/.config/gateweave` elsewhere.
  - Run the same command again to retry an unfinished deploy at the recorded release. A finished
    deploy is only checked.
  - `--json` prints one object, or `{ "ok": false, "code", "reason" }` on failure. The README lists
    the exit codes 0 to 9.
- `gateweave doctor track` says what is wrong with a Track deployment, in words.
  - Each finding has a status (`ok`, `warn` or `fail`), a message and, where there is one, the
    fix.
  - It looks at:
    - the Worker and the required secrets
    - the release, against Track's newest
    - migrations not yet applied
    - sign-up, and whether a first account exists
    - signs that MCP is on
    - given an address, the same outside checks that `deploy track` ends with
  - It changes nothing in Cloudflare and uses secrets' names only.
  - It reads the record `deploy track` keeps. For a deployment made another way, pass `--name` and
    `--url`.
  - It exits 1 when any finding is a `fail`.
  - With `--json`, a completed check prints an array of `{ "id", "status", "message", "fix" }`,
    with `fix` null when there is none. A command error prints `{ "ok": false, "code", "reason" }`.
- `gateweave --version` prints the version.
- Install without cloning. With Node 22 or newer and npm, run the release's tarball address with
  `npx --yes`, as the README's Install section shows.
  - Each release folder has a `SHA256SUMS` file to check with `sha256sum -c`.
  - `https://pkg.gateweave.com/cli/latest.json` names the newest stable release. It gives the
    tarball address, the SHA-256, npm's `integrity`, the commit the release was built from, and
    when it was published.
  - A release never changes once it is there.

### Security

- In the `deploy track --json` result, `account` holds only the account's `id` and `name`. It
  leaves out the rest of Wrangler's account record, which can hold an email address. The name is
  kept as Wrangler returns it, so an address in it still shows. Cloudflare's default name,
  `<email>'s Account`, holds one.
