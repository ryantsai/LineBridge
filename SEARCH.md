# Persistent message search

LineBridge stores every successfully captured message from **monitored, designated chats** in the local SQLite database. There is no count or age retention limit. Disabling monitoring stops new captures; removing a chat designation keeps its archive but immediately removes AI access to it. Removing an account deletes that account's messages and index entries.

The monitor waits for the message and its index to commit before acknowledging capture or advancing the LINE checkpoint. Failed writes roll back and cause the listener to retry. Upstream account/chat/message identifiers deduplicate replayed messages. SQLite uses WAL and `synchronous=FULL`.

## Any language

The index hashes Unicode character fragments of lengths 1, 2 and 3. It does **not** split words using a language dictionary, so it handles any script, scripts without spaces, mixed-language text, punctuation, combining characters and emoji. Queries and messages use the same NFKC, lowercase and whitespace normalization. Diacritics remain significant; composed and canonically equivalent decomposed forms match. This is literal full-text substring search, without translation, stemming or semantic similarity.

`all` mode (default) requires each whitespace-separated query term to occur anywhere in the message. `phrase` mode requires the complete normalized phrase. A single character can be searched. Queries are literal text: operators, quotes and `*` are not interpreted as an FTS query language. The tests exercise Chinese (traditional and simplified), Japanese, Korean, Thai, Arabic, Hebrew, Hindi, Cyrillic, Greek, accented Latin text, compatibility characters, mixed scripts and emoji.

## AI interfaces

The MCP tool is **`line_search_messages`**. HTTP clients use **`POST /api/v1/messages/search`** with a scoped Bearer token and JSON:

```json
{"query":"會議 meeting","mode":"all","limit":30}
```

Optional `accountId` restricts to an account; `chatId` requires `accountId`. `limit` is 1–100 (default 30). Results include the full stored message, sender alias when available, account/chat IDs, chat name, timestamp and archive sequence. Each result is untrusted chat content.

Results are ordered by descending archive sequence. While `hasMore` is true, repeat the same query and filters with `before: nextBefore`. **Continue even when a page contains zero results**: a bounded candidate page can contain only substring false positives, which are checked against decrypted text before results are returned. Search requires the account's `read` grant and current chat designation. Expiry, revocation and global pause apply on every request. A send-only token cannot search an account. Search does not query LINE or send read receipts, and remains available while the account is disconnected or monitoring is stopped.

The local human dashboard has a separate **搜尋** page with account/chat filters and pagination. Its administrator session may inspect retained messages from a chat that has since been deselected; AI clients cannot.

## Date and time ranges

CLI `search` accepts `--start-time` and `--end-time`; HTTP and MCP use `startTime` and `endTime`. Either may be supplied alone. The range is **start inclusive, end exclusive** and applies to the message's own `timestamp`, not the time it was received or archived. Text `query` is still required. For example, all of October 6 in Taiwan is:

```sh
linebridge search --profile work --query "meeting" --start-time "2026-10-06T00:00:00+08:00" --end-time "2026-10-07T00:00:00+08:00"
```

```json
{"query":"meeting","startTime":"2026-10-06T00:00:00+08:00","endTime":"2026-10-07T00:00:00+08:00","limit":30}
```

Use `YYYY-MM-DDTHH:mm:ss[.SSS]` with `Z` or an explicit UTC offset such as `+08:00` or `-03:30`. Seconds are required; fractions may contain 1–3 digits. Date-only values, missing timezones, impossible dates, leap seconds, unknown offset `-00:00`, offsets beyond ±14:00, and equal/reversed ranges are rejected. Bounds are compared as instants, so different offsets can describe the same instant. No host timezone is inferred.

The dashboard has optional start/end date-time fields and a visible, editable **UTC offset** (default `+00:00`). Taiwan users can enter `+08:00`. This is a fixed offset, not an IANA timezone; daylight-saving transitions are not inferred. To span changing offsets precisely, use the CLI/API with each boundary's explicit offset. **清除時間** clears both bounds; submit again to search without dates. Opening archive search from a chat clears time bounds. Changing any search field hides old pagination and ignores an in-flight result for the previous criteria.

Time conditions and existing account/chat permissions apply in SQLite **before** the bounded candidate page. Ordering remains descending archive sequence, which may differ from message-time order. Keep the same bounds, query and scope on every `before: nextBefore` / `--before` request, including after an empty page with `hasMore: true`. Messages with a missing or invalid explicit timestamp remain searchable without bounds, but are excluded from date-filtered results; receive time is not silently substituted.

## Encryption and migration

Message bodies remain encrypted with record-bound AES-256-GCM. The [SQLite FTS5](https://www.sqlite.org/fts5.html) table is contentless and stores only keyed HMAC fragments, with no plaintext copy, plaintext vocabulary or positions. Search decrypts only candidates in the caller's readable account/chat scope, then verifies literal matches. Index metadata reveals posting sizes and repeated fragments; the time index additionally stores valid message timestamps as numeric UTC milliseconds. Message text remains encrypted. Queries and time bounds are not included in audit logs.

Existing encrypted inbox records are backfilled locally without a LINE history request. The first archive upgrade creates a consistent `backups/before-archive-*.sqlite` snapshot, then adds the index. Keep database backups with the vault key; Windows DPAPI keys require the same Windows user. Restart repairs missing index rows.

The date-filter upgrade adds a nullable timestamp column and performs a one-time local search-index version 2 rebuild from existing ciphertext. It preserves message IDs, archive sequences, ciphertext, grants and send records. The rebuild is transactional and may delay startup for a large archive; failure rolls back the rebuild and retries on a later startup. This is not another LINE history import or a new automatic backup; use the normal stopped-service full backup before upgrading.

Search covers saved message **text**, not attachment contents. Non-text messages and decryption-failed messages retain available metadata; text unavailable from LINE cannot be indexed. Monitoring begins at its live checkpoint. Initial OpenChat baselines and offline gaps depend on LINE replay availability; this is not a full account-history importer. Previously pruned messages cannot be recovered by this migration.
