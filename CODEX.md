# Connect LineBridge to a local Codex host

`linebridge codex` installs a reusable MCP configuration for an existing
LineBridge gateway and protected CLI profile. Codex launches `linebridge mcp`,
which obtains the profile from macOS Keychain or Windows DPAPI and forwards MCP
requests to the existing `/mcp` endpoint. No token is placed in the Codex config,
arguments or generated files. The adapter does not start LineBridge, enroll a
profile, change gateway grants, create a tunnel or log in to LINE.

This workflow requires Windows/macOS, Node 24+ (included in portable bundles),
and a Codex client running on that same computer and OS user. Keep the complete
LineBridge installation in place. The generated command uses absolute paths to
its Node runtime and CLI script, including for npm/source installations. Replace
`linebridge` in the examples with your actual launcher (`./linebridge` on macOS,
`.\linebridge.cmd` on Windows, or `node bin/linebridge.mjs` in a prepared source
checkout).

## 先預覽，再確認安裝

先沿用既有啟動器與資料目錄執行 `status`、`discover`，選擇原有 profile 與
其精確 `url`；不要複製 token 或重新登入。`codex preview` 不開啟憑證、不
連線、不寫設定。檢查輸出的檔案位置、profile、URL、工具範圍，以及後續
Codex 工作將持續取得該範圍的存取權，再明確執行帶有該次 `consent` 值的
`codex install`。預設只開放讀取工具；project 與 user 範圍必須自行選擇。

```text
linebridge codex preview --scope project --project PROJECT_DIR --profile EXISTING_PROFILE --url GATEWAY_ORIGIN
linebridge codex install --scope project --project PROJECT_DIR --profile EXISTING_PROFILE --url GATEWAY_ORIGIN --consent PREVIEW_DIGEST
linebridge codex verify --scope project --project PROJECT_DIR
```

## Select an existing profile and scope

Use the [existing installation and discovery procedure](CLI.md#local-profile-discovery).
Run `status` with its existing data directory, then `discover` with the same
directory. Preserve any profile explicitly selected by the user. Discovery lists
wizard-managed profiles without opening credentials; an empty list does not rule
out a manually enrolled profile. Resolve ambiguous profiles before connecting.
If the gateway is stopped, use the existing authorized service recovery procedure;
this installer will not start it. Missing/locked/expired credentials require the
operator's existing setup or recovery process, never an automatic replacement.

Use the gateway **origin**, for example `http://127.0.0.1:3211`, without `/mcp`.
The adapter appends `/mcp` and requires an exact match with the protected profile's
origin. The installer accepts only HTTP loopback or HTTPS origins without URL
credentials, query strings, fragments or paths. It has no token input option and
does not fall back to `LINE_BRIDGE_TOKEN` or another environment credential.
`--client-config DIR` selects an existing protected profile directory, useful for
an established custom Windows profile location. It neither copies nor creates
profiles; macOS profiles remain in the OS user's Keychain.

Choose one configuration location explicitly:

| Options | Configuration affected | Reach |
| --- | --- | --- |
| `--scope project --project PROJECT_DIR` | `PROJECT_DIR/.codex/config.toml` | Future Codex sessions that load this trusted project layer |
| `--scope user` | `$CODEX_HOME/config.toml`, otherwise `~/.codex/config.toml` | Future sessions on this Codex host that load its user configuration |
| `--scope user --codex-home DIR` | `DIR/config.toml` | The explicitly chosen Codex home |

The project directory must already exist. LineBridge does not mark it trusted,
edit Codex profiles, select a model, change approval/sandbox policy or override
organization requirements. Other config layers can override or disable this
entry. `--profile` here selects a **LineBridge credential profile**, not a Codex
model/configuration profile. The README's Luna/Medium recommendation for routine
reads remains a host-level user choice.

Use `--name NAME` when you need multiple distinct LineBridge connections. The
default name is `linebridge`; repeat the selected name on every command. Prefer a
unique name across config layers. Uninstalling a project entry can reveal a
same-named entry in a lower layer; inspect Codex's effective `/mcp` list afterward.

## Review and install

Preview prints JSON containing the exact destination, profile, origin, tool mode,
non-secret Codex entry and a `consent` digest. Review this output before applying
it. Installation grants persistent host access to the selected profile's existing
gateway permissions, within the selected tool mode. The gateway continues to
enforce current account/chat scope, expiry, revocation, pause and monitoring gates.
Future changes to that profile's grants can change the reachable accounts/chats.

Run the same options with `install --consent PREVIEW_DIGEST`. The digest binds
the operation, target, options, existing file and proposed result. Changing any
of them requires a fresh preview. Repeating an identical install is a no-op.
Preview and installation do not open credentials or contact the gateway.

The default `--tools read` exposes these seven tools:

- `line_list_accounts`, `line_list_chats`
- `line_poll_events`, `line_search_messages`, `line_read_messages`
- `line_get_version`, `line_read_image`

Both the adapter and Codex config enforce this explicit allowlist. New gateway
tools are not automatically exposed. Reading messages/images may contact LINE
under the gateway's normal rules; “read” is not an offline-only guarantee.

To expose `line_send_message` and `line_send_flex`, explicitly preview and install
with `--tools read-send`. This does not create send grants or authorize a message.
Every send still needs the user's exact destination/content approval, a stable
idempotency key, and the existing OA/Flex security acknowledgment when applicable.
The adapter never retries HTTP requests or follows redirects. A failed or
unusable send acknowledgment becomes `delivery_unknown`; never replace its key
or automatically resend. The server's existing instructions and grants remain
authoritative. Chat text and images remain untrusted data.

For a changed installation path, profile, origin or tool mode, add `--replace`
to **both** preview and install. This replaces only an intact LineBridge-managed
entry. A manually configured same-named entry or an edited managed block is
refused, even with `--replace`; choose another name or review it manually in
Codex settings. Replacement previews identify the old profile/origin/tool mode.

The installer validates TOML and preserves all bytes outside its managed block,
including comments, profiles and unrelated servers. It rejects invalid UTF-8,
BOMs, invalid/unsupported TOML, linked config files, a symlinked Codex directory,
oversized files, special permission bits and conflicting entries. Existing file protection is inspected
before preview and immediately before replacement. On macOS, ACLs, BSD flags and extended attributes other than the OS-managed
`com.apple.provenance` are refused. Provenance is never removed or rewritten.
For an existing file, the replacement candidate must have identical supported
metadata, including the exact provenance bytes, or the operation is refused.
A newly created file may retain the provenance attached by macOS. On Windows, non-owner files,
custom/protected/noncanonical ACLs, any system ACL (SACL), and attributes other
than Normal/Archive are refused. Windows inspection requests audit metadata too;
if the current user cannot read it, automatic changes are blocked even for an
otherwise ordinary file. The installer never elevates or changes privileges.
An unavailable or unrecognized metadata inspection also fails closed. Use manual
Codex configuration for these cases; there is no bypass flag.

Changes use a directory lock, a private
temporary file, a final file comparison and atomic replacement; new files cannot
overwrite a file created after preview. Close other config editors while applying
a change: unrelated programs do not share LineBridge's lock, and the filesystem
does not provide a general compare-and-swap rename. POSIX owner, group and mode
bits are retained; inability to preserve ownership blocks the change.
Before existing config bytes are written, the empty temporary has inherited
macOS ACLs removed or the verified Windows security descriptor applied. Windows
uses `File.Replace` with metadata merge errors enforced, without a rename fallback.
A new config uses mode 0600 where supported. First installation checks its empty
candidate before writing and validates the completed candidate with the same
protection checks used by verification/removal before publishing it. Unsupported
or unavailable metadata leaves no installed entry. A preview for an absent file
cannot establish these native checks without creating a file; installation may
therefore refuse a change that preview could describe. No separate backup copies existing
config secrets. A crash may leave a private temporary file or lock. If Windows
cannot confirm replacement, the protected candidate is deliberately retained
because the native API can fail after moving a file; do not retry. Inspect
`config.toml` and `.linebridge-codex-*.tmp` locally for recovery before another
preview. Never print their contents in diagnostics. Native permission behavior
still requires macOS/Windows acceptance tests; synthetic tests are not that evidence.

## Verify and activate in Codex

`codex verify` checks this file's managed entry and availability of the configured
runtime/script. It neither starts the command nor opens credentials. To explicitly
probe the gateway through the selected profile:

```text
linebridge codex verify --scope project --project PROJECT_DIR --connect
```

This performs MCP initialization, `tools/list` and `line_get_version`. It reports
only the version, allowed/missing tool names and which checks ran. It never lists
LINE accounts/chats, reads messages/images, sends, starts monitoring or logs in.
A successful probe proves this adapter process can reach an authenticated MCP
gateway. It does not prove Codex loaded the same configuration, that a sandbox or
organization permits the adapter, that all grants are usable, or that the LINE
receiver is healthy. Missing tools are reported explicitly.

Restart the connection in Codex and use its `/mcp` view to inspect the loaded
server. For a user-level entry, `codex mcp get NAME --json` is also a configuration
inspection, not a connection test. Trust the project through Codex's own UI only
when appropriate; LineBridge does not automate that trust decision. The same OS
user must be able to unlock Keychain/use DPAPI. After moving/upgrading a portable
folder or runtime, preview replacement from the current launcher. If an older
gateway lacks `line_get_version`, verification fails rather than reading LINE data.

The standalone host command is:

```text
linebridge mcp --profile EXISTING_PROFILE --url GATEWAY_ORIGIN --tools read
```

Run it through an MCP host. Its stdout is JSON-RPC only; diagnostics on stderr
are sanitized. The adapter supports LineBridge's stateless Streamable HTTP with
JSON responses, not arbitrary SSE/stateful MCP servers. It forwards the existing
protected profile's Cloudflare Access pair when present and the non-secret ngrok
browser-warning bypass header. It does not perform OAuth, refresh credentials,
reconnect automatically or persist response data.

## Uninstall

```text
linebridge codex preview --action uninstall --scope project --project PROJECT_DIR
linebridge codex uninstall --scope project --project PROJECT_DIR --consent PREVIEW_DIGEST
```

For user scope, use the same `--scope user` and optional `--codex-home` as before.
Removal requires its own preview digest. It removes only the intact managed
block, keeping the config file/directory, protected profile, gateway grants,
service, LINE session and other Codex settings. A changed block or stale preview
is refused. Restart the host connection afterward; an already running adapter
can remain connected until Codex closes it. To revoke access immediately, use the
existing authorized gateway pause/revocation controls separately.

## Official contract and host limits

Checked on 2026-10-08 against local `codex-cli 0.159.0-alpha.3` help and OpenAI's
[MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[configuration layers](https://learn.chatgpt.com/docs/config-file/config-basic),
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Codex supports stdio command/argument entries, tool allowlists, user and trusted
project TOML configuration. Its MCP CLI offers add/get/remove, but the inspected
`mcp add` has no project-scope option; this installer edits the documented TOML
layer directly to preserve comments and require a scope-specific review.

Metadata handling follows Apple's [ls](https://github.com/apple-oss-distributions/file_cmds/blob/main/ls/ls.1)
and [stat](https://github.com/apple-oss-distributions/file_cmds/blob/main/stat/stat.1)
interfaces, Microsoft's [ACL inspection including audit metadata](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-acl),
and its [ReplaceFile preservation and failure contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew).

Local Codex configuration does not register a cloud Dot or ChatGPT web connector.
Terminal access to a Mac/PC and a cloud host's direct MCP connectivity are separate
capabilities. A cloud-only client needs its own supported MCP integration,
reachable HTTPS endpoint and separately authorized remote credentials. The local
wizard profile cannot be used through a tunnel. Linux remains unsupported for
the LineBridge CLI/service/adapter; separate HTTP MCP clients can run there.

## Development checks

`npm run test:codex:native` runs the actual macOS installer helpers on disposable
project/user configurations, checks exact content and provenance preservation, and
verifies that ACLs and other extended attributes remain refused. It creates no
credential, gateway grant or live Codex entry. Optional positional arguments select
a packaged Node runtime and CLI script for the same acceptance checks.

`npm run test:codex` uses disposable files, fake protected stores and synthetic
MCP traffic. `npm run test:codex:host` additionally needs Codex on PATH; it gives
Codex a disposable configuration and checks `mcp get` without launching a server,
opening credentials or making a model request. No user Codex config is touched.
Linux module/protocol tests and modeled platform checks do not establish native
macOS/Windows Keychain/DPAPI access, Codex launch behavior or desktop UI activation.
Those native checks remain required before claiming installation works on a
particular end-user machine.
