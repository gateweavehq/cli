# gateweave

The Gateweave command line: deploy a Gateweave product into your own Cloudflare account.

Run it from npm, with Node 22 or newer and nothing else installed:

```sh
npx --yes gateweave --version
npx --yes gateweave deploy track --help
```

Each release is also a tarball on `pkg.gateweave.com`, the mirror, with the same bytes npm has. `npx`
runs it from its address:

```sh
npx --yes https://pkg.gateweave.com/cli/<version>/gateweave-<version>.tgz --version
```

[`cli/latest.json`](https://pkg.gateweave.com/cli/latest.json) names the newest release, with its
SHA-256 and the `integrity` that npm keeps in a lockfile, and each release's folder has a
`SHA256SUMS`. A release never changes once it is there. Unlike the npm package, the mirror's
tarballs aren't seen by `npm update`, Dependabot and Renovate: change the address to move to a new
one.

See the [repository](https://github.com/gateweavehq/cli) for what the commands do.

## License

[AGPL-3.0-only](LICENSE).
