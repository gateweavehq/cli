# gateweave

The Gateweave command line: deploy a Gateweave product into your own Cloudflare account.

It isn't on npm yet. Each release is a tarball on `pkg.gateweave.com`, which `npx` runs from its
address, with Node 22 or newer and nothing else installed:

```sh
npx --yes https://pkg.gateweave.com/cli/<version>/gateweave-<version>.tgz --version
npx --yes https://pkg.gateweave.com/cli/<version>/gateweave-<version>.tgz deploy track --help
```

[`cli/latest.json`](https://pkg.gateweave.com/cli/latest.json) names the newest release, with its
SHA-256 and the `integrity` that npm keeps in a lockfile, and each release's folder has a
`SHA256SUMS`. A release never changes once it is there. Since it doesn't come from a registry,
`npm update`, Dependabot and Renovate don't see a new one: change the address to move to it.

See the [repository](https://github.com/gateweavehq/cli) for what the commands do.

## License

[AGPL-3.0-only](LICENSE).
