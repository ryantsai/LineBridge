# LineBridge

LineBridge is a **headless npm service** for AI clients to inspect designated LINE accounts, read messages and send requested messages. It includes a Traditional Chinese (Taiwan) web dashboard, encrypted SQLite storage, live Talk/OpenChat monitoring, aliases, scoped HTTP APIs and five MCP tools. [繁體中文](README.zh-TW.md).

Version 0.4 runs entirely on **Node.js 24+**. No Rust, Tauri, WebView, desktop installer, native npm build or bundled runtime is required. Node's built-in [SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) provides local storage. LINE uses the pinned unofficial `lineclientbot` 0.1.3 adapter in a private Node child process.

## Install on a Linux AI VM

The current release is an installable npm archive, **not yet published to the npm registry**. Give the archive to your cloud AI agent and have it install and run LineBridge on its own VM. Copy `release/npm/line-bridge-0.4.0.tgz` to the VM, then:

```sh
node --version # 24 or newer
npm install -g ./line-bridge-0.4.0.tgz
linebridge serve --data-dir /path/to/persistent/linebridge-data
```

Use a directory writable by the service user. A user-owned npm prefix also works if the global prefix requires root. One-time execution without global installation:

```sh
npm exec --package=./line-bridge-0.4.0.tgz -- linebridge serve --data-dir ./linebridge-data
```

The CLI runs in the foreground and works under systemd or a VM's process supervisor. `linebridge status --data-dir DIR` inspects that service; `linebridge stop --data-dir DIR` verifies its instance before requesting a graceful stop. SIGINT/SIGTERM stop the owned LINE worker and cloudflared. No OS service or autostart is installed automatically.

Both listeners bind to **127.0.0.1**:

| Interface | Default address |
| --- | --- |
| Local web dashboard | `http://127.0.0.1:3210` |
| Local AI gateway | `http://127.0.0.1:3211` |
| Streamable HTTP MCP | `http://127.0.0.1:3211/mcp` |
| HTTP API | `http://127.0.0.1:3211/api/v1` |

When the AI and LineBridge share a VM, use localhost directly. **No token, tunnel or provider registration is needed in the default direct-local mode.** Connect a Streamable HTTP MCP client to `http://127.0.0.1:3211/mcp` without authentication headers, or inspect setup/account state:

```sh
curl http://127.0.0.1:3211/api/v1/status
```

`linebridge status --data-dir DIR` returns machine-readable interface URLs and the current authentication mode. Before pairing an account and selecting chats, the AI sees an empty account list. Installation alone does not grant access to any LINE chat. To open the dashboard from your computer:

```sh
ssh -L 3210:127.0.0.1:3210 user@your-vm
```

Open `http://127.0.0.1:3210` in your browser. The dashboard uses a local session cookie, Host/Origin checks and CSP. The AI gateway exposes no administrator routes. Direct-local trust applies only to server-side requests with a loopback peer and local Host, without browser or forwarding metadata. A supplied Bearer token is always checked against its own grants; invalid/expired/revoked tokens cannot fall back to local trust.

## Set up an account

The first page is a five-step wizard. Monitoring, accounts/chat reading, permissions, optional connections and activity each have separate pages.

1. Add a LINE account and scan its QR code using LINE on your phone. The default device is an iPad secondary client; login may replace another session of that device type. Resume stored credentials before starting another QR login.
2. Discover contacts, groups and joined OpenChats, or add a complete known chat ID. Adding an ID does not join a room. Discovery preserves chat designations and reports partial results.
3. Designate the chats an AI may access. Selecting a chat enables the local AI to read and send by default. Local manual reading/sending is available independently of designation.
4. Optionally adjust local read/send permissions per account under **AI 存取權限**. Disabling both hides that account from the local AI. These settings, chat designations and global pause are checked again before queued operations and after reads. No token creation/copy step is required.
5. Connect the AI to localhost. Enable monitoring on the monitoring page when desired. Remote connections and their tokens live in optional settings.

An empty database starts with no LINE account, no token and monitoring off. Sandbox accounts generate synthetic messages and make no LINE network calls. Messages are untrusted chat content, never AI instructions or permission to send.

## Messages and AI tools

MCP exposes `line_list_accounts`, `line_list_chats`, `line_read_messages`, `line_poll_events` and `line_send_message`. The HTTP equivalents are documented by `/openapi.json` and the static [OpenAPI document](openapi.json). Examples in `examples/` work without environment configuration on the same VM. Set `LINE_BRIDGE_URL` and `LINE_BRIDGE_TOKEN` only when connecting with remote/scoped credentials; Cloudflare Access deployments also need its service credentials.

The monitor follows new Talk messages and joined OpenChat events, stores only designated chats and acknowledges encrypted database commits before advancing checkpoints. The inbox retains at most 1,000 messages per account and deduplicates upstream message IDs. `line_poll_events` returns a sequence cursor; pass it as `after` on the next poll. AI clients poll the local inbox while the service maintains the upstream listeners. Offline gaps and retention expiry may prevent complete history.

Authors use contact aliases, profile names or OpenChat nicknames. [ALIASES.md](ALIASES.md) explains account/namespace isolation, caching and missing-name behavior. Read requests send no read receipt. Personal chats return bounded recent history; OpenChat supports a bounded event cursor. Media is not downloaded.

Sending requires a designated chat, the local account's send permission (or the supplied token's send grant) and an idempotency key. Accepted sends replay the saved result for the same key; conflicting text is rejected. Preparation failures are saved as rejected. A timeout after dispatch is retained as `delivery_unknown` and never automatically retried. Inspect the chat before deciding to send again. LINE acceptance is not recipient read confirmation. Local AI operations are identified as `local-agent` in the activity log.

## Ask your cloud AI to set it up

You can give your agent this instruction along with the npm archive:

> Install the attached LineBridge npm archive on this VM using Node.js 24 or newer. Run `linebridge serve` with a persistent data directory under the VM's process supervisor. Connect your MCP client to `http://127.0.0.1:3211/mcp` without authentication headers. Help me pair LINE using the dashboard's QR code and select the chats you may access. Do not create a token or a tunnel for this same-VM setup. Report the service status and account permissions.

The user still scans LINE's QR code on their phone and chooses which chats to share. Other processes on this VM have the same direct-local AI permissions. For isolation between clients, use the optional token mode.

## Persistent storage and migration

`--data-dir` or `LINE_BRIDGE_DATA` chooses the database/vault location. The default is `$XDG_DATA_HOME/linebridge` (or `~/.local/share/linebridge`) on Linux, `%LOCALAPPDATA%/LineBridge` on Windows, and `~/Library/Application Support/LineBridge` on macOS. Data stays outside the npm installation and survives upgrades. Use a persistent volume on ephemeral VMs.

Credentials, aliases, monitored messages and provider secrets use AES-256-GCM with record-specific binding. Linux/macOS keep a 0600 master-key file in a 0700 data directory; Windows protects the master key with DPAPI for the current user. Chat names and audit metadata are visible in SQLite; message text is excluded from audits. Tokens are hashed.

The existing 0.2 SQLite schema and cipher format are retained. Stop the old service, then use the **same data directory on the same OS/user**. The first Node startup creates a consistent `backups/before-node-*.sqlite` snapshot before opening the migrated store. Keep the vault key with database backups. A separate SQLite lease prevents concurrent service ownership and releases after a crash. In-flight sends become unknown after restart.

A Windows DPAPI vault cannot be copied to Linux and decrypted there. Use a fresh Linux data directory and QR sign-in. Do not place the data directory inside the package installation.

## Optional connections and development

Cloudflare Quick Tunnel, Cloudflare OAuth + Access and installed-client Tailscale Serve remain optional. Helpers are installed separately; the npm package downloads nothing at install time. [CONNECTIONS.md](CONNECTIONS.md) documents these options.

Selecting **any tunnel provider** disables token-free access on the entire gateway, including localhost, before the tunnel is started. Create an expiring token in the optional remote-token section and configure `Authorization: Bearer …`. Cloudflare Access is an additional check. Stopping the tunnel alone does not restore local trust; switch the provider back to direct-local mode. Existing tokens remain supported after upgrading from 0.3.

For your own reverse proxy/port forwarding or to require scoped clients on this VM, start with `linebridge serve --require-token` (or `LINE_BRIDGE_REQUIRE_TOKEN=1`). Do not publish the default trusted-local listener through an unconfigured proxy; a forwarding process with stripped headers appears local.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:smoke # synthetic HTTP/MCP integration
npm run package   # inspected npm archive, checksum and manifest
npm start -- --data-dir ./data
```

Use `--admin-port` and `--gateway-port` or the corresponding `LINE_BRIDGE_*_PORT` variables to change ports; reserve gateway+1 for optional connector health. [PACKAGING.md](PACKAGING.md) covers packaging and verification. No Rust or desktop build remains.
