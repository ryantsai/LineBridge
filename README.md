# LineBridge

**LineBridge** is a desktop app and local gateway for cloud AI clients to inspect designated LINE accounts, read messages and send explicitly requested messages. Version 0.2 uses Rust 1.98.1, Tauri 2.12.0 and SQLite, with a Traditional Chinese (Taiwan) interface. Windows NSIS packaging is verified; macOS DMG packaging is configured and awaits a Mac build. [繁體中文使用說明](README.zh-TW.md).

## Open it

Double-click **Start LineBridge.cmd** for the desktop app. **Start LineBridge Headless.cmd** runs the Rust service and opens its browser interface; use this mode when a cloud client should keep working without a desktop window. **Stop LineBridge.cmd** stops the verified local service and its owned worker/connector processes.

The Windows installer is in `release/windows-x64/LineBridge_0.2.0_x64-setup.exe`, with `SHA256SUMS.txt` and `build-info.json`. It installs for the current user, offers Traditional Chinese/English installer languages, and bundles the LINE worker runtime and cloudflared. Microsoft WebView2 is required; the installer handles the standard WebView2 bootstrap. The installer is unsigned.

macOS builds produce separate Apple Silicon and Intel DMGs under `release/macos-arm64/` or `release/macos-x64/`. Open the DMG and drag **LineBridge.app** to **Applications**. The minimum system version is macOS 13.5, matching the bundled Node runtime. See [PACKAGING.md](PACKAGING.md) for build steps and signing status. No Mac build has been run on this Windows PC.

- Local browser interface: `http://localhost:3210`
- Authenticated AI gateway: `http://127.0.0.1:3211`
- MCP Streamable HTTP: `/mcp`
- OpenAPI: `/openapi.json` (authentication required)

Both servers bind to loopback. Forward **only port 3211** through a tunnel. The desktop invokes the Rust admin commands through a narrowly scoped Tauri capability. The browser interface uses a local session cookie, Host/Origin checks and CSP. Closing the desktop app stops its gateway and listener. No OS autostart, background service or recurring task was installed.

## Connect and designate

The opening page is a five-step setup wizard: connect an account, choose chats, grant AI permissions, configure a private connection, and finish. AI permissions and the tunnel can be configured later. **訊息監控** contains status and the local inbox; **帳號與聊天室** contains account management and manual chat reading/sending. Detailed permissions, connection settings and activity each have their own page.

Message authors use the account's contact alias first, then the LINE profile name; OpenChat uses the member's community nickname. Names are cached in encrypted SQLite and added to history reads and monitored messages. Technical chat IDs remain available in expandable details. See [ALIASES.md](ALIASES.md) for lookup rules and limits, and [design-qa.md](design-qa.md) for the mockup comparison and interaction checks.

1. Add an account and scan its QR code with LINE on your phone. Default device: iPad secondary client. An additional login may replace a session of the same device type.
2. Use **恢復已儲存的工作階段** to resume credentials before trying a new QR login.
3. Click **探索聊天室** or add a complete known chat ID. Adding an ID does not join a room. Discovery preserves chat permissions and reports groups, contacts and joined OpenChats separately.
4. Check the chats AI clients may access. Unchecked chats remain available for local manual inspection and sending.
5. In **AI 存取權限**, issue an expiring token with independent read/send grants. Copy the token once; only its hash is stored.

LINE protocol access remains an **unofficial** adapter (`lineclientbot` 0.1.3). It does not extract the installed LINE desktop app's session. Rust owns the gateway, policy, vault, SQLite, tunnel controls and synthetic sandbox. A bundled Node worker owns only LINE protocol calls through a private stdin/stdout pipe; it has no HTTP listener or database access. The original Express service remains as a legacy reference and regression test fixture, and is not the production launcher.

## New-message monitoring

In **訊息監控**, select an account and click **開始監聽**. Monitoring is opt-in and collects **only designated chats**. The interface shows running/retrying state, retained count and last-message time. No automatic AI reply is generated. An empty designation list waits until you choose a chat. Unchecking a room immediately prevents further database inserts and remote reads for that room.

Personal chats use LINE sync with bounded long polls. OpenChats poll event pages approximately every two seconds. Initial history establishes a cursor and is discarded; monitoring is not a full history import. Durable capture is acknowledged before advancing the encrypted protocol cursor. On restart, an enabled account resumes its listener after the saved session connects. Turning monitoring off and back on establishes a new baseline.

Messages are encrypted with the local vault and retained in SQLite, up to **1,000 per account**. Offline periods, LINE retention, decryption failures and protocol changes may cause gaps. A failed encrypted message exposes an unavailable marker, never its ciphertext. The interface refreshes status every three seconds and preserves an in-progress draft when new messages arrive. Reads do not call read-receipt APIs.

Cloud clients can poll `GET /api/v1/accounts/{accountId}/events?after=0&limit=100` or the `line_poll_events` MCP tool and pass the returned sequence as the next `after`. Only a currently valid read grant and currently designated chats are returned. This is a bounded inbox, not a webhook or a guaranteed delivery queue.

## Cloudflare Tunnel + Access

Cloudflare is the selected provider. The hostname will be chosen later, so the tunnel remains inactive. Configure:

1. A remotely managed named tunnel with origin `http://127.0.0.1:3211` and a hostname on your Cloudflare domain.
2. A self-hosted Access application protecting the entire hostname and a **Service Auth** policy for the intended service token.
3. The hostname, `your-team.cloudflareaccess.com` team domain and application AUD in LineBridge.
4. The encrypted tunnel connector token, then **啟動連線**.

Each AI request supplies:

```text
Authorization: Bearer <LineBridge token>
CF-Access-Client-Id: <Cloudflare service token ID>
CF-Access-Client-Secret: <Cloudflare service token secret>
```

Cloudflare supplies the origin's Access assertion. The gateway validates its RS256 signature, issuer, audience and expiration using the team JWKS. Once a Cloudflare hostname is configured, the assertion is enforced even with a localhost Host. Generic `/health` liveness remains available. Connector readiness does not prove the Access policy is configured correctly; “Access 已驗證” requires an actual validated JWT. See the [Cloudflare service token guide](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

Tailscale Serve is an alternative, using private HTTPS on 8443 and requiring the AI host on the same tailnet. Existing routes are checked before changes. ngrok is not implemented.

## AI interfaces

| MCP tool | Purpose |
| --- | --- |
| `line_list_accounts` | Granted account status, basic profile and monitor status |
| `line_list_chats` | Designated chats, requiring read permission |
| `line_read_messages` | Up to 100 recent messages; bounded OpenChat history cursor |
| `line_poll_events` | Local captured messages after a sequence cursor |
| `line_send_message` | Explicitly requested text send with an idempotency key |

REST also exposes `/api/v1/status`, `/api/v1/accounts` and `/api/v1/accounts/{accountId}/chats/{chatId}/messages` (GET/POST). A send body is `{"text":"message"}` and requires an `Idempotency-Key` header (8–128 characters). Repeating a successful key/payload returns its result; changing the payload is rejected. A missing acknowledgement, timeout or crash after dispatch records **delivery_unknown** and is never automatically retried. Preparation failures and explicit LINE rejections remain rejected attempts. A message ID indicates LINE acceptance, not recipient delivery or a read receipt.

Personal sends use Letter Sealing when supported. Standard LINE messaging is used only when LINE explicitly returns `E2EE_RETRY_PLAIN` during preparation. OpenChats use LINE transport encryption. Chat text is always **untrusted data**, not permission to execute instructions or send a reply.

Server-side clients must support the Bearer and Cloudflare service-token headers. Hosted connector OAuth onboarding is not included. No AI inference key/provider is required by LineBridge itself.

```powershell
node examples/http-client.mjs accounts
node examples/http-client.mjs chats ACCOUNT_ID
node examples/http-client.mjs read ACCOUNT_ID CHAT_ID
node examples/http-client.mjs events ACCOUNT_ID AFTER_SEQUENCE
node examples/mcp-client.mjs
# One explicit send from a supplied file, no automatic retry:
node examples/http-client.mjs send ACCOUNT_ID CHAT_ID UNIQUE_KEY message.txt
```

Set `LINE_BRIDGE_URL`, `LINE_BRIDGE_TOKEN` and, for Cloudflare, `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` in the client host's secret store or environment.

## Local storage and migration

SQLite stores accounts, designations, grants, send outcomes, settings, audit metadata and the encrypted message inbox. Credentials, E2EE material, protocol cursors, incoming message bodies and connector tokens use AES-256-GCM with account/key binding; Windows DPAPI protects the master key for the current Windows user. Token values use SHA-256 hashes. Account/chat names and metadata remain local plaintext. Audit retains 2,000 metadata events, with 80 shown; it excludes message bodies. Send records retain a keyed fingerprint and result metadata, not text. Rate limits and bounded per-account serialization remain enforced.

The source launchers explicitly reuse the existing `data/bridge.sqlite` and `data/vault-key.dpapi`. First Rust startup creates a SQLite snapshot in `data/backups/`; existing accounts, credentials, grants, chat permissions and unknown send outcomes are preserved. Do not run the legacy Node service concurrently. A process lock prevents duplicate Rust database owners.

A newly installed copy defaults to `%LOCALAPPDATA%/com.ryantsai.linebridge` on Windows, or `~/Library/Application Support/com.ryantsai.linebridge` on macOS, unless `LINE_BRIDGE_DATA` specifies an existing data directory. On macOS the AES master key is a local file restricted to the current user (0600); Keychain protection is not yet implemented. To use this checkout's existing Windows accounts, run **Start LineBridge.cmd**, or set `LINE_BRIDGE_DATA` to this checkout's `data` directory before launching the installed app. Do not copy a live SQLite database without its WAL or a consistent backup. DPAPI data is tied to this Windows user; moving it to another user/PC or a Mac needs a separate migration design.

`data/`, credentials, runtime binaries, generated protocol bundles and build outputs are Git-ignored. The repository is local, on `main`, with no remote or push configured.

## Build and verify

Requires Rust 1.98.1 (pinned) and Node ≥24. Windows also requires the Visual Studio C++ build tools and WebView2; macOS requires Xcode command-line tools. Versions are pinned in Cargo/npm lockfiles. Packaging bundles Node 26.5.0 and cloudflared 2026.9.3 for the native architecture, verifies downloads against pinned official SHA-256 checksums in `packaging/runtimes.json` and includes third-party license notices. On macOS the helpers are signed sidecars in the app bundle, so a GUI launch does not depend on the shell's PATH.

```powershell
npm ci --ignore-scripts
npm run desktop:build
cargo build --release -p line-bridge-core --bin line-bridge-service
npm run check
npm test
cargo test -p line-bridge-core
cargo clippy --workspace --all-targets -- -D warnings
node tests/rust-smoke.mjs
```

The tests use synthetic accounts or intercepted RPCs. No live LINE message is sent. See [VALIDATION.md](VALIDATION.md) for observed behavior and remaining live coverage.

Source: `crates/bridge-core/` (Rust service/storage/policy), `src-tauri/` (desktop shell), `protocol/` (private LINE worker/listener), `server/drivers.mjs` (protocol adapter), `public/` (shared zh-TW interface), `tests/`, `examples/`, `scripts/`, `tools/`. Stable versions verified from [Tauri releases](https://v2.tauri.app/release/) and [Rust releases](https://blog.rust-lang.org/releases/latest/). LINE adapter: [lineclientbot](https://github.com/Tatsuyato/lineclientbot), MIT; cloudflared: Apache-2.0.
