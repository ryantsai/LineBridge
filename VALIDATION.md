# LineBridge 0.4 validation

Verified on 2026-10-01 (Asia/Taipei): **46 tests passed on Windows x64 / Node 26.5.0 and Ubuntu Linux x64 / Node 24.21.0**. A clean global installation of `line-bridge-0.4.0.tgz` on Linux also passed the installed version check and HTTP/official MCP client smoke test. The local client created no token; all sends were synthetic. Syntax and archive-content checks passed. The archive remains unpublished to the npm registry.

The new access tests verify a loopback peer, local Host, direct-local provider and absence of browser/proxy metadata before granting token-free access. Node fetch's standalone `Sec-Fetch-Mode: cors` header remains compatible. Browser Origin/Referer/Fetch-Site/Fetch-Dest and navigation requests are rejected; forwarding metadata cannot receive local trust.

Local clients see only accounts with designated chats and enabled local permissions. Read/send permissions can be disabled independently; changes take effect before queued sends and after upstream reads. Global pause, idempotency and encrypted inbox behavior remain effective. Supplied invalid, expired or revoked tokens never fall back to local trust. Selecting any tunnel provider or starting with `--require-token` requires credentials across the listener, even with a localhost Host. CLI strict mode and persisted local permissions were verified across restart.

The zh-TW wizard was completed using an isolated synthetic account: select a chat, disable send, save permissions, connect without credentials and reach the completion summary. The separate permissions page showed the persisted read-only setting and a collapsed optional remote-token section. No browser warnings/errors were reported. [Updated wizard screenshot](design/local-ai-setup.png). The temporary service and tab were closed after verification.

A consistent backup was saved as `data/backups/before-local-ai-0.4.0.sqlite` before replacing the running 0.3 service. Read-only comparisons verified unchanged account identities, all chat metadata/designations, token hashes/grants/expiry/revocation, send records and provider/monitor preferences. All secrets and inbox messages still decrypt. The saved LINE session resumed without QR login. The running service is now **0.4.0**, on loopback ports 3210/3211, with working token-free status requests. Monitoring remains off; no real LINE send, chat designation or token was created by this update.

The following records describe the earlier 0.3 migration, including its live Quick Tunnel check. Version 0.4 rechecked tunnel authentication using HTTP fixtures; it did not create a live tunnel or DNS/Access resources.

## Previous 0.3 migration

Verified on 2026-10-01 (Asia/Taipei). The supported distribution is now the headless npm package. Rust/Tauri sources, desktop configuration, NSIS/DMG build scripts and bundled runtimes were removed from the repository. Retired files are recoverable through Git history and a scratch archive outside the deliverable.

### Runtime and packaging

- Windows x64, Node 26.5.0: syntax checks and all **40 tests** passed; HTTP integration also verifies the loopback OAuth callback, absence of reflected callback values, Quick Tunnel Host allowlisting and immediate host removal after stop.
- Ubuntu Linux x64 under WSL, Node **24.21.0**, npm 11.19.0: all **40 tests** passed, with source and dependencies on the Linux filesystem. An earlier run from Windows-mounted source hit a startup deadline because of filesystem overhead; testing from native Linux storage passed without changing the service timeout.
- The Linux runtime was downloaded from the official Node distribution and matched its published SHA-256: `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`.
- Clean local and global Linux installs of the `.tgz` using `npm install --ignore-scripts` passed the installed executable/version/help checks, HTTP/official MCP integration and private-worker dependency resolution. The final global archive installation and updated HTTP security checks passed on Ubuntu. No Rust, compiler, Tauri, desktop runtime or native application build was used.
- Packaging inspects the npm archive file list. Data, vault keys, provider credentials, developer tests, build trees, old installers and runtime executables are excluded. SHA-256 and npm integrity metadata accompany the archive. The package is **not published to the registry**.
- The CI definition covers Node 24/26 on Linux and Windows. No Git remote is configured, so remote CI has not run. macOS execution has not been tested.

### Behavior

Tests cover account/chat grants, independent read/send permissions, revocation before dispatch and after upstream reads, pause, rejected/unknown send outcomes, idempotency replay, alias precedence and namespace/account isolation, Talk/OpenChat normalization and cursors, commit acknowledgements, encrypted inbox capture and 1,000-message retention.

CLI tests verify a consistent SQLite backup of an existing store, exclusive ownership via an OS-released SQLite lease, retained inbox/preferences, instance-verified shutdown, clean restart and recovery after SIGKILL. Linux checks assert 0700 data directories and 0600 vault keys. Windows DPAPI vault restart and authenticated cipher binding pass.

Cloudflare fixtures verify one-use state/PKCE, code exchange, encrypted tokens, Access-before-DNS provisioning, conflicts and saved partial failures. Provider helpers remain optional; a new store defaults to localhost. The **live Node Quick Tunnel smoke check passed**: HTTPS readiness, token enforcement, inaccessible admin routes, official-client JSON MCP and stop/URL cleanup. It used a disposable synthetic database and a per-process DoH resolver with TLS hostname verification retained. No real LINE account was used. Real named-tunnel DNS/Access provisioning remains deferred because no hostname was selected.

### Existing local database

The old service was stopped before Node took ownership. Startup created `data/backups/before-node-2026-10-01T00-25-00-868Z.sqlite`. A read-only comparison confirmed unchanged account identities/labels/devices, all chat names/types/designations, token hashes/grants/expiry/revocation, send records and provider/monitor preferences. All stored secrets and inbox entries decrypt using the existing vault.

The database retains **6 accounts, 310 chat records, 2 token records, 3 inbox messages and 6 encrypted credential/cache records**. The saved LINE session resumed without QR login. Existing unknown sends were neither retried nor reclassified. Monitoring remains off for every account; no real chat designation, AI token or LINE send was created by this migration.

The local service is Node 0.3.0 on loopback ports 3210/3211. The zh-TW browser dashboard remains available. A fresh-store UI check verified the direct localhost default, optional provider selection and separate settings/monitoring pages, with no browser warnings/errors. [Screenshot](design/headless-local.png). Desktop frontend invocation paths were removed. The temporary UI verification service and tab were closed.
