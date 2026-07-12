# Hyprlane broad Wave core artifact

The artifact is rooted at `dist/hyprlane` and is rebuilt from source. Do not
copy a Wave application bundle into this directory by hand.

## Reproducible development build

```sh
PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH" \
  HYPRLANE_WAVE_LOCAL_SYNTHETIC=1 \
  npm run build:hyprlane:broad-core

PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH" \
  HYPRLANE_WAVE_LOCAL_SYNTHETIC=1 \
  npm run verify:hyprlane:broad-core
```

The builder requires Node 22.17.0, npm 10.9.2, Go 1.25.6, macOS, and arm64.
It uses the pinned upstream commit time as `SOURCE_DATE_EPOCH`, strips local
Go paths, hashes every payload file, and fails if source changes while the
build is running.

`HYPRLANE_WAVE_LOCAL_SYNTHETIC=1` produces a development-only manifest with
`releaseEligible: false`. A release build must omit that flag, set
`HYPRLANE_WAVE_FORK_COMMIT` to the reviewed fork commit, and prove that the
commit is advertised by the canonical SellerSmith fork remote.

## Payload

The manifest covers the full renderer, host, preload, `wavesrv`, local `wsh`,
configuration schemas, capability policy, TypeScript and Go dependency
closures, Apache license and NOTICE, third-party notices, and SPDX SBOM. The
SHA-256 of `manifest.json` is the value pinned by the Hyprlane host lock.

Run the negative verifier suite with:

```sh
PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH" \
  npm run test:hyprlane:artifact
```

## Signing order

The reproducible artifact contains Go linker's ad-hoc-signed Mach-O binaries.
Developer ID signing changes their bytes. A signed release must sign `wavesrv`
and `wsh`, then mint the release manifest and Hyprlane lock, and only then
apply the outer `Hyprlane.app` seal. Never rewrite the manifest after the outer
app signature has been applied. The final packaged app remains subject to
`codesign`, notarization, stapling, and Gatekeeper verification.
