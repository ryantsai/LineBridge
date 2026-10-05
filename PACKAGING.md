# Packaging and releases

LineBridge ships portable bundles with Node, the shared service, browser dashboard, and CLI. Windows/macOS include a small native tray launcher; Only Windows and macOS are supported. Tauri, Rust, webviews, NSIS installers, and DMGs are no longer used. Existing data directories and encryption keys remain compatible; exit an older Tauri app before launching its replacement.

## Portable CLI and service bundles

Extract the whole archive. Use **linebridge.cmd** on Windows or **./linebridge** on macOS. Node/npm and compilers are not needed on the user's computer. Windows tray uses .NET Framework 4.8; macOS uses AppKit.

| Platform | Archive | Requirements |
| --- | --- | --- |
| Windows x64 | ZIP | Supported Windows 10/11 or Server 2016+; .NET Framework 4.8 for tray |
| macOS arm64 / x64 | tar.gz | Supported macOS 13.5+ |

Open **LineBridge.exe** or **LineBridge.app**, or run **linebridge tray**. The tray verifies or starts the service, opens its actual admin URL in the default browser, and offers Open LineBridge, Quit tray (keep service running), and Stop service and quit. Repeated launches reuse the same service and one tray per data directory. The app must stay beside runtime and app; moving only the app breaks the bundle. A service started by the tray keeps running after the tray quits. Neither extraction nor the tray configures boot startup or automatic restart.

The `serve` command alone does not create a tray icon. Use `tray` to show the icon for a new or existing service.

The service binds only to 127.0.0.1 and requires scoped tokens by default. **serve** stays in the foreground; **status** reports actual ports and **stop** verifies service identity before shutdown. Ports default to admin 3210, gateway 3211, and connector health 3212. Conflicts fail with a diagnostic; use --admin-port and --gateway-port explicitly, leaving gateway + 1 free. No automatic remapping occurs, because profiles and tunnels depend on stable URLs. Startup logs from the tray are in the data directory.

Tunnel helpers are optional and downloaded separately through the dashboard; see [CONNECTIONS.md](CONNECTIONS.md). The setup wizard supplies the exact bundled CLI invocation and protected profile. LINE phone pairing and permission confirmation remain user steps.

## Build and verify

Build on the target OS/architecture with Node 26.5.0, npm dependencies, and tar. Windows also uses the OS .NET Framework C# compiler; macOS needs Xcode Command Line Tools (swiftc and codesign). No Rust or Tauri dependencies are needed. Node runtime downloads are pinned and checked using packaging/portable-node.json.

Run **npm run check**, **npm test**, **npm run test:smoke**, **npm run package:portable**, then **npm run test:portable**. Outputs are under release/portable/<platform>-<architecture> with SHA256SUMS.txt and build-info.json. The portable workflow builds Windows x64 and both Mac architectures. Tests extract into paths containing spaces/Unicode with Node/npm removed from PATH, verify service/CLI behavior, and on Windows/macOS exercise native tray/controller startup and shutdown without opening a browser. macOS compilation and tray execution require a Mac runner.

Windows binaries are unsigned. The macOS tray app is ad-hoc signed, not Developer ID signed or notarized. Portable Node retains its upstream signature.

## Publish local builds to GitHub Releases

### Release helper scripts (Windows and macOS)

The helpers share `scripts/release.mjs`, so version, tag and release behavior is the same on every platform. They require Node.js 24+ on PATH; tagging also requires Git, and publishing requires authenticated GitHub CLI, installed npm dependencies and the native build prerequisites above. Each launcher resolves the repository from its own location, preserves the caller's working directory for relative paths such as `--notes-file`, forwards arguments and returns a nonzero exit code on failure.

| Shell | Helper invocation |
| --- | --- |
| Windows PowerShell | `.\scripts\release.ps1 <command> [options]` |
| Windows Command Prompt | `scripts\release.cmd <command> [options]` |
| macOS (POSIX shell) | `sh scripts/release.sh <command> [options]` |
| Any platform with npm | `npm run release -- <command> [options]` |

To bump, commit, tag, push and publish together, start from a clean branch with application changes already committed. Preview first, then run the same command without `--dry-run`:

```powershell
# Windows PowerShell (use scripts\release.cmd in Command Prompt)
.\scripts\release.ps1 publish --bump patch --dry-run
.\scripts\release.ps1 publish --bump patch
```

```sh
# macOS
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

After the first platform publishes a version, check out the same pushed tag on each other native OS/architecture and run `publish` without `--bump` to append its packages. Windows/macOS publish portable packages by default. `publish --kind all` also includes the npm archive (upload it only once per version). Use `publish --help` for repository, draft, prerelease and release-notes options. Every command accepts `--dry-run` without writes, builds, pushes or GitHub requests; `tag` previews still run local read-only Git checks.

### Publisher setup and recovery

Install the [GitHub CLI](https://cli.github.com/) and run `gh auth login` with an account that can write releases to this repository. Install build dependencies with `npm ci --ignore-scripts` and use the native build prerequisites above. Commit your application changes, then optionally increment the version and publish in one command:

```sh
npm run publish:github -- --bump patch --dry-run
npm run publish:github -- --bump patch
```

`--bump` accepts `patch`, `minor`, `major`, or an explicit higher version such as `0.7.0` or `0.7.0-rc.1`. It synchronizes `package.json`, both application entries in `package-lock.json`, `server/version.mjs`, and `openapi.json`. Dependency versions and documentation/download links are preserved. Existing application versions must agree before publishing.

The bump flow requires a clean branch checkout, a configured Git author/committer, and `origin`'s push URL pointing to the selected GitHub repository. It rejects existing local or GitHub tags for the new version. After all tests, builds and artifact verification pass, it commits only the four version files as `Release v<version>`, creates the matching local tag, atomically pushes the branch and tag to `origin`, verifies the GitHub tag, and uploads the release assets. Add `--kind all`, `--draft`, `--prerelease`, or `--notes-file PATH` as needed; an explicit prerelease version still needs `--prerelease` to mark the GitHub release as a prerelease.

If a build or test fails, the synchronized version edits remain for inspection; no release commit, tag, push or upload occurs. Fix the failure and finish the commit/tag/push manually, then run without `--bump`. If the push fails after the release commit/tag, retry `git push --atomic origin HEAD refs/tags/v<version>` and publish without `--bump`. Use `--bump` only for the first native build of a new version; other platforms should check out the pushed tag and publish without it.

To publish an already prepared version without incrementing it, ensure the application versions agree, commit your changes, then create and push the matching tag:

```sh
git tag v0.6.1
git push origin HEAD
git push origin v0.6.1
npm run publish:github -- --dry-run
npm run publish:github
```

Use the version from `package.json` in place of `0.6.1`. If the tag already exists, check out its commit instead of recreating it. Publishing requires a clean checkout whose HEAD matches the tag on GitHub. The repository defaults to the one selected by `gh` for this checkout; use `--repo OWNER/REPO` to select it explicitly.

`publish:github` builds and uploads the native portable bundle on Windows/macOS. Run it on each native OS/architecture to add that platform to the same release. To publish only one distribution:

```sh
npm run publish:portable
npm run publish:npm
```

`publish:npm` uploads the Node-dependent `.tgz` to **GitHub Releases**, not the npm registry. Use `npm run publish:github -- --kind all` to include it with native artifacts; the npm archive only needs to be uploaded once per version.

Before uploading, each command runs syntax checks, unit tests and the service smoke test, builds the selected distributions, and runs their package smoke tests. It verifies artifact versions and SHA-256 checksums and stages only the files named by the build manifests in `release/github/v<version>/`. Checksum and metadata filenames include the distribution and platform so separate native uploads do not collide. Other files under `release/` are not uploaded.

A new release is published with generated notes by default. For its first upload, use `--draft`, `--prerelease`, or `--notes-file PATH` as needed. Later uploads append assets to the existing release and preserve its notes and draft/prerelease state; omit creation options on these runs. Existing asset names cause an error and are never overwritten. If an upload is interrupted, inspect the release and remove only the incomplete assets you intend to replace before retrying. A draft can be published from GitHub once all platforms have been added.

`--dry-run` prints the version/build/upload plan without changing files, creating commits/tags, building, contacting GitHub or changing a release. `npm run publish:github -- --help` lists all options. These commands do not run the GitHub Actions build workflows or publish anything to npm.

## Process and data ownership

The native tray uses a private pipe to a Node controller, which starts the detached portable service or verifies an existing instance. Closing the tray or losing its controller pipe leaves the service running. Only Stop service and quit (or the CLI stop command) requests verified graceful shutdown. Separate SQLite leases prevent duplicate services and trays for one data directory. The dashboard and provider sign-in open in the default browser; the admin interface and provider callback stay on loopback.

The tray and CLI use the same data location and schema. Set `LINE_BRIDGE_DATA` or pass `--data-dir DIR` to reuse an existing installation's accounts. App updates do not replace data. Back up the database and vault key together before changing machines/users.

## CLI archive

`npm run package` produces `release/npm/line-bridge-0.6.1.tgz` with checksums and a manifest. File-list validation excludes private data, native executables, Rust sources, generated bundles and build trees. Install on a machine that can reach LINE using `npm install -g ./line-bridge-0.6.1.tgz`; Node 24+ must already be present. No install-time download/start/build scripts are attached. Scoped tokens are required by default. The archive is not published to the npm registry.

## Verification

The archive includes the supported [data CLI](CLI.md), its client modules and credential adapters. `npm run test:package-cli` checks a fresh temporary installation after packaging. Portable CI tests Node 24/26 on Windows and macOS, with separate native synthetic DPAPI/Keychain checks. Unit tests label mocked OS helpers; native storage checks use disposable profiles and isolated stores. Neither suite uses real LINE credentials or messages.

`npm run test:smoke` tests HTTP and the official MCP client with synthetic accounts. Native tray/controller checks run in `npm run test:portable`. `npm run test:tunnel` explicitly starts a disposable live Quick Tunnel, checking HTTPS, scoped API/MCP/search and inaccessible admin routes. It sends only synthetic messages. Build scripts preserve third-party licenses and verify runtime hashes before packaging.

ngrok 3.39.11 is downloaded on demand into the user data directory, with pinned platform archive checksums; its proprietary agent is not bundled in portable archives. The installed Tailscale client supplies Serve and Funnel. See CONNECTIONS.md for cloud VM reachability checks.
