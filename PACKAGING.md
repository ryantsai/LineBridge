# Packaging and releases

LineBridge ships portable bundles with Node, the shared service, browser dashboard, and CLI. Windows/macOS include a small native tray launcher; Only Windows and macOS are supported. Tauri, Rust, webviews, NSIS installers, and DMGs are no longer used. Existing data directories and encryption keys remain compatible; exit an older Tauri app before launching its replacement.

## Portable CLI and service bundles

Extract the whole archive. Use **linebridge.cmd** on Windows or **./linebridge** on macOS. Node/npm and compilers are not needed on the user's computer. Windows tray uses .NET Framework 4.8; macOS uses AppKit.

| Platform | Archive | Requirements |
| --- | --- | --- |
| Windows x64 | ZIP | Supported Windows 10/11 or Server 2016+; .NET Framework 4.8 for tray |
| macOS arm64 / x64 | tar.gz | Supported macOS 13.5+ |

These are build targets, not a guarantee that all architectures have been published. Select a compatible archive, checksum and build metadata from the [latest release's actual assets](https://github.com/ryantsai/LineBridge/releases/latest). Report a missing architecture instead of guessing its download URL or substituting an older release.

Open **LineBridge.exe** or **LineBridge.app**, or run **linebridge tray**. The tray verifies or starts the service, opens its actual admin URL in the default browser, and offers Open LineBridge, Quit tray (keep service running), and Stop service and quit. Repeated launches reuse the same service and one tray per data directory. The app must stay beside runtime and app; moving only the app breaks the bundle. A service started by the tray keeps running after the tray quits. Neither extraction nor the tray configures boot startup or automatic restart.

The `serve` command alone does not create a tray icon. Use `tray` to show the icon for a new or existing service.

The service binds only to 127.0.0.1 and requires scoped tokens by default. **serve** stays in the foreground; **status** reports actual ports and **stop** verifies service identity before shutdown. Ports default to admin 3210, gateway 3211, and connector health 3212. Conflicts fail with a diagnostic; use --admin-port and --gateway-port explicitly, leaving gateway + 1 free. No automatic remapping occurs, because profiles and tunnels depend on stable URLs. Startup logs from the tray are in the data directory.

Tunnel helpers are optional and downloaded separately through the dashboard; see [CONNECTIONS.md](CONNECTIONS.md). The setup wizard supplies the exact bundled CLI invocation and protected profile. LINE phone pairing and permission confirmation remain user steps.

## Build and verify

Build locally on the target OS with Node 26.5.0, npm dependencies, and tar. Windows also uses the OS .NET Framework C# compiler; macOS needs Xcode Command Line Tools (swiftc and codesign). The default architecture is the build process's architecture; `--arch x64` selects the Intel target. No Rust or Tauri dependencies are needed. Node runtime downloads are pinned and checked using packaging/portable-node.json. Windows cannot build or validate a Mac bundle.

Run **npm run check**, **npm test**, **npm run test:smoke**, **npm run package:portable**, then **npm run test:portable**. Outputs are under release/portable/<platform>-<architecture> with SHA256SUMS.txt and build-info.json. Tests extract into paths containing spaces/Unicode with Node/npm removed from PATH, verify service/CLI behavior, and on Windows/macOS exercise native tray/controller startup and shutdown without opening a browser. These are local build commands; they do not require enabling or running GitHub Actions.

### Intel Mac bundle

Run the following on a Mac with the build prerequisites above:

```sh
npm run package:portable -- --arch x64
npm run test:portable -- --arch x64
```

A native Intel Mac provides the strongest target-hardware validation. An Apple Silicon Mac can build and run the Intel bundle only with an existing Rosetta installation and Xcode Command Line Tools; report that result as Rosetta validation, not native Intel hardware testing. Do not install Rosetta automatically. Both routes must execute the packaged Intel Node runtime and Intel tray/controller smoke tests successfully; compilation or an architecture header alone is insufficient. Keep the generated `macos-x64` archive, checksum and build metadata together. Building does not publish an Intel download.

Windows binaries are unsigned and can trigger SmartScreen/unknown-publisher prompts. The macOS tray app is ad-hoc signed, not Developer ID signed or notarized, and Gatekeeper may block its first launch. Verify the release checksum and have the user handle necessary OS prompts. See [Microsoft's .NET Framework 4.8 runtime](https://dotnet.microsoft.com/en-us/download/dotnet-framework/net48) and [Apple's first-launch guidance](https://support.apple.com/en-us/102445). Portable Node retains its upstream signature.

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

For separate steps, `bump` accepts `patch` (the default), `minor`, `major`, or an explicit higher version. It validates and synchronizes all four application version files without making a commit. Review and commit those edits before `tag`. `tag` marks the current committed HEAD with `v<application version>`; it requires synchronized versions and a clean checkout, refuses a tag pointing to another commit, and reuses a matching tag for retries. `tag --push` requires a branch and exactly one `origin` push URL, then atomically pushes that branch and tag. It leaves the local tag in place if pushing fails; retry the same command after fixing the push failure.

```sh
npm run version:bump -- minor --dry-run
npm run version:bump -- minor
# Review the diff and commit the version changes before continuing.
npm run release:tag -- --dry-run
npm run release:tag -- --push
npm run release -- publish --dry-run
npm run release -- publish
```

On an Apple Silicon Mac with working Rosetta, `publish` defaults to building, testing and uploading both `arm64` and `x64` packages. It checks the hardware and executes an Intel system command to detect Rosetta, including when Node itself runs under Rosetta. Without Rosetta, or on an Intel Mac, it defaults to the build process's architecture. Rosetta is never installed automatically. Both targets must pass verification before any upload occurs.

After the first platform publishes a version, check out the same pushed tag on each other supported build host and run `publish` without `--bump` to append its packages. Use `--arch arm64` or `--arch x64` to publish only one architecture, including when the other architecture is already on the release. To add only Intel Mac assets from a Mac with the Intel execution prerequisites above, preview and then publish that same tag:

```sh
sh scripts/release.sh publish --arch x64 --dry-run
sh scripts/release.sh publish --arch x64
```

Do not bump the version when appending another architecture. Windows/macOS publish portable packages by default. `publish --kind all` adds the npm archive once alongside the default or explicitly selected portable architectures. Upload the npm archive only once per version. Use `publish --help` for repository, draft, prerelease and release-notes options. Every command accepts `--dry-run` without writes, builds, pushes or GitHub requests; macOS publish previews still run local read-only Rosetta checks, and `tag` previews run local read-only Git checks.

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

`publish:github` builds and uploads the default portable architectures on Windows/macOS: both Mac targets when Rosetta is detected, otherwise the host process's architecture. Use `--arch x64` or `--arch arm64` to select just one target. Run it on the corresponding OS with working target execution support to add packages to the same release; Mac x64 follows the Intel/Rosetta validation requirements above. To publish only one distribution:

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

The tray and CLI use the same data location and schema. Set `LINE_BRIDGE_DATA` or pass `--data-dir DIR` to reuse an existing installation's accounts. App updates do not replace data. Follow the backup steps below before upgrading. Copying a backup does not make OS-protected credentials portable to another machine/user.

## Upgrade backup and rollback

Use these steps on the same computer and OS user. Keep the complete old bundle until the new version and its LINE receivers have been verified. Extract the checksum-verified new bundle into a separate directory; do not overwrite files used by the running service.

Before stopping, run the old bundle's `status --data-dir DATA_DIR` and privately record its version, absolute `dataDir`, `adminPort`, `gatewayPort`, authentication, profile names and known launch arguments/environment. If you have never specified a data directory, run `status` first. Windows normally uses `%LOCALAPPDATA%/LineBridgeData`, macOS `~/Library/Application Support/LineBridge`, but legacy/default detection can reuse another existing path. Do not put credentials in the notes. Shutdown removes `service.json`, so record custom ports now.

### Stop and copy

Run the **old** launcher's `stop --data-dir DATA_DIR`. Recheck `status --data-dir DATA_DIR` for up to 30 seconds until it reports `stopped`, and confirm the previously recorded service PID has exited before copying. Quit any remaining tray, including one attached to this data directory. The tray's **Stop service and quit** does both; **Quit tray (keep service running)** alone does not stop the service. If status is `unavailable` or shutdown cannot be confirmed, investigate before proceeding. Do not copy a live SQLite database with ordinary file-copy commands.

The full data directory includes the following:

| Item | Backup requirement |
| --- | --- |
| `bridge.sqlite` | Accounts, encrypted sessions/messages, grants, settings and monitor cursors. |
| `vault-key.dpapi` (Windows) / `vault-key.bin` (macOS) | Required matching encryption master key; retain it with the database. Windows needs the original user's DPAPI context. The Mac file is the secret key itself, protected by filesystem permissions. |
| `bridge.sqlite-wal`, `bridge.sqlite-shm`, if present | Copy with the database after confirmed shutdown; never mix files from different snapshots. |
| Remaining files/subdirectories | Preserve them in the full copy, including existing migration backups and connector files. Runtime PID/lease files are not proof a service is running. |

Replace `DATA_DIR` with the **verified absolute path**. The examples make a new sibling directory and never overwrite an earlier backup. Use a private local location; do not upload a data/key backup to an AI chat or public share.

Windows PowerShell, after confirmed shutdown:

```powershell
$ErrorActionPreference = 'Stop'
$lineBridgeData = (Resolve-Path -LiteralPath 'DATA_DIR').Path.TrimEnd('\')
$lineBridgeBackup = "$lineBridgeData.pre-upgrade-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
if (Test-Path -LiteralPath $lineBridgeBackup) { throw 'Backup already exists' }
Copy-Item -LiteralPath $lineBridgeData -Destination $lineBridgeBackup -Recurse -Force
function Get-LineBridgeManifest([string]$directory) {
  @(Get-ChildItem -LiteralPath $directory -File -Recurse -Force | ForEach-Object {
    [pscustomobject]@{
      Path = $_.FullName.Substring($directory.Length + 1)
      Length = $_.Length
      SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  } | Sort-Object Path) | ConvertTo-Json -Compress
}
if ((Get-LineBridgeManifest $lineBridgeData) -cne (Get-LineBridgeManifest $lineBridgeBackup)) {
  throw 'Backup verification failed; do not upgrade'
}
```

macOS shell, after confirmed shutdown:

```sh
data="/ABSOLUTE/EXISTING_DATA_DIR"
backup="${data}.pre-upgrade-$(date +%Y%m%d-%H%M%S)"
test -d "$data" && test ! -e "$backup" || exit 1
umask 077
ditto "$data" "$backup" || exit 1
diff -qr "$data" "$backup" || exit 1
shasum -a 256 "$data/bridge.sqlite" "$backup/bridge.sqlite" \
  "$data/vault-key.bin" "$backup/vault-key.bin"
```

`diff` checks the complete copied file contents; the corresponding database and key hashes should also match. Keep the directory private (0700) and the Mac key private (0600), including in backups.

**CLI profiles are separate.** On Windows, also copy the encrypted profile directory `%LOCALAPPDATA%/LineBridgeClient`, or the existing `LINE_BRIDGE_CLIENT_CONFIG` override, into a separate new sibling backup using the same PowerShell copy/manifest procedure. Do this without running enrollment/forget commands concurrently. Restore under the same user and retain profile filenames. On macOS, CLI tokens live in the user's Keychain under service `org.linebridge.cli.v1`; copying the app data directory does not back them up. Keep the same unlocked Keychain and use the user's normal OS backup method if a separate credential backup is needed. Do not export plaintext tokens. An app upgrade normally requires no profile changes.

Built-in `backups/before-archive-*.sqlite` snapshots are created only when the legacy archive migration markers are absent. They are database-only, omit the vault key and CLI profiles, and are not created before every upgrade. Cross-OS vaults are rejected, and copied DPAPI/Keychain material is not a supported cross-user or cross-machine migration procedure.

### Start and verify the new bundle

Use the new launcher's `--version`, then `tray --data-dir DATA_DIR --admin-port ADMIN_PORT --gateway-port GATEWAY_PORT` with the recorded values, or the original authenticated background launch method. Keep the same user, data path and authentication; reserve gateway + 1 as before. Within 30 seconds, `status --data-dir DATA_DIR` must show the expected running version, data path, ports and authentication. Inspect `service.stderr.log` if it fails and stop after that bounded attempt.

Run `accounts --profile PROFILE_NAME` and `chats --profile PROFILE_NAME --account ACCOUNT_ID` using the existing profile. Verify the original accounts, designated chats and archive access, then each receiver's health against its returned `monitor.checkedAt` and `monitor.staleAfterMs`. A running HTTP listener alone is not successful recovery. Cloud connectors are stopped with the old service and may require an explicit start after upgrade; a new Quick Tunnel URL requires updating the remote AI endpoint and rechecking authenticated access.

### Roll back without overlaying a database

Stop the new service and tray as above, verify shutdown, and retain its logs. Reconfirm the resolved absolute original data path and backup path, and that the new `failed` path does not exist. Rename the upgraded directory to a sibling, then restore the entire verified pre-upgrade directory to the original path. Do not delete either snapshot or copy just an old `bridge.sqlite` into newer WAL/SHM files.

Windows PowerShell, using the verified `$lineBridgeData` and `$lineBridgeBackup` from above:

```powershell
$lineBridgeFailed = "$lineBridgeData.failed-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
if (Test-Path -LiteralPath $lineBridgeFailed) { throw 'Recovery target already exists' }
Move-Item -LiteralPath $lineBridgeData -Destination $lineBridgeFailed
Copy-Item -LiteralPath $lineBridgeBackup -Destination $lineBridgeData -Recurse -Force
if ((Get-LineBridgeManifest $lineBridgeBackup) -cne (Get-LineBridgeManifest $lineBridgeData)) {
  throw 'Restore verification failed; do not start'
}
```

macOS shell, using the verified `data` and `backup` paths from above:

```sh
failed="${data}.failed-$(date +%Y%m%d-%H%M%S)"
test -d "$backup" && test ! -e "$failed" || exit 1
mv "$data" "$failed" || exit 1
ditto "$backup" "$data" || exit 1
diff -qr "$backup" "$data" || exit 1
```

Start the **complete old bundle** with the recorded launch settings and original path; repeat the status/account/receiver checks. Do not run old code against the upgraded database. Rollback restores the backup's messages, cursors, settings and grants, losing changes since that snapshot; upstream LINE history may not be available to recover missed messages. Reconcile any post-backup token expiry/revocation, grant changes or newly enrolled profiles before re-enabling AI access. If Windows profile files changed, retain their current directory before restoring the matching encrypted profile backup; unchanged profiles need no restore. If a Mac Keychain entry was removed or changed, the data backup cannot restore it—use the user's OS backup or explicitly authorized re-enrollment, without exposing secrets.

## CLI archive

Replace `VERSION` below with the actual release version. `npm run package` produces `release/npm/line-bridge-VERSION.tgz` with checksums and a manifest. File-list validation excludes private data, native executables, Rust sources, generated bundles and build trees. Install on a machine that can reach LINE using `npm install -g ./line-bridge-VERSION.tgz`; Node 24+ must already be present. No install-time download/start/build scripts are attached. Scoped tokens are required by default. The archive is not published to the npm registry.

## Verification

The archive includes the supported [data CLI](CLI.md), its client modules and credential adapters. `npm run test:package-cli` checks a fresh temporary installation after packaging. Portable CI tests Node 24/26 on Windows and macOS, with separate native synthetic DPAPI/Keychain checks. Unit tests label mocked OS helpers; native storage checks use disposable profiles and isolated stores. Neither suite uses real LINE credentials or messages.

`npm run test:smoke` tests HTTP and the official MCP client with synthetic accounts. Native tray/controller checks run in `npm run test:portable`. `npm run test:tunnel` explicitly starts a disposable live Quick Tunnel, checking HTTPS, scoped API/MCP/search and inaccessible admin routes. It sends only synthetic messages. Build scripts preserve third-party licenses and verify runtime hashes before packaging.

ngrok 3.39.11 is downloaded on demand into the user data directory, with pinned platform archive checksums; its proprietary agent is not bundled in portable archives. The installed Tailscale client supplies Serve and Funnel. See CONNECTIONS.md for cloud VM reachability checks.
