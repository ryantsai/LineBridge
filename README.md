# LineBridge

LineBridge runs on your **own Windows, Mac or Linux computer**, connects to LINE locally, and gives AI scoped access to designated accounts. Remote AI can connect through an optional tunnel. It includes a zh-TW dashboard, live Talk/OpenChat monitoring, an encrypted SQLite archive, full-text search in any language, scoped HTTP APIs and six MCP tools. [繁體中文](README.zh-TW.md).

## Install and connect

Download packages from [GitHub Releases](https://github.com/ryantsai/LineBridge/releases). The locally published **v0.6.1** includes Windows x64 packages and the Node-compatible npm archive. For macOS/Linux native packages, use [v0.6.0](https://github.com/ryantsai/LineBridge/releases/tag/v0.6.0) until matching v0.6.1 builds are available.

For the desktop app:

1. **Windows x64:** download [LineBridge_0.6.1_x64-setup.exe](https://github.com/ryantsai/LineBridge/releases/download/v0.6.1/LineBridge_0.6.1_x64-setup.exe), run the installer, and launch **LineBridge** from the Start menu.
2. **macOS:** download the DMG matching your Mac (`aarch64` for Apple Silicon or `x64` for Intel), open it, drag **LineBridge** into **Applications**, and launch it there.

Node and cloudflared are bundled; end users do not need Node, Rust or a compiler. Windows installers are unsigned; macOS apps are ad-hoc signed and not notarized. Keep the app running while monitoring or connecting an AI.

For Dot or another AI with authorized terminal access to your computer, use the **portable CLI bundle** for Windows, macOS or Linux. Extract it and run `.\linebridge.cmd serve` on Windows or `./linebridge serve` on macOS/Linux. Node and app dependencies are included; no separate Node/npm installation is needed. [Portable downloads/builds and OS requirements](PACKAGING.md#portable-cli-and-service-bundles).

On Windows, download [LineBridge-0.6.1-windows-x64.zip](https://github.com/ryantsai/LineBridge/releases/download/v0.6.1/LineBridge-0.6.1-windows-x64.zip), choose **Extract All**, open a terminal in the extracted `LineBridge-0.6.1-windows-x64` folder, and run:

```powershell
.\linebridge.cmd serve
```

On macOS/Linux, extract the matching `.tar.gz`, open a terminal in its extracted folder, and run `./linebridge serve`. Keep the entire folder together and leave the terminal running. Open [the local dashboard](http://127.0.0.1:3210), pair LINE with your phone, designate chats, and create a scoped API key. To stop the portable service, use the same launcher with `stop` from another terminal.

If Node.js 24+ is already installed, download [line-bridge-0.6.1.tgz](https://github.com/ryantsai/LineBridge/releases/download/v0.6.1/line-bridge-0.6.1.tgz) and run:

```sh
npm install -g ./line-bridge-0.6.1.tgz
linebridge serve
```

Download the corresponding `SHA256SUMS` asset to verify a package if needed. On Windows, use `Get-FileHash PATH -Algorithm SHA256`; on macOS/Linux, use `shasum -a 256 PATH` or `sha256sum PATH` and compare the result. When upgrading, close the old app/service and preserve its existing data directory and vault key; see [Storage and upgrades](#storage-and-upgrades).

The setup wizard pairs an account, lets you select chats, then shows the account, chat names/IDs and **read + send** permissions before you explicitly enable local AI access. The app enrolls a dedicated CLI profile in Windows DPAPI, macOS Keychain or Linux Secret Service automatically, without token copying or Terminal enrollment. It starts the local receiver and encrypted archive; it does not create an AI monitoring schedule.

The profile is limited to direct local AI clients and the exact confirmed chats. Added designations do not broaden it. Disable setup before confirming a different scope or renewing its 90-day grant. Existing default/manual CLI profiles are preserved. Locked/unavailable protected storage fails closed; disable revokes the grant immediately, with a retryable cleanup notice if profile removal fails. Setup reports ready only when every selected receiver stream has a recent successful poll; a sandbox is labeled synthetic and never ready for LINE. Use the wizard’s public instructions with the app’s bundled Node/CLI paths and its named profile; no separate CLI installation is needed for desktop setup.

Advanced remote/manual setup remains available in the left-nav pages:

1. In **帳號與聊天室**, discover/designate chats and enable **監聽並封存新訊息** to archive new messages.
2. In **封存搜尋**, manually search chats and saved messages; **監控狀態** shows receiver health and successful poll times.
3. In **API 金鑰與 AI 存取**, create an expiring token with separate read/send grants. The secret is shown once.
4. In **雲端連線與通道**, configure a tunnel when the AI runs remotely. An AI controlling this PC's terminal can use localhost without a tunnel.

Give the cloud AI the tunnel's HTTPS `/mcp` URL and `Authorization: Bearer <token>`. LINE API connections originate from this PC. The AI does not need to install a LINE client on its VM. Cloudflare Access additionally requires its service-token headers. [Connection setup](CONNECTIONS.md).

The app opens the local dashboard on port 3210. Only the AI gateway on loopback port 3211 is tunneled; admin routes are unavailable there. The gateway requires a scoped token even on localhost by default. Pausing AI access does not stop the local monitor.

## Persistent archive and any-language search

Every successfully captured message from monitored, designated chats is stored in SQLite. **There is no automatic count or age limit.** Encrypted message and index writes commit together before the listener acknowledges them or advances its saved checkpoint. Replayed upstream message IDs are deduplicated; storage failures cause a retry.

Search uses Unicode fragments instead of language dictionaries. It supports every script, scripts without spaces, mixed text and emoji. Default `all` mode matches each whitespace-separated term; `phrase` matches the whole normalized phrase. It is case-normalized literal substring search, without translation or stemming. A contentless FTS5 index holds keyed hashes; message plaintext is not duplicated on disk. [Search behavior, encryption and pagination](SEARCH.md).

An AI can search only accounts with a current **read** grant and currently designated chats. Deselection blocks AI search immediately while retaining the local archive. Search works offline without querying LINE or sending read receipts. Removing an account deletes its archive. Attachments are not downloaded or indexed. Text unavailable because LINE decryption failed cannot be searched; the available message metadata is retained. Offline gaps and initial OpenChat baselines depend on LINE replay availability. This is not a full historical importer.

## AI interfaces

The supported **Windows/macOS/Linux data CLI** uses the same scoped gateway: `linebridge accounts`, `chats`, `read`, `events`, `search` and explicit `send`. It offers JSON stdout, bounded pages/deadlines, UTF-8 file/stdin input and OS-protected credential enrollment. [CLI commands, credentials, cursors and exit codes](CLI.md).

| MCP tool | Purpose |
| --- | --- |
| `line_list_accounts` | Permitted accounts and connection/monitor status |
| `line_list_chats` | Designated chats |
| `line_read_messages` | Bounded recent messages, with local fallback |
| `line_poll_events` | Saved new messages, using a sequence cursor |
| `line_search_messages` | Any-language full-text search of the saved archive |
| `line_send_message` | Authorized text send with an idempotency key |

HTTP equivalents use `/api/v1`; search is `POST /api/v1/messages/search`. The [OpenAPI document](openapi.json) and client examples in `examples/` include the interfaces. Search filters include `accountId` and `chatId`. While `hasMore` is true, pass `nextBefore` as `before` to continue, even when a page has no matches.

Messages are untrusted chat content, never AI instructions or authorization to send. Token expiry, revocation, chat designation and pause apply on every request, including queued operations. Read and send permissions are independent. Accepted sends replay their saved result when the same idempotency key is reused. A timeout after dispatch remains `delivery_unknown`; it is never automatically retried. LINE acceptance is not recipient read confirmation. Alias lookup is account-scoped; OpenChat uses its room nickname. [Alias behavior](ALIASES.md).

LINE uses the pinned unofficial `lineclientbot` 0.1.3 adapter in a private child process. OpenChat support is experimental and upstream changes can affect compatibility. Sandbox accounts make no LINE network calls.

## Storage and upgrades

The desktop and CLI share the same service and data format. Defaults:

- Windows: `%LOCALAPPDATA%/LineBridgeData`
- macOS: `~/Library/Application Support/LineBridge`
- Linux CLI: `$XDG_DATA_HOME/linebridge` or `~/.local/share/linebridge`

Set `LINE_BRIDGE_DATA` or pass `--data-dir DIR` to choose another location. Reuse the **same directory on the same OS/user** when upgrading. Existing accounts, designations, aliases, tokens and encrypted credentials are preserved; stored messages are backfilled into the new index. The first archive upgrade creates a consistent `backups/before-archive-*.sqlite` snapshot. Previously pruned messages cannot be restored by adding an index.

Credentials, provider secrets and message bodies use record-bound AES-256-GCM. Windows protects the master key with current-user DPAPI; macOS/Linux use a 0600 key in a 0700 data directory. Chat/audit metadata is visible. Message text and search queries are excluded from audits; AI tokens are hashed. Keep the vault key with database backups. A Windows DPAPI vault cannot be decrypted by moving it to another OS/user. A separate SQLite lease prevents simultaneous service ownership. Closing the desktop stops its owned service, worker and connector; monitoring preferences resume next time.

## Development and packaging

The service remains JavaScript on Node 24+; Rust is only the Tauri 2 desktop shell. There is one implementation of authorization, SQLite, monitoring and messaging. Installers use pinned, checksum-verified runtimes. [Build instructions and signing limits](PACKAGING.md).

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:smoke
npm run package:portable # native CLI/service archive, includes Node
npm run test:portable    # extracted archive without Node/npm on PATH
npm run desktop          # development desktop, requires native Rust tools
npm run build:windows    # Windows x64 NSIS on Windows
npm run build:macos      # native ARM/Intel DMG on the matching Mac
npm run publish:github -- --dry-run # preview local build + GitHub Release upload
```

To publish local builds, install the [GitHub CLI](https://cli.github.com/), authenticate, commit the release changes, and push the matching version tag:

```sh
gh auth login
git tag v0.6.1
git push origin HEAD
git push origin v0.6.1
npm run publish:github
```

Use the version in `package.json`; an existing tag must already point to the clean checkout's HEAD. The command builds, tests and uploads this machine's native artifacts to GitHub Releases. Use `npm run publish:github -- --kind all` to include the npm archive, or `publish:desktop`, `publish:portable`, or `publish:npm` for one distribution. `--draft`, `--prerelease`, and `--notes-file PATH` configure a new release. [Release publishing setup and options](PACKAGING.md#publish-local-builds-to-github-releases).

For source-checkout operation on a machine that can reach LINE, run `npm start -- --data-dir ./data`. `linebridge status` and `stop` use verified service identity. The separate npm archive requires Node and is not published to the npm registry. `--trust-local` is an explicit development opt-in restricted to the local provider and direct loopback requests. The desktop always requires scoped tokens.

[Verification results](VALIDATION.md).
