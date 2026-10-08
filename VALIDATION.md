# Codex MCP integration review - 2026-10-08

Review branch `cloud/codex-mcp-integration` starts from the preserved
README checkpoint `96d2b239802a07ba81567bc9fa0e0a4f05e22c44`, on refreshed main
`9fb0a5fc7db582e4df3ca4f2a548dae372b9310b` (v0.7.13). This is unreleased
engineering evidence from Linux/Node 24.19.0; Linux remains unsupported for the
LineBridge CLI/service. The ordinary Luna/Medium README recommendation is intact.

- `npm run test:codex`: **25/25 passed** on disposable files, synthetic protected
  stores and synthetic MCP traffic. Coverage includes scope/consent, byte and
  profile preservation, stale writes, foreign/edited entries, fixed read/send
  allowlists, no retries/redirects, version-only verification, POSIX ownership,
  and fail-closed metadata boundaries. The Windows helper is inspected/mocked;
  its PowerShell and native ACL APIs were not executed on Linux. Including the
  protected-helper suite, affected checks passed **30/30**.
- First-install regressions exercise the real `runCodex` path with modeled
  native helpers. Unavailable/refusing helpers, inherited custom protection and
  a protection change before publication leave `config.toml` absent and remove
  the temporary/lock. Supported modeled macOS/Windows cases complete install,
  verify and uninstall. The empty candidate is checked before writing and the
  completed candidate is validated again before publication; these are
  synthetic regression checks, not native Windows acceptance evidence.
- Full regression after the helper and first-install corrections: **390/390 passed**,
  no skips, using a test-only `darwin`
  platform preload and writable `/tmp` npm cache. Processes, IPC and SQLite are
  real Linux execution; the preload is not evidence of native macOS/Windows
  behavior. An earlier run without the required cache passed 385/386 and failed
  only the packaging test because the default npm cache was unwritable. An
  earlier unmodeled targeted run passed 24/25; the existing portable-host test
  rejects Linux as designed.
- JavaScript syntax and diff whitespace checks passed. The actual esbuild
  bundle completed preview/install/static verify/uninstall in a disposable
  project, using modeled macOS policy/metadata commands. Intermittent metadata
  refusals were traced to a successful fast helper exiting before a zero-byte
  stdin write (`EPIPE`). The shared helper now uses closed stdin for empty input;
  nonempty credential pipes still fail closed. A real-process regression and
  **30 disposable install/uninstall round-trips** passed after the correction.
  The local npm
  archive and fresh disposable installation checks cover shipped files,
  dependency inclusion, installed Codex preview/help and MCP-only stdout.
- Actual installed `codex-cli 0.159.0-alpha.3` parsed the generated stdio
  configuration and seven-tool read allowlist using `mcp get --json` in an
  isolated `CODEX_HOME`; uninstall restored the original bytes. This did not
  launch an MCP server in Codex, open credentials, make a model request, or
  prove project trust/effective configuration or desktop UI activation.
- Existing custom protection is not silently rewritten: macOS ACLs/xattrs/BSD
  flags and Windows custom DACLs/SACLs/special attributes are refused. Missing
  metadata permissions also block edits. In particular, Windows audit metadata
  may be unreadable to ordinary users; the installer does not elevate, relax
  protection or offer a bypass. Native Keychain/DPAPI access, actual Codex launch,
  macOS metadata commands and Windows ACL/ReplaceFile behavior remain required
  acceptance checks. An unconfirmed Windows replacement retains its protected
  candidate for manual recovery, without an automatic retry.

No live user Codex configuration, protected profile, LINE account/session or
gateway grant was changed. No real LINE read/send/login, credential enrollment,
merge, release or workflow activation was performed. The branch is published as
[draft PR #19](https://github.com/ryantsai/LineBridge/pull/19) for independent review.
See [CODEX.md](CODEX.md)
for the official Codex contract, supported command flow and local/cloud limits.

# Central OpenChat sync and official LineJS migration - 2026-10-07

Isolated Windows x64 development branch based on main `5f66ee9962a9f764e0d6b902375dedb812a21ca2` (v0.7.10). These are synthetic checks of the proposed code, not a released version or live LINE reception evidence.

- Official upstream: GitHub `evex-dev/linejs` stable tag v3.4.2 resolves to `ef6c3d9f70dd41fa51053615d47f071f58cf8db3`; official JSR metadata reports 3.4.2. `@evex/linejs` uses the exact JSR npm alias and lockfile tarball integrity. The upstream MIT notice omitted from JSR's npm archive is retained in the distribution.
- Full Node suite: **337 tests passed**, with no skips (the initial `3f7f912` review head passed 334). New coverage includes account-feed scope, bounded room hydration, baseline/backfill, durable room/account ACK failure and restart replay through encrypted SQLite, ordering/deduplication, selection cancellation, account Retry-After, safe HTTP/body diagnostics, real SDK plain/LEGY deadlines, existing token/key/cursor compatibility, and prevention of automatic key enrollment. Actual private worker tests cover overlapping monitor replacements, pending durable ACKs, and cancellable login.
- Independent review regressions: nonempty account continuation pages cannot renew untouched rooms before catch-up; real room hydration preserves its own success. Encrypted LEGY responses with outer HTTP 200 and inner 429/503 are rejected before Thrift parsing, preserve Retry-After, and cannot ACK a successful poll. A separate pinned-SDK test reproduces the documented token-refresh timeout reduction from 180 to 30 seconds; no overall refresh-chain deadline is claimed or patched in this change.
- Talk checks verify 250 ms rearm after durable success, bounded anti-spin on rapid valid empty pages, recovery after an operation-bearing or held response, and a separate 180-second request deadline. Square checks verify quiet decoded empty polls as successes; malformed/zero-byte HTTP, pending requests and incomplete catch-up do not become healthy empty polls.
- JavaScript syntax, HTTP with the official MCP client, fresh npm archive installation, and Windows portable build/smoke passed. Portable smoke used an extracted path containing spaces/Unicode and no Node/npm on PATH; it checked the bundled runtime and worker, scoped CLI access, synthetic sends, archive persistence and shutdown. npm validation used checksum-verified npm 11.6.0 in an isolated tool directory. Native macOS builds were not run.
- The installed application, existing credentials/data and live LINE sessions were not changed or used for these checks. No real messages, key registration, grant changes, release, merge or workflow run occurred. GitHub Actions remained disabled. The roughly 110-second live Talk failures remain unexplained by the prior sanitized evidence; these tests do not establish that migration fixes them.
- Traffic/recovery limits are documented in [CLI.md](CLI.md#central-openchat-sync-and-recovery): a default of 15 seconds with jitter can increase total quiet requests for a small room count, account notifications still need selected-room hydration, a failing room stalls its account batch, and five-minute reconciliation is subject to backlog/delay and LINE retention. Existing saved intervals, including 60 seconds, are preserved. A future approved installation still requires checking authenticated scope and every stream using its actual freshness fields.

# Windows operational validation - 2026-10-06

Documentation baseline: main `c8fa570bebf4fa1000e2f0b63ee7525fbcf0aaf0`, official v0.7.9. These anonymous observations are bounded evidence, not a guarantee for other accounts or versions. Production identifiers, credentials, message contents and logs are deliberately omitted.

- Official Windows x64 bundle: release asset SHA-256 and build metadata checked; installed CLI version/help and authenticated profile scope verified. Existing data, protected profile and durable send ledger were preserved during upgrade. A merge, published release, installed CLI and running gateway are separate versions to check.
- Reception: all four configured streams had completed durable successes within the returned `staleAfterMs` at the verification instant. This is point-in-time receiver evidence, not continuous uptime or proof every possible chat receives messages. Empty completed polls count; pending polls alone do not prove success or failure. Use each installed version’s actual fields and threshold.
- OA text: one approved v0.7.8 attempt failed before dispatch during capability preparation. After the narrow LINE_AT capability fix, one newly authorized v0.7.9 text intent returned `accepted_by_line` and a message ID, with transport protection. No receipt/read claim is made.
- Flex: one approved v0.7.8 minimal bubble to an OA recipient was explicitly refused with `INCOMPATIBLE_APP_VERSION`; durable state was rejected and no message ID was returned. No retry/fallback occurred. Successful rendering remains unverified; this is not evidence that every recipient rejects Flex. The v0.7.9 CLI still maps this HTTP 502 class to exit 8; see [diagnosis](CLI.md#send-outcome-evidence-and-current-limitation).
- Group E2EE: a read-only `NOT_FOUND` investigation remains unresolved; another key lookup alone did not prove a send. No forced registration, reset or group send was used as a repair.
- Image download/interpretation and successful live Flex rendering remain unverified. The synthetic suite passed 298 tests at v0.7.9; mocks are not live transport or rendering evidence.

The records below are historical validations of their named versions and do not replace current installed-version checks.

# LineBridge validation history

## 2026-10-05 portable tray migration

- Removed the Tauri/Rust app, installer builds, and desktop release pipeline. Portable Windows/macOS bundles now build small native tray launchers; Linux support was subsequently removed from portable targets, release plans, npm platforms, and CI; Windows and macOS remain supported.
- Verified Windows native launcher/controller IPC from an extracted bundle with spaces/Unicode in its path and no Node/npm on PATH. It attached to an existing service, reported the verified custom admin URL, quit without stopping reception, and separately started and gracefully stopped a detached synthetic service. The smoke mode does not display the icon or launch a browser.
- The full unit suite passed, followed by targeted tray checks including crash-metadata recovery. JavaScript syntax, HTTP/official MCP service smoke, and portable package smoke passed. All accounts and sends used by these checks were synthetic.
- Fixed Express 5 listen error handling: occupied admin/gateway ports must fail startup rather than publish false readiness. Tests verify both port conflicts, preservation of the existing listener, and retry after release. Ports are not automatically reassigned.
- macOS AppKit/Swift implementation and packaging are included in native CI, but compilation, signing and GUI behavior have not been verified from this Windows host.

## Earlier desktop runtime validation (historical)

Verified locally on macOS Apple Silicon, 2026-10-03 (Asia/Taipei):

- Desktop preparation and packaging completed without Go installed. The delivered app's executable directory contains only `LineBridge`, `node` and `cloudflared`.
- JavaScript syntax checks, all **112 tests**, HTTP/official MCP service smoke, and Rust formatting/build checks passed. A regression test verifies that retired saved providers fall back to local access without starting a connector or losing Cloudflare named-tunnel settings.
- `npm run verify:macos` mounted the delivered DMG read-only and passed checksum, strict signatures, native architecture and helper-version checks, private worker startup, scoped authentication, multilingual archive search, encrypted persistence across restart, restored monitoring and owned-process shutdown. All accounts and sends were synthetic.
- Artifact: `release/macos-arm64/LineBridge_0.6.2_aarch64.dmg`, SHA-256 `e5824cce7a313cd3fe61acd21bcdc59c827ab287083ff1f2bd8f8adbebd48ef1`. This is a local build; the previous release's Windows/Intel results below do not verify this artifact on those platforms.

# LineBridge 0.6 portable Node bundle validation

Verified locally on Windows x64, 2026-10-03 (Asia/Taipei):

- `npm run package:portable` produced a Windows ZIP containing checksum-verified Node 26.5.0, bundled CLI/service/private worker, dashboard, documentation and licenses. Node/npm installation is not required on the target PC.
- `npm run test:portable` passed from an extracted folder outside the checkout, with spaces, Unicode and `!` in its path and an empty executable PATH. Checks cover launcher version/help/exit codes, the private worker, Windows DPAPI startup, scoped authentication, file/stdin sends, replay, search/read/events, persistence across restart and graceful stop. All accounts/messages were synthetic; no LINE or tunnel connection was started.
- JavaScript syntax and all **78 tests** passed. The shared desktop bundling command also completed. Native macOS/Linux portable builds have CI jobs but have not been run from this Windows session. Private-repository Linux ARM64 CI needs an available runner configured via `LINEBRIDGE_LINUX_ARM64_RUNNER`.
- The portable bundle retains the runtime next to the app; it does not register autostart or install a system service. Existing user data remains outside the release folder. This work does not publish a release or rebuild/sign the desktop installers.

# LineBridge 0.6 provider validation

Verified on 2026-10-03 (Asia/Taipei). Added ngrok and Tailscale Funnel to the separate cloud connection page, with local encrypted ngrok token storage and cloud AI probe instructions.

- JavaScript syntax, **56 tests** and HTTP/official MCP integration passed on Windows Node 26.5.0. New tests cover encrypted ngrok tokens, URL validation, Funnel route conflicts and ownership, authorization and pinned download rejection.
- Live Funnel passed token enforcement, scoped HTTP/MCP, multilingual archive search, admin isolation and process cleanup using a public DNS resolver and TLS hostname verification, and removed only its newly created port-443 route. The existing private port-8443 route remained unchanged.
- Official ngrok 3.39.11 download, SHA-256 verification, extraction, reported version and YAML configuration validation passed. The real ngrok endpoint requires the user to enter their Authtoken locally; it has not yet been claimed as live-verified.
- The dependency-free cloud probe passed anonymous and authenticated checks against a synthetic service: health, token enforcement, admin isolation and all six MCP tools. The provider form was inspected in an isolated browser session, including Funnel's default port 443 and ngrok's password field. [Connection form preview](design/connections-ngrok.jpg).
- Rust formatting, its Windows path regression and Clippy passed. The 0.6.0 NSIS installer built and installed successfully; native startup, encrypted multilingual search across restart and owned-process shutdown passed. The installed app preserves all 6 accounts and 3 tokens, preserves the enabled monitoring preference and retains the existing private Tailscale route. Read-only counts confirm the original messages/index remain intact.
- [Portable verification](https://github.com/ryantsai/LineBridge/actions/runs/37081141679) passed all 56 tests, HTTP/MCP integration and archive validation on Node 24/26 across Linux and Windows at commit `3887757`.
- [Native installer verification](https://github.com/ryantsai/LineBridge/actions/runs/37081141673) passed Windows x64 NSIS and both Mac DMGs at that same commit. All three checked native startup, scoped authentication, encrypted multilingual archive persistence, restored monitoring preferences and shutdown. Mac checks additionally verified the delivered DMG checksum, signatures and native helper versions/architectures.
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
