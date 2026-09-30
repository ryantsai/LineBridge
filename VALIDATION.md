# LineBridge verification · 2026-09-30

## Installer packaging

- Rebuilt the Windows x64 NSIS Unicode installer with per-user installation, Traditional Chinese/English language selection and the LineBridge Start Menu folder. Deliverable: `release/windows-x64/LineBridge_0.2.0_x64-setup.exe`, 45,582,505 bytes, unsigned. SHA-256: `19ec761a95e6377b17a51033570023ea03155e7aa3fc4308e777dc55d1f7ff82`; the adjacent `SHA256SUMS.txt` matches an independent hash check.
- 7-Zip tested the complete NSIS archive successfully. Its 18 entries include the app, private worker, matching Node/cloudflared binaries, source/checksum metadata, licenses and installer components. No local database, account data, credentials, tunnel configuration or AI tokens are included. This verifies the archive, not running the installation wizard.
- Cross-platform preparation verifies pinned official download hashes and executable formats/architectures before packaging. Windows preparation and both bundled runtime version checks passed. An already verified runtime is reused, so rebuilding does not try to overwrite the active Windows worker executable.
- JavaScript syntax checks, 25 JavaScript tests, six Rust tests and workspace clippy passed. The official JavaScript MCP client smoke test also passed against the Rust service with isolated synthetic data. No real LINE messages were sent.
- Added native Apple Silicon and Intel macOS configurations, ICNS icon, localized bundle metadata, signed Node/cloudflared sidecars, macOS helper/Tailscale paths and a minimum macOS version of 13.5. DMGs are configured for ad-hoc signing and are not notarized.
- Added a manual GitHub Actions workflow for Windows x64, macOS ARM64 and macOS x64, including regression checks, Mac signature/helper/app-startup checks and installer/checksum uploads. No GitHub remote is configured, and this workflow has not been dispatched. No Mac host is available in this task; **no DMG has been produced or macOS execution verified**. A Windows request for a Mac build exits clearly before compiling.

## Rust/Tauri migration

- Local Git repository on `main`, with baseline commit `b753e24`. No remote or push configured. Credentials, database, generated worker/runtime and build outputs are ignored.
- Stable Rust 1.98.1 and Tauri 2.12.0; desktop and service release builds succeeded. NSIS installer: `target/release/bundle/nsis/LineBridge_0.2.0_x64-setup.exe` (43.47 MiB, unsigned).
- Actual Node v26.5.0 runtime bundled, verified against official Node.js SHA-256 checksum. cloudflared 2026.9.3 retained with its previously verified checksum. Worker and dependency license notices included.
- JavaScript syntax checks and 22 automated tests passed. They cover LINE response normalization, encryption negotiation, monitor routing/filtering, OpenChat baseline discard/checkpoint readiness and acknowledgement-before-cursor handling, plus existing policy/vault/send regressions.
- Six Rust tests passed: vault binding/restart; account/chat/read/send scopes, global pause and revocation; queued revocation; duplicate, rejected and unknown sends; encrypted inbox opt-in, designation, deduplication, 1,000-message retention and restart; local Host/Origin/session/body-size and gateway/Cloudflare boundaries.
- Official JavaScript MCP client against the Rust service passed: tool discovery, granted/designed chat listing, synthetic send, event cursor, duplicate replay, forbidden room and immediate token revocation. All sends were synthetic.
- `cargo clippy --workspace --all-targets -- -D warnings` passed. Dependency audit reported zero known vulnerabilities at the current npm lockfile.

## Running app and migration preservation

The previous Node service was replaced with the Rust service. A first-start SQLite snapshot is saved in `data/backups/before-rust-20260930-134241.sqlite`. A read-only comparison confirmed that all account IDs/labels/types/devices/creation times and all chat IDs/names/types/designations match the snapshot. Six accounts and 310 total chat records (including the synthetic account) remain. The real connected account resumed from the existing DPAPI/AES vault without a new QR login and still has 308 chats: 46 groups, 256 contacts and six OpenChats. The user's earlier unknown send outcome remains unknown, without retry or reclassification.

The Tauri `LineBridge.exe` was started with its window hidden for a process/health check; the Rust gateway reported version 0.2.0. This verifies native startup, not complete native WebView UI interaction. The shared interface was tested in the in-app browser: zh-TW branding/navigation/status, OpenChat filter, sandbox monitoring on/off, two distinct synthetic sends, read-back and encrypted inbox count. These two captured messages survived a desktop/service restart. The browser console was checked for errors. `zh-TW-preview.jpg` shows the localized sandbox with the two messages. The source launcher reuses this checkout's data; a separately installed copy has its own app-local data directory unless `LINE_BRIDGE_DATA` is supplied.

The app is left in headless Rust mode on loopback ports 3210/3211, with the existing browser interface available. Real-account monitoring remains **off** until the user clicks **開始監聽**; sandbox monitoring was turned off after its check. No AI tokens were added to the user's database during this migration.

## Live LINE coverage and remaining limits

Earlier live diagnostics verified session resume and discovery. Joined OpenChat rooms are obtained from the initial membership event snapshot because the legacy joined-room API returns `NOT_IMPLEMENTED`. Earlier OpenChat and personal history requests completed but returned no messages, so historical coverage and live E2EE decryption remain unverified.

The previous group's send preparation was tested with message RPCs intercepted and key registration forbidden. LINE's explicit `E2EE_RETRY_PLAIN` selected standard transport messaging; it verified preparation only. The agent has sent **no live LINE messages**. Successful personal/OpenChat delivery and capture of a newly arriving real message still require a live test. Listener behavior is verified with synthetic/fake RPC fixtures; it uses bounded polling and does not claim guaranteed delivery or full historical synchronization.

Cloudflare remains inactive because the hostname/account configuration will be chosen later. Access policy/connectivity and Tailscale Serve activation have not been tested end to end. Hosted connector OAuth onboarding is not included. Native installer execution/full native UI interaction is not verified. The LINE adapter remains unofficial and includes an unmaintained `crypto-js` transitive dependency; an npm audit is not a compatibility or security guarantee.
