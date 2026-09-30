# LINE display names and aliases

Researched and implemented against the installed `lineclientbot` 0.1.3 package on 2026-09-30. Upstream references: [lineclientbot](https://github.com/Tatsuyato/lineclientbot), [LINEJS](https://github.com/evex-dev/linejs). The versioned installed declarations and RPC serializers are the source of truth for this implementation; current upstream examples may expose a newer facade.

| Context | Lookup and preference | Message metadata |
| --- | --- | --- |
| Personal contacts and group authors | Talk `getContactsV2({ mids })`; `Contact.displayNameOverridden` first, then `Contact.displayName` | `senderName`, `senderProfileName`, `senderNameSource: contact_alias / contact_profile` |
| This account | The signed-in account's current profile | `senderNameSource: account_profile`; the local UI labels its messages `我` |
| OpenChat | Event `senderDisplayName` when present; otherwise Square `getSquareMembers({ request: { mids } })`, using `SquareMember.displayName` | `senderNameSource: openchat_event / openchat_profile` |

The installed definitions are in `dist/types/types/line/line_types.d.ts`: `Contact`, `ContactEntry`, `GetContactsV2Response`, `GetSquareMembersRequest`, `GetSquareMembersResponse`, and `SquareMember`. The Talk and Square service implementations and Thrift serializer confirm the different argument envelopes. OpenChat member identities use the Square namespace; a personal contact alias is never substituted for an OpenChat nickname.

Names are added to both bounded history reads and newly captured monitored messages. Contact discovery also prefers the account's overridden name, and seeds the same resolver. Existing encrypted inbox entries are enriched from the account's encrypted name cache on reads. A history read can resolve missing names in retained messages as well.

The cache is isolated per account, kept in memory and in the existing encrypted SQLite `secrets` table. It retains at most 1,000 identities, refreshes successful lookups after one hour, and retries unavailable identities after one minute. RPC lookups batch up to 100 distinct senders, coalesce concurrent requests for the same identity, and use an eight-second soft deadline. SDK clients exposing only `getSquareMember` use a bounded compatibility fallback. No complete member directory is enumerated for message-name lookup.

Missing, deleted, inaccessible, or timed-out names do not prevent message reads or durable capture. Messages carry `senderNameStatus: resolved / unavailable / system`; IDs remain stable for routing and API calls. The UI shows `名稱暫時無法取得` when it cannot obtain a name, and keeps technical chat IDs in an expandable details section. A display name is descriptive data, not a verified real-world identity or permission to send.

Tests cover overridden names, account isolation, personal versus OpenChat namespaces, encrypted inbox enrichment, cache persistence and expiry, batching, concurrent lookups, timeouts, and lookup after designation/baseline filtering. Live LINE and OpenChat results still depend on the account's access and upstream RPC availability.
