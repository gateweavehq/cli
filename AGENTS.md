# AGENTS.md

Guidance for AI coding agents and people working in this repository.

## The project

The Gateweave command line. It deploys and checks Gateweave Track in a person's own
Cloudflare account.

## Invariants

1. **Nothing is created before it is shown.** A command that creates or changes a Cloudflare
   resource prints the account and the full list first and waits for a yes, or for `--yes`.
2. **Existing resources are not touched** unless named by the person: no binding to, changing or
   deleting a database, bucket, queue or Worker that the command did not create in this run.
3. **Secrets never reach the screen, a log or the working directory.** They go from the generator
   to Cloudflare. A value a person must keep is shown once, with words that say so.
4. **A second run finishes the first and does nothing twice.**
5. **The tool holds no logic a product's own deploy lacks.** It runs each product's repository at
   a release tag; it does not fork their configuration.
6. **Never run against a Cloudflare account that holds anything you care about** in tests or by
   hand. Rehearse only in a separate, empty account.

## Code style

- TypeScript, strict. Node 22 or newer. No dependency without a reason written in the pull request.
- Processes are started without a shell, arguments as arrays.
- Dependencies pinned to exact versions.
- Comments explain why, not what.

## Git and pull requests

- Changes land through pull requests with green checks.
- Conventional Commits. No AI attribution in commits, pull requests or comments.
- Pull requests leave `CHANGELOG.md` alone; a maintainer adds each version's entry when releasing.
