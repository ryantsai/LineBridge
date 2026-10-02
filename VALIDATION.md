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

## Distribution and limits

The private repository's workflows build native Windows NSIS and Apple Silicon/Intel Mac DMGs, verify bundled helper architectures/signatures and exercise native service lifetime. A separate portable-package workflow tests Node 24/26 on Linux and Windows. Remote results are recorded after those jobs finish; a workflow definition alone is not proof of a successful Mac build.

Windows installers are unsigned. Mac apps use ad-hoc signatures and JIT entitlements, with no Developer ID signature or notarization. Production signing needs the developer's credentials. The operator npm archive is not published to the registry. Fixed-hostname Cloudflare DNS/Access provisioning remains deferred because no hostname was chosen.

Search is normalized literal substring search of saved text, without translation, stemming or attachment extraction. LINE replay availability limits offline recovery and initial OpenChat baselines; the archive is not a full history importer. Previously pruned messages cannot be recovered by the new index. Non-text or decryption-failed messages retain available metadata.
