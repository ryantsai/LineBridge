# LineBridge 0.6 portable Node bundle validation

Verified locally on Windows x64, 2026-10-03 (Asia/Taipei):

- `npm run package:portable` produced a Windows ZIP containing checksum-verified Node 26.5.0, bundled CLI/service/private worker, dashboard, documentation and licenses. Node/npm installation is not required on the target PC.
- `npm run test:portable` passed from an extracted folder outside the checkout, with spaces, Unicode and `!` in its path and an empty executable PATH. Checks cover launcher version/help/exit codes, the private worker, Windows DPAPI startup, scoped authentication, file/stdin sends, replay, search/read/events, persistence across restart and graceful stop. All accounts/messages were synthetic; no LINE or tunnel connection was started.
- JavaScript syntax and all **78 tests** passed. The shared desktop bundling command also completed. Native macOS/Linux portable builds have CI jobs but have not been run from this Windows session. Private-repository Linux ARM64 CI needs an available runner configured via `LINEBRIDGE_LINUX_ARM64_RUNNER`.
- The portable bundle retains the runtime next to the app; it does not register autostart or install a system service. Existing user data remains outside the release folder. This work does not publish a release or rebuild/sign the desktop installers.

# LineBridge 0.6 provider validation

Verified on 2026-10-03 (Asia/Taipei). Added Tailcat, ngrok and Tailscale Funnel to the separate cloud connection page, with local encrypted ngrok token storage and cloud AI probe instructions.

- JavaScript syntax, **56 tests** and HTTP/official MCP integration passed on Windows Node 26.5.0. New tests cover encrypted ngrok tokens, URL validation, Funnel route conflicts and ownership, authorization and pinned download rejection.
- Live Tailcat peer forwarding passed token enforcement, scoped HTTP/MCP, multilingual archive search, admin isolation and process cleanup using a disposable synthetic store. Tailcat 0.7.0 serves only the gateway with new ephemeral keys.
- Live Funnel passed those same checks using a public DNS resolver and TLS hostname verification, and removed only its newly created port-443 route. The existing private port-8443 route remained unchanged.
- Official ngrok 3.39.11 download, SHA-256 verification, extraction, reported version and YAML configuration validation passed. The real ngrok endpoint requires the user to enter their Authtoken locally; it has not yet been claimed as live-verified.
- The dependency-free cloud probe passed anonymous and authenticated checks against a synthetic service: health, token enforcement, admin isolation and all six MCP tools. The provider form was inspected in an isolated browser session, including Funnel's default port 443 and ngrok's password field. [Connection form preview](design/connections-ngrok.jpg).
- Rust formatting, its Windows path regression and Clippy passed. The 0.6.0 NSIS installer built and installed successfully; native startup, encrypted multilingual search across restart and owned-process shutdown passed. The installed app finds bundled Tailcat, preserves all 6 accounts and 3 tokens, preserves the enabled monitoring preference and retains the existing private Tailscale route. Read-only counts confirm the original messages/index remain intact. The user subsequently selected and started Tailcat; its read-only status reports connected.
- [Portable verification](https://github.com/ryantsai/LineBridge/actions/runs/37081141679) passed all 56 tests, HTTP/MCP integration and archive validation on Node 24/26 across Linux and Windows at commit `3887757`.
- [Native installer verification](https://github.com/ryantsai/LineBridge/actions/runs/37081141673) passed Windows x64 NSIS and both Mac DMGs at that same commit. All three checked native startup, scoped authentication, encrypted multilingual archive persistence, restored monitoring preferences and shutdown. Mac checks additionally verified the delivered DMG checksum, signatures and native helper versions/architectures, including bundled Tailcat 0.7.0. Mac resources copied from Go's read-only module cache are normalized to writable build inputs; repeat Rust test, Clippy and release resource copies passed.
- These checks run from this PC. The blocked cloud VM must run the supplied probe against each address; no provider is claimed reachable from that VM yet.

The previous restoration/data validation follows for historical reference; its 0.5 installer hashes/runs are not evidence for 0.6 artifacts.

# LineBridge 0.5 validation

Verified on 2026-10-03 (Asia/Taipei). The main distribution is again a Windows/macOS desktop app with a local LINE service and tunnel. Rust owns the Tauri window and process lifetime; the shared Node service owns policy, LINE, encrypted SQLite and search.

## Local Windows verification

- Windows x64 / Node 26.5.0: JavaScript syntax checks and **52 tests passed**. The suite covers grants, revocation/expiry/pause, idempotency, aliases, Talk/OpenChat normalization, durable capture acknowledgements, migration, encrypted storage, private worker lifetime and tunnel/Access/OAuth fixtures.
- Unicode search tests cover traditional/simplified Chinese, Japanese, Korean, Thai, Arabic, Hebrew, Hindi, Cyrillic, Greek, accented Latin text, compatibility characters, mixed scripts and emoji. One-character search, literal operators, phrase/all-term matching, false-positive pagination, repair/backfill and scope enforcement pass.
- The archive retains more than the previous 1,000-message ceiling. Message/index failures roll back together, successful replay is deduplicated, and deleting an account clears both tables. Database/WAL checks and the contentless FTS table contain no message plaintext. Queries are excluded from audit records.
- Rust 1.98.1: formatting, the Windows path regression test and Clippy with warnings denied passed. Tauri library 2.12.0 and CLI 2.12.1 are pinned. The Windows installer bundles SHA-256-verified Node 26.5.0 and cloudflared 2026.9.3.
- Native desktop and bundled-service integration passed: strict token authentication, a fresh Quick Tunnel default, multilingual archive search across restart, restored monitoring preferences, private worker startup, graceful shutdown and abrupt-parent cleanup without an orphan Node service. Sends were synthetic only.
- The native zh-TW UI was inspected in an isolated synthetic account. The welcome wizard, separate monitoring/search/connection pages and Japanese archive query worked. [Native archive view](design/native-archive.png).
- A live disposable Quick Tunnel passed HTTPS readiness, unauthenticated rejection, scoped HTTP/official MCP search, six-tool discovery, inaccessible admin routes and stop/URL cleanup. A per-process DoH resolver handled newly issued test hostnames; TLS hostname verification stayed enabled and no OS DNS setting changed.
- The NSIS installer installed successfully under the current Windows user. The installed executable launched its bundled service on loopback ports 3210/3211 with strict token authentication.

## Existing local data

The previous service was not running when a consistent SQLite snapshot and its current-user DPAPI vault were copied from the development data folder into `%LOCALAPPDATA%/LineBridgeData`. The original folder remains a backup. Before startup, read-only comparisons verified preserved account identities, all chat metadata/designations, token hashes/grants/expiry/revocation, send records and provider/monitor preferences. All stored secrets and messages still decrypt.

The copied database contains **6 accounts, 310 chat records, 2 token records, 3 encrypted messages and 6 encrypted credential/cache records**. The archive migration created a separate `backups/before-archive-*.sqlite` snapshot and indexed the existing messages. Quick Tunnel was selected for the restored app+tunnel setup; other saved permissions and credentials were retained. General upgrades preserve an existing store's provider choice, including the legacy local default when no provider setting exists.

LINE's saved session now returns `NOT_AUTHORIZED_DEVICE`; the same response was reproduced with the unbundled adapter. The app presents this as requiring a fresh phone QR login. Archive search remains available offline. No real LINE message was sent, no new chat was designated, and live capture must not be claimed until the account is reauthorized and its monitor is running.

The installed service's final read-only state check reports version 0.5.0, token authentication and AI access enabled. All account monitors are disabled, and Quick Tunnel is selected but not started. Reauthorize the LINE account with the phone, enable its monitor and start the connector to begin collecting new messages for a remote AI.

## Distribution and limits

Verified remote results:

- [Portable verification](https://github.com/ryantsai/LineBridge/actions/runs/37048547455): Node 24 and 26 on Linux and Windows all passed the tests, HTTP/MCP smoke and package validation.
- [Windows native job](https://github.com/ryantsai/LineBridge/actions/runs/37048547461): the Windows x64 NSIS job passed, including native startup, encrypted multilingual archive persistence across restart and shutdown. The downloaded installer matches its SHA-256 manifest.
- [Mac native verification](https://github.com/ryantsai/LineBridge/actions/runs/37050789266): both Apple Silicon and Intel DMGs passed checksum, strict code signatures, helper architectures/versions, private worker and native startup/archive/shutdown checks. The downloaded DMGs match their SHA-256 manifests.

The native builds bundle the same shared service. Mac verification mounts and launches the delivered DMG read-only; it does not rely on Tauri's removed intermediate app folder. Test sends and archived messages use isolated synthetic accounts.

Windows installers are unsigned. Mac apps use ad-hoc signatures and JIT entitlements, with no Developer ID signature or notarization. Production signing needs the developer's credentials. The operator npm archive is not published to the registry. Fixed-hostname Cloudflare DNS/Access provisioning remains deferred because no hostname was chosen.

Search is normalized literal substring search of saved text, without translation, stemming or attachment extraction. LINE replay availability limits offline recovery and initial OpenChat baselines; the archive is not a full history importer. Previously pruned messages cannot be recovered by the new index. Non-text or decryption-failed messages retain available metadata.

## Account binding and receiver health — 2026-10-03

- Setup now ends after account binding. Tunnel and API-key configuration stay in their separate sidebar pages. The completion screen and API access page provide a copyable cloud-agent CLI prompt, using a placeholder until a remote connection is available.
- Browser QA used a disposable local service and synthetic sandbox account: new/stored account completion, canceling another-account setup, clipboard equality, Unicode/case-normalized chat-name search, chat-ID search, empty results, draft preservation, chat-scoped archive filters and a matching Chinese archive query. Browser error/warning logs were empty. See [wizard and CLI prompt](design/account-binding-cli.jpg) and [manual archive search](design/manual-chat-archive-search.jpg).
- All 76 automated tests passed, plus JavaScript syntax and diff whitespace checks. Added receiver tests cover empty-poll success, failure/checkpoint timestamps, missing/stale/disconnected/disabled streams and scoped CLI status propagation. The final stopped-stream guard passed the focused inbox tests.
- Poll success is recorded after durable processing, independently of message arrival. Per-stream freshness uses a 60-second threshold; timestamps reset with the receiver. Sandbox health explicitly states that it does not poll LINE. No live LINE reauthorization, tunnel provisioning or native installer rebuild was performed in this change. The disposable QA service was stopped; its temporary data folder was retained because automatic approval review blocked recursive deletion.
