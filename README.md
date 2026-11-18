# Gateweave CLI

One command line for [Gateweave](https://gateweave.com): deploy a product into your own Cloudflare
account, update it, connect products to each other and check a deployment.

**Status: in design. Nothing here runs yet.** The requirements and the order of work are on the
project's board (WEB-75). The repository is private until the first version has deployed Track
into an empty Cloudflare account and checked it from outside.

## What it will do

| Command | Purpose |
| --- | --- |
| `gateweave deploy <product>` | Create what the product needs in your Cloudflare account, set its secrets, apply migrations, deploy, and check the result from outside |
| `gateweave update <product>` | Bring a deployment to a release, keeping its names and ids |
| `gateweave doctor [product]` | Say what is wrong with a deployment, in words |
| `gateweave connect <a> <b>` | Connect two products by one approval |
| `gateweave runner` | Work the issues assigned to an agent in Track with a coding agent on this machine |

The first version is `deploy track` and `doctor track`.

## Principles

- A thin layer over Wrangler and each product's own repository at a release tag. A product stays
  deployable without this tool.
- It shows the account and every resource it will create before it creates anything, and never
  binds to, changes or deletes something that already exists unless you name it.
- No secret is printed, logged or written into the working directory.
- Every command has `--json` and exits non-zero with a reason an agent can act on.

## Layout

```
packages/cli        the command line (TypeScript, Node 22 or newer, no global install: npx)
docs/               design notes
```

## License

[AGPL-3.0](LICENSE).
