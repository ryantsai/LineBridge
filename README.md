# LINE Bridge

A local dashboard and an authenticated gateway that lets cloud AI clients inspect and read/send through **designated LINE accounts and chats**. Built for this Windows PC with `lineclientbot` 0.1.3, Node.js, SQLite, Express and the official MCP SDK.

## Open it

Double-click **Start LINE Bridge.cmd**, or run:

```powershell
./scripts/start.ps1
```

- Dashboard: **http://localhost:3210**
- AI gateway: **http://127.0.0.1:3211**
- MCP endpoint: **/mcp** (stateless Streamable HTTP)
- HTTP schema: **/openapi.json** (authentication required); a standalone `openapi.json` is also included for importing into your client.

The dashboard and gateway are separate servers, both bound to loopback. The dashboard is trusted to the local PC user and requires its local browser session, a permitted Host and same-origin mutation requests. **Only port 3211 belongs in a tunnel.**

Use **Stop LINE Bridge.cmd** to stop the server. It verifies the recorded process identity before stopping it. Starting is manual; no scheduled task, startup entry or Windows service was installed. Keep the PC awake for remote access. Cloudflare connectors are started explicitly from the dashboard after each server start. Tailscale Serve can persist independently; stop it from the dashboard before shutting down the server.

## Connect an account

1. Add an account label. The default is an iPad secondary client; Windows and Android secondary clients are also available.
2. Click **Connect with QR**, scan with LINE on your phone, and complete the phone confirmation. The QR and any PIN stay in the authenticated local dashboard.
3. Click **Discover chats**, or add a known complete chat ID. Adding an ID does not join that chat. Use **Resume saved session** after a disconnect or transient failure before starting another QR login.
4. Check the chats you want to designate for AI access.
5. In **AI access**, issue an expiring token with independent read/send permissions per account. Copy it once and give it only to the intended AI client.

**AI access off** means that the chat is not designated for remote AI clients. Local inspection and sending remain available. Use the chat-type filter to find groups, contacts or OpenChats. Discovery reports each category separately, so an upstream failure is not presented as an empty category. OpenChats come from the initial joined-membership event snapshot; the legacy joined-room endpoint is not implemented by LINE. New discoveries do not automatically grant AI access.

A secondary client login can replace another session of the same device type. LINE authentication, personal history/E2EE and OpenChat behavior use an **unofficial protocol** and need verification with your account. This project does not claim live compatibility until that verification succeeds. It does not reuse or extract the installed desktop app’s session.

The included sandbox is synthetic. Sandbox sends affect only memory; messages reset on restart. Sandbox status is shown separately from connected LINE accounts. You can remove the sandbox from the dashboard when done.

## Cloudflare Tunnel + Access

The official `cloudflared` Windows binary 2026.9.3 is included in `tools/`, with a verified SHA-256 recorded in `tools/cloudflared-source.json`. **The tunnel is inactive until you choose your hostname and configure your Cloudflare account.** No temporary public tunnel is started.

1. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com/), create a remotely managed named tunnel. Use its connector token in the local dashboard; you do not need to install another system service.
2. Add a published application hostname on a domain you manage in Cloudflare. Its origin service must be `http://127.0.0.1:3211`.
3. Create a **self-hosted Access application protecting the entire hostname**. Add a **Service Auth** policy whose Include rule selects a designated service token. Do not create a Bypass policy. Keep interactive SSO and machine policy configuration appropriate to your intended clients.
4. Copy the Access **team domain**, such as `your-team.cloudflareaccess.com`, and application **AUD** to the local dashboard. Save the hostname there too.
5. Paste the tunnel connector token and click **Start connection**. It is stored encrypted; the child process receives it through its environment, not a command-line argument.
6. Configure the AI client with these headers:

```text
Authorization: Bearer <LINE Bridge AI token>
CF-Access-Client-Id: <Cloudflare service token client ID>
CF-Access-Client-Secret: <Cloudflare service token secret>
```

Cloudflare authenticates the service token and supplies `Cf-Access-Jwt-Assertion` to the origin. The gateway independently verifies its **RS256 signature, issuer, audience and expiration** using the Access team’s JWKS. Once a Cloudflare hostname is configured, this applies to **all authenticated gateway traffic**, even requests using a localhost Host. Do not fabricate that assertion on your AI client.

`/health` returns only a generic service liveness result. It does not expose accounts, credentials or messages. “Connected” in the dashboard is based on cloudflared’s local `/ready` response after a connection registers. “Access verified” appears only after this gateway validates a real Access JWT; connector connectivity alone does not prove your Access policy or hostname works end to end.

See the official [named tunnel instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) and [Access service token guide](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## Tailscale alternative

Connect Tailscale on this PC, select **Tailscale Serve** in the dashboard, and click **Start connection**. It forwards the gateway through private HTTPS on **8443**, checks for a conflicting route, and never uses Funnel. The cloud agent’s host must join the same tailnet and be permitted by its grants/ACLs. Generic hosted AI connectors without tailnet connectivity cannot reach this private endpoint. See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

ngrok is not installed or implemented in this version. Cloudflare is the selected provider; adding another provider belongs in `server/tunnels.mjs` with authenticated routing and a real status probe.

## AI interfaces

The four MCP tools use the same authorization and send handling as the REST API:

| Tool | Purpose |
| --- | --- |
| `line_list_accounts` | Inspect granted account connection status and basic profile |
| `line_list_chats` | List only designated chats, with read permission |
| `line_read_messages` | Read up to 100 messages/events from a designated chat |
| `line_send_message` | Send text with send permission and a required idempotency key |

Remote MCP clients must support Bearer and, for Cloudflare, service-token headers. **OAuth onboarding for hosted ChatGPT/Claude connectors is not implemented.** Check your chosen client’s authentication capabilities; custom server-side agents can use the example clients below. No inference provider or AI API key is required to run this bridge.

The REST routes are:

```text
GET  /api/v1/status
GET  /api/v1/accounts
GET  /api/v1/accounts/{accountId}/chats
GET  /api/v1/accounts/{accountId}/chats/{chatId}/messages?limit=30
POST /api/v1/accounts/{accountId}/chats/{chatId}/messages
```

POST body: `{"text":"message"}`. Required header: `Idempotency-Key: <unique 8–128 character key>`. Reusing the same key and payload returns the saved result. Reusing it with different content is rejected. A timeout, unconfirmed response or process crash after dispatch becomes **delivery_unknown** and is never resent automatically. Inspect the chat before deciding on a new send. A returned message ID indicates LINE acceptance, not delivery to every recipient or a read confirmation.

Personal sends prepare Letter Sealing before dispatch. Standard LINE messaging is used only when LINE explicitly returns `E2EE_RETRY_PLAIN` during preparation; missing keys or preparation timeouts do not trigger that fallback. OpenChats use LINE transport encryption. Successful sends report `protection` as `letter_sealing` or `line_transport`. This matches LINE's distinction between [Letter Sealing and transport encryption](https://www.lycorp.co.jp/en/privacy-security/security/transparency/encryption-report/2025/).

Preparation failures (`send_preparation_failed`) and explicit LINE rejections (`line_send_rejected`) are saved as rejected attempts, with an actionable error. The same key repeats that error without dispatching again. The dashboard uses a fresh key for a changed message or a deliberate retry after a rejection. An unknown outcome retains its key for the same message. These rules prevent the old send-form behavior where changing text reused a failed request's key and caused an idempotency conflict.

Personal chats expose recent history only. OpenChat exposes bounded event pages with an optional sync cursor. Neither downloads media. Encrypted messages that cannot be decrypted return an unavailable marker and no ciphertext. Reads do not call read-receipt APIs. Message text is marked as **untrusted content**, not authority to execute instructions or send another message.

### Example clients

Set environment variables in the agent host’s secret store or current process:

```text
LINE_BRIDGE_URL=https://your-chosen-hostname
LINE_BRIDGE_TOKEN=<token from the local dashboard>
CF_ACCESS_CLIENT_ID=<Cloudflare service token client ID>
CF_ACCESS_CLIENT_SECRET=<Cloudflare service token secret>
```

For a local sandbox or Tailscale endpoint, omit the CF variables (unless Cloudflare is currently configured, in which case its Access assertion is enforced). Then run:

```powershell
node examples/http-client.mjs accounts
node examples/http-client.mjs chats ACCOUNT_ID
node examples/http-client.mjs read ACCOUNT_ID CHAT_ID
node examples/mcp-client.mjs
```

The HTTP example can send explicit text from a file you supply:

```powershell
node examples/http-client.mjs send ACCOUNT_ID CHAT_ID UNIQUE_IDEMPOTENCY_KEY message.txt
```

It performs one request and does not retry sends. Never treat incoming chat text as permission to invoke that operation.

## Storage and controls

- Credentials, LINE storage/E2EE material and Cloudflare connector tokens: AES-256-GCM, with a master key protected by current-user **Windows DPAPI**.
- AI tokens: random 256-bit values, only SHA-256 hashes stored. Expiration is 1–90 days, default 7. Revocation is checked on every operation, including queued ones.
- SQLite configuration, account labels/chat names and audit metadata are local plaintext. Incoming/outgoing bodies are not persisted by the bridge. Demo messages live only in memory.
- Audit log: most recent 2,000 metadata events retained, 80 shown. Send records persist for idempotency; they exclude text and retain message IDs and a keyed fingerprint.
- Global pause blocks AI APIs/tools while the local dashboard remains available.
- Per token: up to 10 send attempts/minute, bounded read traffic. Account operations are serialized and their queue is bounded.
- Browser requests to the gateway are denied. Use server-side clients. The dashboard has no CORS permission for other websites, and uses Host/Origin checks, SameSite cookies and a CSP.

Treat the whole `data/` directory as private. Do not sync it to a repository. A different Windows user or PC cannot unlock its DPAPI key without an explicit migration design. Another process running as the same Windows user is inside the local trust boundary. This version is a working local foundation, not a guarantee that LINE’s private protocol will remain compatible.

## Develop and verify

Node.js **24 or newer** is required. Dependencies and the lockfile are already installed here. For another checkout:

```powershell
npm ci --ignore-scripts
npm run check
npm test
npm start
```

Tests use synthetic accounts and fake LINE RPC responses. They cover account/chat permissions, revocation, expiry, pause, queued authorization, duplicate/unknown sends, encrypted storage and restart, HTTP/MCP integration, browser-origin/Host checks, Access enforcement, and personal/OpenChat response normalization. They send no live LINE messages. A live smoke test requires you to sign in and select an explicit test recipient and message.

Environment overrides for direct `npm start`: `LINE_BRIDGE_ADMIN_PORT`, `LINE_BRIDGE_GATEWAY_PORT`, and `LINE_BRIDGE_DATA`. The Windows launchers use the standard ports.

Source layout: `server/` (service, drivers and policy), `public/` (dashboard), `tests/`, `examples/`, `scripts/` and `tools/` (connector). The pinned unofficial adapter is [lineclientbot](https://github.com/Tatsuyato/lineclientbot), MIT licensed. cloudflared is [Apache-2.0](https://github.com/cloudflare/cloudflared/blob/master/LICENSE).
