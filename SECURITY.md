# Security policy

## Supported versions

The Gateweave command line is in early development. Security fixes go into `main` and the latest release only.

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request.

- Preferred: [open a private security advisory](https://github.com/gateweavehq/cli/security/advisories/new)
  on GitHub.
- Or email **security@gateweave.com**.

Include what an attacker could do, the steps to reproduce it, and the affected version or commit.
We aim to reply within three working days, and will keep you updated while we work on a fix,
and credit you in the release notes unless you would rather stay anonymous.

## Scope

Areas where reports are especially valuable:

- A secret reaching the screen, a log, the working directory or a record file.
- A command creating, changing or deleting a Cloudflare resource it did not make or was not told to.
- Fetching or running a release without checking what it fetched, including the install from
  `pkg.gateweave.com`.
- Starting a process in a way that lets input choose the command.
