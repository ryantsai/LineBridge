# Cloud connections

Open **雲端連線** in the LineBridge web dashboard. **同一台主機 · 直接連線** is the default: AI clients in the same VM use `http://127.0.0.1:3211/mcp` or `/api/v1` without a tunnel or provider account. Every API/MCP request needs an expiring LineBridge Bearer token; account grants, designated chats, pause and revocation still apply.

For cross-host clients the three optional tunnel providers forward only the AI gateway on loopback port 3211. The administrator interface remains on local port 3210. To manage a Linux VM from your browser, run `ssh -L 3210:127.0.0.1:3210 user@vm` and open `http://127.0.0.1:3210`. No tunnel is needed when the AI and gateway share the VM.

## Quick Tunnel

Install cloudflared separately and make it available on PATH (or set `LINE_BRIDGE_CLOUDFLARED` to its absolute executable path). Select **Cloudflare Quick Tunnel · 免帳號**, then **啟動連線**. cloudflared obtains a temporary `https://….trycloudflare.com` URL without an account or domain. Copy it from the connection panel and append `/mcp` or `/api/v1` in the AI client. Stop closes the owned connector and clears its URL; restarting obtains another URL. Public DNS may need a short time to propagate. No helper binaries are bundled or automatically downloaded by the npm package.

This URL is reachable over the Internet. Authentication comes from the LineBridge token, without Cloudflare Access. Quick Tunnel is for temporary testing, has no uptime guarantee, limits concurrent requests and does not support SSE. LineBridge uses JSON responses for MCP. See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

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
