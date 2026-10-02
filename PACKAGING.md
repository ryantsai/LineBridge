# Desktop packaging

LineBridge 0.5 restores the Windows/macOS desktop application as the main distribution. The native Tauri shell launches one bundled Node service; the same service implements LINE, authorization, encrypted SQLite and full-text search. Users need no Node installation or Rust compiler. The CLI/npm package remains an operator option.

## Build on the target OS

Use Node 26.5.0, Rust 1.98.1 and the platform's native Tauri prerequisites. The locked CLI is 2.12.1, Tauri library 2.12.0 and esbuild 0.28.2. Node/cloudflared assets and SHA-256 digests are pinned in `packaging/runtimes.json`.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build:windows     # Windows x64 only
npm run build:macos       # native Apple Silicon or Intel Mac
npm run test:desktop     # synthetic native startup, auth, persistence and shutdown
```

The build bundles the service/private worker into `runtime/app`, vendors the dashboard and dependency notices, verifies helper checksums/architectures/versions, then creates the installer. Windows uses a current-user NSIS installer with Traditional Chinese and English choices. macOS builds architecture-specific DMGs with Node and cloudflared as signed sidecars in `Contents/MacOS`; `npm run verify:macos` mounts the finished DMG read-only and checks its checksum, signatures, architecture and native startup.

Outputs are under `release/windows-x64`, `release/macos-arm64` or `release/macos-x64`, with an installer, `SHA256SUMS.txt` and `build-info.json`. The installer must be built on its target OS/architecture. GitHub Actions runs native Windows and both Mac jobs, plus portable Node tests on Linux/Windows.

Windows installers are unsigned. Mac apps are ad-hoc signed with Node JIT entitlements, not Developer ID signed or notarized. Production distribution requires the developer's signing credentials; the build does not invent them.

## Process and data ownership

The Rust shell owns a private readiness/shutdown pipe to Node and focuses the existing window on a second launch. Normal exit requests graceful shutdown; an abruptly ended parent closes the pipe and the service stops its worker and owned connector. A separate SQLite lease rejects concurrent use of the same data directory. The admin dashboard is loaded from its own loopback HTTP origin, with no privileged IPC access granted to remote content. Provider sign-in opens the system browser; its callback remains local.

The desktop and CLI use the same data location and schema. Set `LINE_BRIDGE_DATA` or pass `--data-dir DIR` to reuse an existing installation's accounts. App updates do not replace data. Back up the database and vault key together before changing machines/users.

## CLI archive

`npm run package` produces `release/npm/line-bridge-0.5.0.tgz` with checksums and a manifest. File-list validation excludes private data, native executables, Rust sources, generated bundles and build trees. Install on a machine that can reach LINE using `npm install -g ./line-bridge-0.5.0.tgz`; Node 24+ must already be present. No install-time download/start/build scripts are attached. Scoped tokens are required by default. The archive is not published to the npm registry.

## Verification

`npm run test:smoke` tests HTTP and the official MCP client with synthetic accounts. `npm run test:desktop` tests the native app, bundled runtime, multilingual archive across restart and process shutdown. `npm run test:tunnel` explicitly starts a disposable live Quick Tunnel, checking HTTPS, scoped API/MCP/search and inaccessible admin routes. It sends only synthetic messages. Build scripts preserve third-party licenses and verify runtime hashes before packaging.
