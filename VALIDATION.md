# LineBridge verification · 2026-09-30

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
