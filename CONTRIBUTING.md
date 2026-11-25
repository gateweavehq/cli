# Contributing to the Gateweave CLI

Thanks for helping out! This guide covers how to get a working setup and what we look for in a
pull request. Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

For anything large, open an issue first so we can agree on the shape before you write it.

## Setup

You need Node 22 or newer (see `.node-version`) and pnpm.

```sh
pnpm install
pnpm verify        # Biome, typecheck, tests, build
node packages/cli/dist/bin.js deploy track --help
```

The tests fake Wrangler, git and pnpm and never reach Cloudflare. Do not run a real deploy against
an account you care about: rehearse only in a separate, empty Cloudflare account.

## Contributor License Agreement

Gateweave projects are open source under the AGPL-3.0. The maintainer also offers them under other
terms, such as a hosted service and commercial licenses, and these help fund the projects. So that
every contribution can be part of both, contributors sign the [CLA](CLA.md) once, and it covers every
Gateweave project. You keep the copyright to your work.

A bot asks you to sign on your first pull request. To sign, reply with the sentence it gives you.

## Before you open a pull request

```sh
pnpm verify      # what CI runs, minus the second operating system
```

`pnpm format` fixes most Biome findings. Fill in the pull request template. You don't need to edit
`CHANGELOG.md`; it is written when a version is released.

## Guidelines

- **Keep changes focused.** One pull request covers one concern.
- **Hold the invariants in [AGENTS.md](AGENTS.md).** Nothing is created before it is shown, existing
  resources are not touched, secrets never reach the screen, a log or the working directory, and a
  second run finishes the first.
- **Test behavior.** Add a test for every bug fix and every new command or option, using the fakes in
  `packages/cli/test`.
- **Dependencies:** none without a reason written in the pull request, pinned to exact versions.
- **Processes** are started without a shell, with arguments as an array.
- **Match the surrounding code.** Biome enforces formatting.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
`refactor:`, `test:`, `chore:`, with a scope when it helps.

## Working with AI coding agents

You are welcome to use one. [AGENTS.md](AGENTS.md) gives agents the project's invariants and
conventions. You remain responsible for the change: review it, run `pnpm verify`, and make sure you
can explain it in review.

## Reporting bugs

Open an issue using the bug report form. Report security problems privately, as described in
[SECURITY.md](SECURITY.md), never in a public issue.
