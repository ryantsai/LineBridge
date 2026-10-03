# Packaging

LineBridge provides desktop installers and portable CLI/service bundles. Both include Node and application dependencies; users need no Node installation or compiler. The native Tauri shell and portable launcher run the same service for LINE, authorization, encrypted SQLite and full-text search. The npm archive remains an option for hosts that already have Node.

## Portable CLI and service bundles

For an AI agent with authorized terminal access to the user's computer, use the portable bundle. Extract the whole folder and run `.\linebridge.cmd` (Windows) or `./linebridge` (macOS/Linux). The launcher resolves its own bundled runtime without relying on Node/npm on PATH, preserves the caller's working directory, forwards arguments/stdin and returns the CLI's exit code. `serve` runs in the foreground; `status` and `stop` operate on the selected data directory. Extraction does not install a system service or change PATH/autostart.

| Target | Archive | OS baseline |
| --- | --- | --- |
| Windows x64 | `LineBridge-0.6.0-windows-x64.zip` | Supported Windows 10/11 or Server 2016+ |
| macOS Apple Silicon | `LineBridge-0.6.0-macos-arm64.tar.gz` | Supported macOS 13.5+ |
| macOS Intel | `LineBridge-0.6.0-macos-x64.tar.gz` | Supported macOS 13.5+ |
| Linux x64 / ARM64 | `LineBridge-0.6.0-linux-x64.tar.gz` / `LineBridge-0.6.0-linux-arm64.tar.gz` | glibc 2.28+, kernel 4.18+, libstdc++ 6.0.25+, libatomic (`libatomic1` on Debian/Ubuntu) |

Linux builds use official glibc Node binaries; Alpine/musl is unsupported. These baselines follow the [bundled Node 26.5.0 requirements](https://github.com/nodejs/node/blob/v26.5.0/BUILDING.md). Use a supported OS release. Windows ARM64 native bundles are not included.

Build on each target OS/architecture with Node 26.5.0 and the native `tar` command available (included with supported Windows). Rust, Go and desktop build tools are unnecessary for this distribution:

```sh
npm ci --ignore-scripts
npm run package:portable
npm run test:portable
```

Output: `release/portable/<platform>-<arch>/`, containing the archive, `SHA256SUMS.txt` and `build-info.json`. `packaging/portable-node.json` pins each official Node archive and SHA-256; builds verify its checksum, executable architecture and native version before packaging. The archive contains only the Node executable/license/provenance, bundled CLI/service/private worker, dashboard, documentation and third-party licenses. It does not ship npm or require an install-time dependency download. Application data stays in the normal per-user data directory, outside the extracted folder, so replacing the app folder preserves accounts and messages.

The **Build LineBridge portable CLI bundles** workflow builds and tests native Windows x64, both Mac architectures and Linux x64. Linux ARM64 runs for public repositories, or for private repositories after setting `LINEBRIDGE_LINUX_ARM64_RUNNER` to an available native runner label. The smoke test extracts outside the repository into a path with spaces/Unicode, clears PATH, then checks the launcher, private worker, service, scoped CLI, multilingual file/stdin sends, persisted archive and graceful shutdown using synthetic accounts. Artifacts upload only after that native test passes. These portable artifacts are not separately signed or notarized by LineBridge.

A Dot session that controls the PC's terminal can use its loopback gateway with a scoped API key. A Dot session running only on a cloud host needs a reachable gateway URL. Tunnel helpers are optional and are not included in the portable bundle; install the desired connector separately as described in [CONNECTIONS.md](CONNECTIONS.md), or use the desktop distribution with bundled connectors. LINE phone pairing remains a user step. The dashboard includes copyable AI CLI instructions on completion of account binding and in the API key page.

## Build desktop installers on the target OS

Use Node 26.5.0, Rust 1.98.1 (and Go 1.27.1 on macOS to build the bundled Tailcat) and the platform's native Tauri prerequisites. The locked CLI is 2.12.1, Tauri library 2.12.0 and esbuild 0.28.2. Node/cloudflared assets and SHA-256 digests are pinned in `packaging/runtimes.json`.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build:windows     # Windows x64 only
npm run build:macos       # native Apple Silicon or Intel Mac
npm run test:desktop     # synthetic native startup, auth, persistence and shutdown
```

The build bundles the service/private worker into `runtime/app`, vendors the dashboard and dependency notices, bundles Tailcat 0.7.0 from its checksummed Windows release or pinned Go module on Mac, verifies helper checksums/architectures/versions, then creates the installer. Windows uses a current-user NSIS installer with Traditional Chinese and English choices. macOS builds architecture-specific DMGs with Node and cloudflared as signed sidecars in `Contents/MacOS`; `npm run verify:macos` mounts the finished DMG read-only and checks its checksum, signatures, architecture and native startup.

Outputs are under `release/windows-x64`, `release/macos-arm64` or `release/macos-x64`, with an installer, `SHA256SUMS.txt` and `build-info.json`. The installer must be built on its target OS/architecture. GitHub Actions runs native Windows and both Mac jobs, plus portable Node tests on Linux/Windows/macOS.

The private repository's **Build LineBridge desktop installers** workflow can also be started manually with `platform` set to `all`, `windows` or `macos`. Download the matching `LineBridge-windows-x64`, `LineBridge-macos-arm64` or `LineBridge-macos-x64` artifact from its successful run; each includes its checksum and build metadata. A workflow run is verified only after the native lifetime/signature checks pass, not merely when an installer file is produced.

Windows installers are unsigned. Mac apps are ad-hoc signed with Node JIT entitlements, not Developer ID signed or notarized. Production distribution requires the developer's signing credentials; the build does not invent them.

## Process and data ownership

The Rust shell owns a private readiness/shutdown pipe to Node and focuses the existing window on a second launch. Normal exit requests graceful shutdown; an abruptly ended parent closes the pipe and the service stops its worker and owned connector. A separate SQLite lease rejects concurrent use of the same data directory. The admin dashboard is loaded from its own loopback HTTP origin, with no privileged IPC access granted to remote content. Provider sign-in opens the system browser; its callback remains local.

The desktop and CLI use the same data location and schema. Set `LINE_BRIDGE_DATA` or pass `--data-dir DIR` to reuse an existing installation's accounts. App updates do not replace data. Back up the database and vault key together before changing machines/users.

## CLI archive

`npm run package` produces `release/npm/line-bridge-0.6.0.tgz` with checksums and a manifest. File-list validation excludes private data, native executables, Rust sources, generated bundles and build trees. Install on a machine that can reach LINE using `npm install -g ./line-bridge-0.6.0.tgz`; Node 24+ must already be present. No install-time download/start/build scripts are attached. Scoped tokens are required by default. The archive is not published to the npm registry.

## Verification

The archive includes the supported [data CLI](CLI.md), its client modules and credential adapters. `npm run test:package-cli` checks a fresh temporary installation after packaging. Portable CI tests Node 24/26 on Windows, macOS and Linux, with separate native synthetic DPAPI/Keychain/Secret Service checks. Unit tests label mocked OS helpers; native storage checks use disposable profiles and isolated stores. Neither suite uses real LINE credentials or messages.

`npm run test:smoke` tests HTTP and the official MCP client with synthetic accounts. `npm run test:desktop` tests the native app, bundled runtime, multilingual archive across restart and process shutdown. `npm run test:tunnel` explicitly starts a disposable live Quick Tunnel, checking HTTPS, scoped API/MCP/search and inaccessible admin routes. It sends only synthetic messages. Build scripts preserve third-party licenses and verify runtime hashes before packaging.

ngrok 3.39.11 is downloaded on demand into the user data directory, with pinned platform archive checksums; its proprietary agent is not bundled in installers. The installed Tailscale client supplies Serve and Funnel. See CONNECTIONS.md for cloud VM reachability checks.
