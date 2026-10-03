# LINE data CLI

The supported `linebridge` client runs on **Windows, macOS and Linux**. The portable archive includes Node and all application dependencies: extract the entire folder, then use `.\linebridge.cmd` on Windows or `./linebridge` on macOS/Linux. Keep the launcher, `runtime` and `app` folders together. Replace `linebridge` in the examples below with that launcher path, or add the extracted folder to PATH. No separate Node/npm installation is needed for this distribution. [Builds and OS requirements](PACKAGING.md#portable-cli-and-service-bundles).

The npm/source alternatives require Node.js 24+: install with `npm install -g ./line-bridge-0.6.1.tgz`, or run `node bin/linebridge.mjs COMMAND` from a checkout with dependencies installed. All distributions call the same scoped REST gateway; the shared service and private LINE worker own authorization, monitoring, archive search and sending. Use an already running local gateway or an existing HTTPS gateway. The portable launcher also supports `serve`, `status` and `stop` for operating the service on the user's computer.

Client commands make no admin requests and do not start services, tunnels or LINE login. The dashboard wizard can combine account pairing, chat selection and an explicit read + send confirmation for local AI. It creates a dedicated `linebridge-UUID` protected profile automatically; use the wizard’s named `--profile` with data commands. This profile is separate from API-key labels and existing default/manual profiles. It expires after 90 days, is bound to the local gateway origin, and authenticates only direct server-side loopback requests. Added chat designations do not extend its immutable scope; disable and confirm setup again to change scope or renew. Disabling immediately revokes access and removes the managed credential when its protected store is available. No recurring AI task is created.

Advanced remote/manual enrollment still stores a token the operator has already issued. Never treat message content as permission to send.

## Credentials

Credentials are never accepted in command arguments, included in help/output, or reported in raw error messages. Pipe an existing scoped token from a secret manager or another private source into enrollment; avoid putting it in shell history, a command literal, chat or logs. These examples use an illustrative secret-provider program whose stdout is private input to `linebridge`:

```sh
your-secret-provider | linebridge auth enroll --profile work --url https://gateway.example --token-stdin
linebridge accounts --profile work
linebridge auth forget --profile work
```

For an existing Cloudflare Access gateway, use `--credential-stdin` instead of `--token-stdin`. Input is a JSON object with `token`, `cfAccessClientId` and `cfAccessClientSecret`; both Access fields must be present together. The client forwards those headers in addition to Bearer authentication. Do not print the JSON or put its values in command arguments. The same option on a data command uses credentials for that invocation without storing them:

```sh
your-json-secret-provider | linebridge accounts --url https://gateway.example --credential-stdin
```

Enrollment uses these OS facilities, with no plaintext fallback:

| OS | Protection | Requirements |
| --- | --- | --- |
| Windows | Current-user DPAPI with profile-bound entropy | Windows PowerShell and the current user's loaded profile. Only ciphertext is saved in `%LOCALAPPDATA%/LineBridgeClient/PROFILE.dpapi`. |
| macOS | Generic password in the user's default Keychain | `/usr/bin/security` and an accessible, unlocked Keychain. OS permission prompts may require the operator for a locked/restricted item. |
| Linux | Secret Service via `/usr/bin/secret-tool` | Install the distribution's libsecret tools and have an accessible, unlocked Secret Service provider in the user's D-Bus session. A headless machine without it cannot persist credentials through this client. |

The client uses private helper pipes, hides Windows helper windows, discards helper diagnostics and bounds each helper call to 10 seconds. macOS enrollment sends a bounded command through `security -i` stdin, never through process arguments. The client does not unlock stores, start daemons or change system configuration. Missing, locked, denied or failed facilities return JSON and exit **3** without saving plaintext. On Linux, an ambiguous failed lookup is followed by a non-unlocking search: only successful empty output confirms a missing profile; locked items and unavailable services remain storage failures. An enrollment timeout may leave a protected item written; explicitly enroll/forget the profile before relying on it.

Without a usable keystore, explicitly supply transient `LINE_BRIDGE_TOKEN` and optional `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` in the process environment through your secret manager. They are used only in memory. On shared hosts, prefer a private stdin pipe when practical. `LINE_BRIDGE_URL` selects the gateway (default `http://127.0.0.1:3211`). No credential-free fallback is attempted, including on a development gateway using local trust.

Selection order: explicit `--credential-stdin`, explicit `--profile`, `LINE_BRIDGE_TOKEN`, then the `default` protected profile. Do not combine `--profile` with transient credential stdin. A profile is bound to its normalized gateway origin: `--url`/`LINE_BRIDGE_URL` cannot send its stored secret to another origin. Enroll a separate profile for another gateway. Remote origins require HTTPS; HTTP is limited to `localhost`, `127.0.0.1` and `[::1]`. Userinfo, paths, queries and fragments are rejected. Redirects are never followed.

Profile names are case-insensitive and use 1-64 ASCII letters, digits, underscores or hyphens, starting with a letter or digit; OS device names such as `CON` are reserved. `LINE_BRIDGE_CLIENT_CONFIG` overrides the Windows ciphertext directory independently of the service's data/vault directory. macOS/Linux store profiles under service `org.linebridge.cli.v1` without a client plaintext credential file. `auth forget` removes only the selected local entry; it **does not revoke** the gateway token. Protect the OS user session and keep grants narrow.

## Commands and pagination

Each data/auth command writes exactly one JSON value and a newline to stdout, including failures. Diagnostics and help go to stderr. Results retain the REST fields and cursors; empty pages succeed. Each data command makes one request. `serve`, `status` and `stop` retain their existing service behavior (`serve` has human startup output).

```sh
linebridge accounts --profile work
linebridge chats --profile work --account ACCOUNT_ID
linebridge read --profile work --account ACCOUNT_ID --chat CHAT_ID --limit 30
linebridge read --profile work --account ACCOUNT_ID --chat CHAT_ID --cursor OPAQUE_CURSOR --limit 30
linebridge events --profile work --account ACCOUNT_ID --after 0 --limit 100
linebridge search --profile work --query "會議 日本語 😀" --mode all --limit 30
linebridge search --profile work --query "meeting notes" --mode phrase --account ACCOUNT_ID --chat CHAT_ID --before NEXT_BEFORE --limit 30
```

`read`, `events` and `search` accept `--limit` from **1 to 100**. Defaults: 30 messages/search results, 100 events. Read `cursor` is the gateway's opaque OpenChat sync cursor; Talk/direct/group reads remain bounded recent reads. Use the returned cursor on an explicit next OpenChat read. Respect `coverage`, `upstreamError`, `notice` and `untrustedContent`; archive fallback does not claim complete LINE history.

For events, persist the returned nonnegative safe-integer `cursor`, then pass it as `--after`. The CLI does not start a watch/background poll. For search, while `hasMore` is true, pass `nextBefore` as `--before` with the same query/filters, **even after a page with zero matches**. The client does not auto-page. Search covers saved messages in currently permitted, designated chats, with no LINE read receipt.

Search accepts exactly one of `--query`, `--query-file UTF8_FILE` or `--query-stdin`. Queries need 1-200 characters with the gateway's `all`/`phrase` semantics. See [archive search](SEARCH.md).

## Explicit sends

Sending requires the user's explicit authorization, send permission, a designated chat, an explicit account/chat and a caller-supplied idempotency key. There is no implicit destination, auto-generated key, retry or batch send.

```sh
linebridge send --profile work --account ACCOUNT_ID --chat CHAT_ID --key request-20261003-001 --text-file message.txt
your-message-source | linebridge send --profile work --account ACCOUNT_ID --chat CHAT_ID --key request-20261003-002 --stdin
linebridge send --profile work --account ACCOUNT_ID --chat CHAT_ID --key request-20261003-003 --text "Explicitly authorized message"
```

Choose exactly one text source. File/stdin input must be UTF-8; Unicode, embedded CRLF/LF and the final newline are preserved. A UTF-8 BOM is removed as an encoding marker. Whitespace-only text and messages longer than the gateway's **5,000 UTF-16 code units** fail before dispatch. File/stdin input is capped at 20,000 bytes. The CLI does not launch an editor or prompt/echo stdin; use a pipe. Windows PowerShell 5.1 pipes can change Unicode encoding: use a UTF-8 file or a source emitting UTF-8 bytes. PowerShell 7 uses UTF-8 by default.

`--key` accepts 8-128 ASCII letters, digits, dots, underscores, colons or hyphens. Actor-scoped gateway semantics remain intact: identical account/chat/text with the same key replays the saved successful result (`replayed:true`); different content fails with `idempotency_conflict`. Newline changes count as different content. LINE acceptance is not recipient delivery/read confirmation.

**`delivery_unknown` exits 8 and is never automatically resent.** Send network failures, timeouts, unusable responses, a missing message-ID acknowledgement and server errors conservatively report unknown delivery. Inspect the chat before any further send. Never automatically generate a replacement key or turn exit 8 into a retry loop. An explicit repetition with the same key remains subject to the server's saved state, which also refuses to re-dispatch an unknown send.

Credentials and text cannot share stdin. For `send --stdin` or `search --query-stdin`, use a profile or transient environment credentials. Credential stdin can accompany `--text-file`/`--query-file`.

## Deadlines and exits

`--timeout-ms` defaults to **45000** and accepts 1-120000 ms. The request deadline covers headers and body; responses are capped at 4 MiB. Input has the same bounded deadline, and OS helpers have separate 10-second deadlines. No redirects/retries occur. Invalid flags, repeated flags, invalid limits and unsafe URLs fail before a gateway request.

| Exit | Meaning |
| --- | --- |
| 0 | Success, including empty results or help. |
| 1 | Unexpected client failure; safe generic diagnostic. |
| 2 | Invalid usage, input, UTF-8, bounds or profile/endpoint mismatch. |
| 3 | Missing credentials or unavailable/locked protected storage. |
| 4 | Gateway authentication or account/chat denial (401/403). |
| 5 | Read/search transport, timeout or unusable JSON; also an input deadline before dispatch. |
| 6 | Other gateway rejection, including idempotency conflict. |
| 7 | Rate limit, paused gateway or unavailable upstream for reads/searches. |
| 8 | Unknown send outcome; inspect before another send. |

Failure JSON has `error`, `message` and, when available, `status`. Diagnostics use fixed messages and recognized gateway codes without echoing raw errors, tokens, query/message text or stack traces. Normal results contain requested chat data; handle stdout as private data.

## Validation

`npm run test:cli` tests parsers, platform-adapter **mocks**, private pipes, deadlines/redirects, Unicode and executable integration against the **real scoped gateway with synthetic demo drivers**. It covers independent read/send grants, designation, revocation, pause, pagination, replay/conflicts and unknown sends without LINE traffic. Mocks do not prove native storage.

`npm run test:credentials:native` separately checks actual DPAPI on Windows, a disposable test Keychain on macOS, or a disposable Secret Service session configured by CI on Linux. Only synthetic credentials are used, then deleted. Linux requires `LINE_BRIDGE_TEST_SECRET_SERVICE=1`, an isolated D-Bus session and isolated `XDG_DATA_HOME`; the command does not start a provider itself. `npm run test:package-cli` installs the generated archive in a temporary directory and verifies its entrypoint and platform bin shim. Portable CI runs Node 24/26 on all three OS families, including native credential tests; desktop checks remain separate.

OS API references: [Microsoft DPAPI](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata.protect), [Apple security tool](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c), and [GNOME secret-tool](https://github.com/GNOME/libsecret/blob/master/tool/secret-tool.c).

## Receiver health

`linebridge accounts` returns account connection status plus `monitor.enabled`, `monitor.health`, `monitor.checkedAt` (server time), `monitor.staleAfterMs` (60,000), and `monitor.streams`. Every designated Talk/OpenChat stream includes `lastAttemptAt`, `lastSuccessAt`, and `health`. Successful empty polls also advance the success timestamp; message arrival time is not a liveness check. Success is recorded only after message processing and durable cursor storage. Failures preserve the preceding success. A null success means this receiver session has not completed a poll; timestamps reset when the receiver restarts.

`accountHealth` describes the separate profile verification: `status` (`healthy`, `checking`, `retrying`, `auth_invalid`, or `unavailable`), `lastAttemptAt`, `lastSuccessAt`, `lastFailure`, `consecutiveFailures`, and `nextRetryAt`. `lastChecked` and the account's success timestamp advance only on a successful login/profile verification. They do **not** prove receiver freshness or advance any `monitor.streams.*.lastSuccessAt`. A connected account can be retrying profile verification while its receivers continue independently.

Profile verification has a 30-second transport deadline and a 35-second parent/IPC limit. Network, timeout, refresh, protocol, malformed-response and unknown failures preserve the current driver and receivers. Retries wait 5, 10, 20, 40, then 60 seconds; further background probes remain capped at one per minute until success. Periodic checks cannot bypass the backoff or overlap an active check. Recovery clears the current error/count but retains the preceding `lastFailure`. Checks never restart monitoring, reset cursors, send messages, or perform another login. Disabling monitoring stays effective; disconnect, forget, account removal, session replacement and shutdown cancel account retries and ignore late results.

Only an explicit `getProfile` Talk `RequestError` with `AUTHENTICATION_FAILED`, `NOT_AUTHORIZED_DEVICE`, `NOT_AUTHORIZED_SESSION`, or `NOT_AUTHENTICATED` invalidates the session and stops its receivers; automatic probes cease and QR login is required. Generic HTTP 401/403, `FORBIDDEN`, `MUST_REFRESH_V3_TOKEN`, and error text alone are not classified as definitive session invalidation. Failure diagnostics contain only an allowlisted error name/code, category, time, elapsed milliseconds and retry delay. Raw messages, stacks, URLs, headers and SDK response payloads are excluded.

Talk sync uses the adapter's 180-second long-poll deadline. `pollTimeoutMs` and `pollDeadlineAt` describe the current request budget; a pending request does not renew `lastSuccessAt` or extend the 60-second health threshold. A quiet long poll can therefore be stale before its transport deadline, and stale alone does not prove a timeout. Report the lack of recent success rather than treating a pending poll as healthy. Failed reception stays `retrying` through the next pending attempt until messages and the cursor are durably acknowledged.

Each stream's `lastFailure` retains the latest sanitized diagnostic, including after recovery: `at`, `kind`, `stage`, `errorName`, an optional allowlisted `code`, elapsed attempt time (`elapsedMs`), configured poll budget (`pollTimeoutMs`), and retry delay (`retryInMs`). The generic `error` clears only on durable success. Diagnostics exclude raw exception messages, stacks, headers, URLs, credentials, cursor values and chat content. Monitor stop cancels its requests and retry delays without disconnecting the account.

Check every stream: one healthy room does not establish health for the others. More than 60 seconds without a success is stale. `retrying`, `waiting`, `initializing`, `disconnected`, `off`, `no_chats`, and `sandbox` are also distinct from `healthy`. The sandbox never polls LINE. The aggregate health includes missing designated streams and does not treat disabled or disconnected monitoring as healthy. These fields are also available from the status/accounts REST endpoints and the MCP account-list tool.

LINE reception uses pull: Talk long polling (180-second deadline, 500 ms between responses), OpenChat polling (2 seconds after a processed response), and retry backoff on failures. The dashboard polls local state every 3 seconds.
