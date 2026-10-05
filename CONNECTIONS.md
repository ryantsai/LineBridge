# Cloud connections

LineBridge runs on your computer and reaches LINE here. An AI controlling this computer's terminal can use the loopback gateway; a remote cloud AI needs a reachable gateway. The portable bundle includes Node and a Windows/macOS tray launcher. Tunnel helpers are optional separate installations available through the dashboard. Scoped, expiring Bearer tokens are required by default, including localhost. Create one under **API 金鑰與 AI 存取**; read grants include archive search, while send grants are independent.

For portable installs, put the chosen official connector on PATH before starting LineBridge, or set its absolute path using `LINE_BRIDGE_CLOUDFLARED`, `LINE_BRIDGE_TAILSCALE` or `LINE_BRIDGE_NGROK`. The ngrok preparation button can also install its verified binary into the data directory. Account binding and local CLI use do not require a connector.

Only gateway port 3211 is forwarded. The administrator interface stays on loopback port 3210. Keep the app running; closing it stops monitoring and its owned connector. Quick Tunnel, Cloudflare Tunnel + Access, ngrok, Tailscale Funnel and installed-client Tailscale Serve are supported.

An unsupported provider saved by an older installation falls back to local access. Choose a supported provider in the dashboard to restore remote access; saved Cloudflare named-tunnel settings remain available.

## Test from the cloud VM

Choose a provider, start it, then click **複製雲端 AI 測試指令**. Give those instructions and a scoped LineBridge token to the cloud AI. A successful connection from this PC does not establish that the VM can reach it. Each VM/network may filter different hostnames, IP addresses or protocols.

The dependency-free `examples/probe-connection.mjs` runs on Node 18+ from the VM. Set `LINE_BRIDGE_TOKEN` in its environment and run `node examples/probe-connection.mjs URL`. It checks DNS, LineBridge health, unauthenticated rejection, scoped API, admin isolation and MCP tool discovery. It does not contact LINE or send messages. Without a token, it checks reachability and unauthenticated rejection only.

## ngrok

Choose **ngrok · HTTPS 公開網址**, click **準備 ngrok 連接器**, and enter the account's **Authtoken** locally. It is encrypted in SQLite and passed through the child process environment; it is not written into YAML, command arguments, audit logs or status responses. The local download checks the pinned archive SHA-256 and version 3.39.11 before installation. Changed downloads are refused until LineBridge's pins are updated. An already installed native ngrok can also be selected with `LINE_BRIDGE_NGROK`.

Optionally enter an account-assigned/custom ngrok domain without a scheme; leave blank for ngrok's default. Start obtains the HTTPS URL from the owned agent. The agent forwards only the gateway; request inspection, stored inspection bodies, remote management and update checks are disabled. AI requests include `ngrok-skip-browser-warning: LineBridge` along with the LineBridge Bearer token. Stop/app exit stops this agent. [ngrok agent configuration](https://ngrok.com/docs/gateway/agent/config/v3).

## Tailscale Funnel

Choose **Tailscale Funnel · HTTPS 公開網址**. It reuses the installed, signed-in client and defaults to HTTPS **443**, which is separate from Serve's default 8443. Ports 8443/10000 can also be chosen. The AI needs no Tailscale client or tailnet membership. Funnel device authorization and HTTPS capability must be available; when approval is needed the app returns the validated Tailscale consent link.

Existing routes on the selected port are never overwritten. An exact matching external route may be reused without claiming ownership; otherwise choose another port. Stop/app exit removes only the matching route created in this run, and refuses cleanup if another process changed it. Private Serve routes on other ports remain intact. Bearer authentication and admin isolation apply to public Funnel traffic. [Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel).

**同一台主機 · 直接連線** is available for local use with a Bearer token. The CLI alone has an explicit `--trust-local` development opt-in restricted to direct loopback, the local provider, and requests without browser/proxy metadata. Services started by the tray enforce tokens. Selecting a tunnel does not grant token-free access, and an invalid supplied token never falls back to local trust.

## Quick Tunnel

Select **Cloudflare Quick Tunnel · 免帳號**, then **啟動連線**. The bundled cloudflared obtains a temporary `https://….trycloudflare.com` URL without an account or domain. Copy it and append `/mcp` or `/api/v1` in the AI client, alongside its Bearer token. Stop closes the owned connector and clears the URL; restarting obtains another URL. Public DNS may need time to propagate. The optional CLI requires cloudflared on PATH or `LINE_BRIDGE_CLOUDFLARED`.

The URL is Internet-reachable; authentication comes from the LineBridge token, without Cloudflare Access. Quick Tunnel is temporary, has no uptime guarantee, limits concurrency and does not support SSE. LineBridge uses JSON MCP responses. See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Cloudflare account sign-in

The OAuth Client ID is a local setting, not bundled with the npm distribution. Existing settings and encrypted grants carry over when the same data directory and vault are reused on the same OS.

Use **連接 Cloudflare** to authorize in the browser. The dashboard opens a browser tab and also shows a login link. The callback is `http://127.0.0.1:3210/oauth/cloudflare/callback` (use the same loopback hostname through the SSH forward when managing a VM). LineBridge verifies a ten-minute, one-use state and PKCE S256 before exchanging the authorization code. OAuth and connector tokens are encrypted in SQLite; the interface exposes status and expiration only. Expired authorization needs another sign-in; automatic refresh is not implemented. An already configured tunnel uses its separate connector token.

To configure a different account or a separately installed copy, register a private client using **Authorization Code**, response **Code**, authentication **None (PKCE)**, and the exact callback above. Save its Client ID under **OAuth 應用程式設定**. Private Cloudflare clients are limited to members of their owning account. A distributable public OAuth application requires a separate verified-domain registration. See [Cloudflare client registration](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) and [OAuth integration](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/).

Required permissions:

| Cloudflare permission | OAuth scope |
| --- | --- |
| Account Settings Read | `account-settings.read` |
| Cloudflare One Connectors Write | `teams-connectors.write` |
| Access: Apps Write | `access-app.write` |
| Access: Policies Write | `access-policy.write` |
| Access: Organizations Read | `access-org.read` |
| Access: Service Tokens Write | `access-service-token.write` |
| Zone Read | `zone.read` |
| DNS Write | `dns.write` |

Scope names follow [Cloudflare's canonical scope catalog](https://github.com/cloudflare/mcp/blob/main/src/auth/derived-oauth-scopes.json).

## Create a protected hostname later

After sign-in, select an authorized account and its domain. Complete Cloudflare Zero Trust organization setup first if the account does not have one. Enter a new full subdomain and click **建立受保護連線**. LineBridge refuses existing DNS records and an existing Access application for that hostname.

Setup creates an Access application, a 30-day service token and Service Auth policy, a remotely managed tunnel, its gateway-only ingress, then the proxied CNAME. Access is installed before DNS. The connector remains stopped until **啟動連線**. If setup fails partway, the interface reports its saved stage; inspect the recorded resources in Cloudflare before attempting another setup. LineBridge does not delete or overwrite existing resources automatically.

**顯示 AI 連線憑證** reveals the service credentials locally in a temporary dialog. Store these on the trusted AI host, together with its scoped LineBridge token:

```text
Authorization: Bearer <LineBridge AI token>
CF-Access-Client-Id: <Cloudflare service token ID>
CF-Access-Client-Secret: <Cloudflare service token secret>
```

Cloudflare supplies an Access assertion at the origin. LineBridge validates its signature, issuer, audience and expiry. The UI distinguishes connector readiness from an actual validated Access request. Service credentials need replacement when their 30-day lifetime ends. **撤銷 OAuth 連線** revokes account API authorization; it does not remove a created tunnel, DNS, Access policy or service token. Stop a connector with **停止**.

Manual configuration of an existing Tunnel + Access application remains available in its disclosure panel.

## Installed Tailscale client

Select **Tailscale Serve · 私人 tailnet**. **連接 Tailscale** reuses the installed client and its saved account. An already connected client needs no browser sign-in. Otherwise LineBridge runs `tailscale up --json --timeout=4s`, preserving existing preferences, and opens only a validated Tailscale login URL if authentication is needed. Device approval is shown separately.

Once connected, **啟動連線** configures private HTTPS Serve on port 8443. The AI host must belong to the same tailnet. The app refuses a conflicting route or Funnel on that port and stops only its own matching route. It does not enable public Funnel. See the [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli) and [Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Verification

Node tests exercise the OAuth code exchange, state/PKCE replay protection, encrypted secrets, provisioning order, DNS conflict refusal and partial failures using a synthetic HTTP transport. HTTP tests cover the loopback callback exception and gateway authentication. `tests/tunnel-smoke.mjs` explicitly starts a disposable Quick Tunnel with a synthetic-only database and checks live HTTPS, token enforcement, inaccessible admin routes, official-client MCP and cleanup.

```powershell
node tests/tunnel-smoke.mjs
```

For a test host whose OS resolver cannot resolve newly issued Quick Tunnel names, the test supports a per-process Cloudflare DNS-over-HTTPS lookup. TLS hostname verification stays enabled and OS DNS settings are unchanged:

```powershell
$env:LINE_BRIDGE_TUNNEL_DOH = '1'
node tests/tunnel-smoke.mjs
Remove-Item Env:LINE_BRIDGE_TUNNEL_DOH
```

The live check on this PC used that option. Named-tunnel provisioning is covered by mocks; the deferred hostname means real DNS/Access provisioning and protected named-tunnel traffic are not yet verified. No live LINE message was sent.
