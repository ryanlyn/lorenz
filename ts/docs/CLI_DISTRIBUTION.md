# CLI Distribution

Ship the CLI as a single self-contained artifact built from the monorepo. Two consumer lanes are
supported from the same artifact:

- **`npx <tarball-url>`** - the `npm pack` tarball attached to a GitHub release.
- **`mise use npm:<name>`** - the same tarball published to an npm registry under one package name.

Both install the artifact as a dependency (not as the root project), which drives most of the design
below.

## Build And Stage

Run from `ts/` under the Node line in `mise.toml` (Node 24):

```sh
mise run build           # or: pnpm build
pnpm release:stage -- --force --tarball
```

Output:

```text
dist/cli-release/symphony-ts-v<version>/         # staged tree
dist/cli-release/symphony-ts-v<version>.tar.gz   # with --tarball
```

The staged tree excludes source, tests, `.tsbuildinfo`, and logs. `RELEASE-MANIFEST.json` records the
package graph, vendored runtime deps, host binaries, and external/native deps.

## Artifact Shape

The release is a **flattened, self-contained tree**. The root `package.json` declares:

- every workspace package as a local `file:` dependency,
- every external (registry) dependency at concrete versions (`catalog:` resolved),
- the vendored runtime SDKs as `file:` dependencies (see Host Binaries).

This flattening is required, not cosmetic. **npm does not install the registry dependencies of a
`file:` directory dependency when the package is installed as a dependency** (npx, `npm install
<tarball>`, `mise use npm:`, global install). Declaring the whole graph at the root makes `npm
install` resolve all 270-ish packages in either layout: the staged directory used as the install
root, or the release hoisted under a parent `node_modules`.

The launcher `bin/symphony-ts` resolves `@symphony/cli` through `import.meta.resolve` rather than a
fixed `../node_modules/...` path, so it works regardless of where npm places the package.

## Host Binaries (claude / codex)

The Claude Code and Codex agent binaries are **not bundled**. They ship from upstream as
platform-specific `optionalDependencies` of `@anthropic-ai/claude-agent-sdk` and `@openai/codex`
(~200 MB each). The staging script:

- **vendors** the dependency-free SDK JS into `runtime-deps/` with `optionalDependencies` stripped,
  so no install method ever fetches the binaries, and
- writes a launcher that resolves the host's own `claude` and `codex` and exposes them to the agent
  bridges via `CLAUDE_CODE_EXECUTABLE` and `CODEX_PATH` (using a login shell, matching the PATH the
  bridges see when Symphony spawns them with `bash -lc`). Existing values are respected.

Result: the installed tree drops from ~544 MB to ~118 MB. **The host must have `claude` and `codex`
on its login-shell PATH** for agent dispatch to work.

## Requirements On The Host

- **Node >= 24 on PATH** - the launcher is `#!/usr/bin/env node`, and `better-sqlite3` is compiled
  against the Node 24 ABI. Not bundled.
- **`claude` and `codex` on PATH** - the release uses the host's agent binaries (see above).
- **npm install scripts enabled** - `better-sqlite3` builds its native addon via `prebuild-install`
  (a prebuilt binary for common platforms; otherwise a C toolchain is required). An install run with
  `ignore-scripts=true` will leave the native addon unbuilt.

`better-sqlite3` is the only natively compiled dependency, so installed trees are Node-ABI, OS, and
arch sensitive.

## Lane A: npx off a GitHub release

```sh
npm pack dist/cli-release/symphony-ts-v<version>   # -> symphony-ts-release-<version>.tgz
# attach the .tgz as a GitHub release asset, then:
npx https://github.com/<owner>/<repo>/releases/download/<tag>/symphony-ts-release-<version>.tgz
```

No registry, no `prepare` hook, no build on the consumer: the tarball is prebuilt and its
dependencies are concrete registry versions plus bundled `file:` packages.

## Lane B: mise use npm

```sh
mise use npm:<name>     # e.g. mise use npm:symphony-ts
```

`mise use npm:` installs the package from a registry into a managed prefix and puts the bin on PATH -
mechanically a global install of the same artifact. Publishing exposes **one** public package name;
the internal `@symphony/*` packages ship bundled inside the tarball and are never published
separately. The root package is currently `private: true` and must be made publishable (or a private
/ scoped registry used) for this lane.

## Validation Status

End-to-end on darwin-arm64, Node 24:

- `npx <tarball-url>` installs and runs the CLI into real runtime logic.
- `npm install <tarball>` as a dependency and `npm install -g <tarball>` (the `mise use npm:` shape)
  both resolve the full graph, build `better-sqlite3`, and run.
- The slim install excludes the agent binaries (118 MB) and the launcher resolves host `claude` /
  `codex`.

Live agent dispatch (claude/codex producing output) depends on host auth and was not exercised; the
binary-resolution path is verified.

## Open / Next

- Publish: choose the public npm name (or a private/scoped registry) and flip the root package to
  publishable for Lane B.
- CI release job: `mise run build` -> `pnpm release:stage` -> `npm pack` -> upload asset (Lane A)
  and/or `npm publish` (Lane B), under the `mise.toml` Node line.
- The literal `mise use npm:<name>` round-trip is validated only once the package is published.
