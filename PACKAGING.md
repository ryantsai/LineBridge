# Packaging

LineBridge provides desktop installers and portable CLI/service bundles. Both include Node and application dependencies; users need no Node installation or compiler. The native Tauri shell and portable launcher run the same service for LINE, authorization, encrypted SQLite and full-text search. The npm archive remains an option for hosts that already have Node.

The desktop bundle also includes `bin/linebridge.mjs` alongside its Node runtime. After explicit local read + send setup, the dashboard supplies a safely quoted invocation using those exact local paths and the automatically enrolled protected profile. The AI can use data commands without a separate portable CLI installation, PATH changes or user Terminal enrollment.

## Portable CLI and service bundles

For an AI agent with authorized terminal access to the user's computer, use the portable bundle. Extract the whole folder and run `.\linebridge.cmd` (Windows) or `./linebridge` (macOS/Linux). The launcher resolves its own bundled runtime without relying on Node/npm on PATH, preserves the caller's working directory, forwards arguments/stdin and returns the CLI's exit code. `serve` runs in the foreground; `status` and `stop` operate on the selected data directory. Extraction does not install a system service or change PATH/autostart.

| Target | Archive | OS baseline |
| --- | --- | --- |
| Windows x64 | `LineBridge-0.6.1-windows-x64.zip` | Supported Windows 10/11 or Server 2016+ |
| macOS Apple Silicon | `LineBridge-0.6.1-macos-arm64.tar.gz` | Supported macOS 13.5+ |
| macOS Intel | `LineBridge-0.6.1-macos-x64.tar.gz` | Supported macOS 13.5+ |
| Linux x64 / ARM64 | `LineBridge-0.6.1-linux-x64.tar.gz` / `LineBridge-0.6.1-linux-arm64.tar.gz` | glibc 2.28+, kernel 4.18+, libstdc++ 6.0.25+, libatomic (`libatomic1` on Debian/Ubuntu) |

Linux builds use official glibc Node binaries; Alpine/musl is unsupported. These baselines follow the [bundled Node 26.5.0 requirements](https://github.com/nodejs/node/blob/v26.5.0/BUILDING.md). Use a supported OS release. Windows ARM64 native bundles are not included.

Build on each target OS/architecture with Node 26.5.0 and the native `tar` command available (included with supported Windows). Rust and desktop build tools are unnecessary for this distribution:

```sh
npm ci --ignore-scripts
npm run package:portable
npm run test:portable
```

Output: `release/portable/<platform>-<arch>/`, containing the archive, `SHA256SUMS.txt` and `build-info.json`. `packaging/portable-node.json` pins each official Node archive and SHA-256; builds verify its checksum, executable architecture and native version before packaging. The archive contains only the Node executable/license/provenance, bundled CLI/service/private worker, dashboard, documentation and third-party licenses. It does not ship npm or require an install-time dependency download. Application data stays in the normal per-user data directory, outside the extracted folder, so replacing the app folder preserves accounts and messages.

The **Build LineBridge portable CLI bundles** workflow builds and tests native Windows x64, both Mac architectures and Linux x64. Linux ARM64 runs for public repositories, or for private repositories after setting `LINEBRIDGE_LINUX_ARM64_RUNNER` to an available native runner label. The smoke test extracts outside the repository into a path with spaces/Unicode, clears PATH, then checks the launcher, private worker, service, scoped CLI, multilingual file/stdin sends, persisted archive and graceful shutdown using synthetic accounts. Artifacts upload only after that native test passes. These portable artifacts are not separately signed or notarized by LineBridge.

A Dot session that controls the PC's terminal can use its loopback gateway with a scoped API key. A Dot session running only on a cloud host needs a reachable gateway URL. Tunnel helpers are optional and are not included in the portable bundle; install the desired connector separately as described in [CONNECTIONS.md](CONNECTIONS.md), or use the desktop distribution with bundled connectors. LINE phone pairing remains a user step. The dashboard includes copyable AI CLI instructions on completion of account binding and in the API key page.

## Build desktop installers on the target OS

Use Node 26.5.0, Rust 1.98.1 and the platform's native Tauri prerequisites. The locked CLI is 2.12.1, Tauri library 2.12.1 and esbuild 0.28.2. Node/cloudflared assets and SHA-256 digests are pinned in `packaging/runtimes.json`.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build:windows     # Windows x64 only
npm run build:macos       # native Apple Silicon or Intel Mac
npm run test:desktop     # synthetic native startup, auth, persistence and shutdown
```

The build bundles the service/private worker into `runtime/app`, vendors the dashboard and dependency notices, verifies helper checksums/architectures/versions, then creates the installer. Windows uses a current-user NSIS installer with Traditional Chinese and English choices. macOS builds architecture-specific DMGs with Node and cloudflared as signed sidecars in `Contents/MacOS`; `npm run verify:macos` mounts the finished DMG read-only and checks its checksum, signatures, architecture and native startup.

Outputs are under `release/windows-x64`, `release/macos-arm64` or `release/macos-x64`, with an installer, `SHA256SUMS.txt` and `build-info.json`. The installer must be built on its target OS/architecture. GitHub Actions runs native Windows and both Mac jobs, plus portable Node tests on Linux/Windows/macOS.

The private repository's **Build LineBridge desktop installers** workflow can also be started manually with `platform` set to `all`, `windows` or `macos`. Download the matching `LineBridge-windows-x64`, `LineBridge-macos-arm64` or `LineBridge-macos-x64` artifact from its successful run; each includes its checksum and build metadata. A workflow run is verified only after the native lifetime/signature checks pass, not merely when an installer file is produced.

Windows installers are unsigned. Mac apps are ad-hoc signed with Node JIT entitlements, not Developer ID signed or notarized. Production distribution requires the developer's signing credentials; the build does not invent them.

## Publish local builds to GitHub Releases

### Release helper scripts (Windows, macOS and Linux)

The helpers share `scripts/release.mjs`, so version, tag and release behavior is the same on every platform. They require Node.js 24+ on PATH; tagging also requires Git, and publishing requires authenticated GitHub CLI, installed npm dependencies and the native build prerequisites above. Each launcher resolves the repository from its own location, preserves the caller's working directory for relative paths such as `--notes-file`, forwards arguments and returns a nonzero exit code on failure.

| Shell | Helper invocation |
| --- | --- |
| Windows PowerShell | `.\scripts\release.ps1 <command> [options]` |
| Windows Command Prompt | `scripts\release.cmd <command> [options]` |
| macOS / Linux (POSIX shell) | `sh scripts/release.sh <command> [options]` |
| Any platform with npm | `npm run release -- <command> [options]` |

To bump, commit, tag, push and publish together, start from a clean branch with application changes already committed. Preview first, then run the same command without `--dry-run`:

```powershell
# Windows PowerShell (use scripts\release.cmd in Command Prompt)
.\scripts\release.ps1 publish --bump patch --dry-run
.\scripts\release.ps1 publish --bump patch
```

```sh
# macOS / Linux
sh scripts/release.sh publish --bump patch --dry-run
sh scripts/release.sh publish --bump patch
```

For separate steps, `bump` accepts `patch` (the default), `minor`, `major`, or an explicit higher version. It validates and synchronizes all seven application version files without making a commit. Review and commit those edits before `tag`. `tag` marks the current committed HEAD with `v<application version>`; it requires synchronized versions and a clean checkout, refuses a tag pointing to another commit, and reuses a matching tag for retries. `tag --push` requires a branch and exactly one `origin` push URL, then atomically pushes that branch and tag. It leaves the local tag in place if pushing fails; retry the same command after fixing the push failure.

```sh
npm run version:bump -- minor --dry-run
npm run version:bump -- minor
# Review the diff and commit the version changes before continuing.
npm run release:tag -- --dry-run
npm run release:tag -- --push
npm run release -- publish --dry-run
npm run release -- publish
```

After the first platform publishes a version, check out the same pushed tag on each other native OS/architecture and run `publish` without `--bump` to append its packages. Windows/macOS publish desktop + portable packages by default; Linux publishes portable packages. `publish --kind all` also includes the npm archive (upload it only once per version). Use `publish --help` for repository, draft, prerelease and release-notes options. Every command accepts `--dry-run` without writes, builds, pushes or GitHub requests; `tag` previews still run local read-only Git checks.

### Publisher setup and recovery

Install the [GitHub CLI](https://cli.github.com/) and run `gh auth login` with an account that can write releases to this repository. Install build dependencies with `npm ci --ignore-scripts` and use the native build prerequisites above. Commit your application changes, then optionally increment the version and publish in one command:

```sh
npm run publish:github -- --bump patch --dry-run
npm run publish:github -- --bump patch
```

`--bump` accepts `patch`, `minor`, `major`, or an explicit higher version such as `0.7.0` or `0.7.0-rc.1`. It synchronizes `package.json`, both application entries in `package-lock.json`, `server/version.mjs`, the Tauri configuration, the Rust workspace version and its application lockfile entry, and `openapi.json`. Dependency versions and documentation/download links are preserved. Existing application versions must agree before publishing.

The bump flow requires a clean branch checkout, a configured Git author/committer, and `origin`'s push URL pointing to the selected GitHub repository. It rejects existing local or GitHub tags for the new version. After all tests, builds and artifact verification pass, it commits only the seven version files as `Release v<version>`, creates the matching local tag, atomically pushes the branch and tag to `origin`, verifies the GitHub tag, and uploads the release assets. Add `--kind all`, `--draft`, `--prerelease`, or `--notes-file PATH` as needed; an explicit prerelease version still needs `--prerelease` to mark the GitHub release as a prerelease.

If a build or test fails, the synchronized version edits remain for inspection; no release commit, tag, push or upload occurs. Fix the failure and finish the commit/tag/push manually, then run without `--bump`. If the push fails after the release commit/tag, retry `git push --atomic origin HEAD refs/tags/v<version>` and publish without `--bump`. Use `--bump` only for the first native build of a new version; other platforms should check out the pushed tag and publish without it.

To publish an already prepared version without incrementing it, ensure the package and desktop versions agree, commit your changes, then create and push the matching tag:

```sh
git tag v0.6.1
git push origin HEAD
git push origin v0.6.1
npm run publish:github -- --dry-run
npm run publish:github
```

Use the version from `package.json` in place of `0.6.1`. If the tag already exists, check out its commit instead of recreating it. Publishing requires a clean checkout whose HEAD matches the tag on GitHub. The repository defaults to the one selected by `gh` for this checkout; use `--repo OWNER/REPO` to select it explicitly.

`publish:github` builds and uploads the native desktop installer and portable bundle on Windows/macOS, or the portable bundle on Linux. Run it on each native OS/architecture to add that platform to the same release. To publish only one distribution:

```sh
npm run publish:desktop
npm run publish:portable
npm run publish:npm
```

`publish:npm` uploads the Node-dependent `.tgz` to **GitHub Releases**, not the npm registry. Use `npm run publish:github -- --kind all` to include it with native artifacts; the npm archive only needs to be uploaded once per version.

Before uploading, each command runs syntax checks, unit tests and the service smoke test, builds the selected distributions, and runs their package smoke tests (including DMG verification on macOS). It verifies artifact versions and SHA-256 checksums and stages only the files named by the build manifests in `release/github/v<version>/`. Checksum and metadata filenames include the distribution and platform so separate native uploads do not collide. Other files under `release/` are not uploaded.

A new release is published with generated notes by default. For its first upload, use `--draft`, `--prerelease`, or `--notes-file PATH` as needed. Later uploads append assets to the existing release and preserve its notes and draft/prerelease state; omit creation options on these runs. Existing asset names cause an error and are never overwritten. If an upload is interrupted, inspect the release and remove only the incomplete assets you intend to replace before retrying. A draft can be published from GitHub once all platforms have been added.

`--dry-run` prints the version/build/upload plan without changing files, creating commits/tags, building, contacting GitHub or changing a release. `npm run publish:github -- --help` lists all options. These commands do not run the GitHub Actions build workflows or publish anything to npm.

## Process and data ownership

The Rust shell owns a private readiness/shutdown pipe to Node and focuses the existing window on a second launch. Normal exit requests graceful shutdown; an abruptly ended parent closes the pipe and the service stops its worker and owned connector. A separate SQLite lease rejects concurrent use of the same data directory. The admin dashboard is loaded from its own loopback HTTP origin, with no privileged IPC access granted to remote content. Provider sign-in opens the system browser; its callback remains local.

The desktop and CLI use the same data location and schema. Set `LINE_BRIDGE_DATA` or pass `--data-dir DIR` to reuse an existing installation's accounts. App updates do not replace data. Back up the database and vault key together before changing machines/users.

## CLI archive

`npm run package` produces `release/npm/line-bridge-0.6.1.tgz` with checksums and a manifest. File-list validation excludes private data, native executables, Rust sources, generated bundles and build trees. Install on a machine that can reach LINE using `npm install -g ./line-bridge-0.6.1.tgz`; Node 24+ must already be present. No install-time download/start/build scripts are attached. Scoped tokens are required by default. The archive is not published to the npm registry.

## Verification

The archive includes the supported [data CLI](CLI.md), its client modules and credential adapters. `npm run test:package-cli` checks a fresh temporary installation after packaging. Portable CI tests Node 24/26 on Windows, macOS and Linux, with separate native synthetic DPAPI/Keychain/Secret Service checks. Unit tests label mocked OS helpers; native storage checks use disposable profiles and isolated stores. Neither suite uses real LINE credentials or messages.

`npm run test:smoke` tests HTTP and the official MCP client with synthetic accounts. `npm run test:desktop` tests the native app, bundled runtime, multilingual archive across restart and process shutdown. `npm run test:tunnel` explicitly starts a disposable live Quick Tunnel, checking HTTPS, scoped API/MCP/search and inaccessible admin routes. It sends only synthetic messages. Build scripts preserve third-party licenses and verify runtime hashes before packaging.

ngrok 3.39.11 is downloaded on demand into the user data directory, with pinned platform archive checksums; its proprietary agent is not bundled in installers. The installed Tailscale client supplies Serve and Funnel. See CONNECTIONS.md for cloud VM reachability checks.
