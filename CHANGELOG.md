# Changelog

Notable changes to the Gateweave CLI, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before moving to it.

Each release is a tarball on `pkg.gateweave.com`, not a package on npm, so nothing updates it for
you: change the address to move to a new version. See [Install](README.md#install).

## [0.1.0] - 2026-11-26

The first release. It has two commands, both for Gateweave Track. The tests fake Wrangler, git
and pnpm. Both commands were also rehearsed in a real, empty Cloudflare account, and `deploy
track` was rehearsed from the packed tarball too. It is still early, so if you can, deploy first
into an account that holds nothing else.

### Added

- `gateweave deploy track` puts Track into your own Cloudflare account. It needs Node 22 or newer
  with npm, git, and Wrangler signed in (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN`). It
  installs nothing globally and writes nothing into the folder you run it from.
  - It first looks, changing nothing: the account (with several, it stops and lists them; choose
    one with `--account` or `CLOUDFLARE_ACCOUNT_ID`), whether R2 is on, Track's newest release (or
    the one you name with `--release`), and that no Worker, D1 database or R2 bucket of the
    planned names exists. A name already in use that it did not make stops it.
  - It then shows the account, the release and everything it will create, and waits for a yes:
    the Worker and D1 database (`--name`, default `gateweave-track`), the R2 bucket
    (`<name>-files`, left out with `--no-attachments`), the Durable Objects `WorkspaceDO` and
    `RateLimiter`, and the secret `BETTER_AUTH_SECRET` by name. `--yes` answers for you; without a
    terminal and without `--yes` it stops before creating anything.
  - It runs Track's own `pnpm run deploy` at the release tag, which creates the resources, sets
    `BETTER_AUTH_SECRET` to a value nobody sees, and applies the migrations.
  - It checks the address from outside for up to two minutes, then says what it created. Open the
    address and create the first account, which owns the server. MCP stays off until
    `BETTER_AUTH_URL` is set.
  - It keeps a record of what it made (names and ids, no secrets) in `%APPDATA%\gateweave` on
    Windows and `~/.config/gateweave` elsewhere. Run the same command again and it finishes what
    is left, or only checks a deployment that is done. It never binds to, changes or deletes an
    existing database, bucket or Worker it did not create.
  - `--json` prints one object, or `{ "ok": false, "code", "reason" }`. Exit codes 0 to 9 are
    listed in the README.
- `gateweave doctor track` says what is wrong with a Track deployment, in words. Each finding is
  `ok`, `warn` or `fail` with one sentence and the fix: the Worker, each required secret, the
  release against Track's newest, migrations not applied, whether sign-up is open, whether a first
  account exists, whether MCP is on, and the same checks from outside that `deploy track` ends
  with. It changes nothing in your Cloudflare account and never prints a secret's value.
  It works from the record `deploy track` keeps, or, for a deployment made another way, from
  `--name` and `--url`. It exits 1 when any finding is a `fail`. `--json` prints an array of
  `{ "id", "status", "message", "fix" }`.
- `gateweave --version` prints the version and nothing else.
- Install without npm and without cloning: run the tarball from its address with `npx --yes` and
  Node 22 or newer, as the README's Install section shows. The release folder has a `SHA256SUMS`,
  so a download checks with `sha256sum -c SHA256SUMS`. `https://pkg.gateweave.com/cli/latest.json`
  names the newest release with its address, SHA-256, npm `integrity` and the commit it was built
  from. A release never changes once it is there.

### Security

- The account printed by `deploy track --json` holds only its `id` and `name`, not the rest of
  Wrangler's account record, which can hold an email address and is often pasted into issues.
  The name itself can still hold one: Cloudflare names a new account `<email>'s Account`.
