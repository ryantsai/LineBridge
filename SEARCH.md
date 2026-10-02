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

The local human dashboard has a separate **封存搜尋** page with account/chat filters and pagination. Its administrator session may inspect retained messages from a chat that has since been deselected; AI clients cannot.

## Encryption and migration

Message bodies remain encrypted with record-bound AES-256-GCM. The [SQLite FTS5](https://www.sqlite.org/fts5.html) table is contentless and stores only keyed HMAC fragments, with no plaintext copy, plaintext vocabulary or positions. Search decrypts only candidates in the caller's readable account/chat scope, then verifies literal matches. Index metadata reveals posting sizes and repeated fragments but cannot be used as a plaintext message database without the vault key. Queries are not included in audit logs.

Existing encrypted inbox records are backfilled locally without a LINE history request. The first archive upgrade creates a consistent `backups/before-archive-*.sqlite` snapshot, then adds the index. Keep database backups with the vault key; Windows DPAPI keys require the same Windows user. Restart repairs missing index rows.

Search covers saved message **text**, not attachment contents. Non-text messages and decryption-failed messages retain available metadata; text unavailable from LINE cannot be indexed. Monitoring begins at its live checkpoint. Initial OpenChat baselines and offline gaps depend on LINE replay availability; this is not a full account-history importer. Previously pruned messages cannot be recovered by this migration.
