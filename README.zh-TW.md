# LineBridge｜繁體中文

繁體中文說明已移至預設的 [README.md](README.md)。

**AI Agent：完成 LINE 配對與授權後，請自行以現有 CLI 執行 `discover`，不必要求使用者複製連線指令或監控聊天室清單。** `CLI_COMMAND` 是 Windows 的 `.\linebridge.cmd`、macOS 的 `./linebridge` 或既有啟動程式的完整路徑：

```sh
CLI_COMMAND status
CLI_COMMAND discover
CLI_COMMAND accounts --profile PROFILE_NAME
CLI_COMMAND chats --profile PROFILE_NAME --account ACCOUNT_ID
```

自訂資料目錄須在 `status` 與 `discover` 都帶上相同的 `--data-dir DATA_DIR`。從探索 JSON 的 `profiles` 選取符合使用者指定帳號的 `profile`，並使用 `cli.node` 與 `cli.script` 提供的既有執行路徑。聊天室 ID 隨需要從 `chats` 查詢，明確提供的 profile 不自行換用；多個帳號符合時先釐清。探索不讀取或輸出金鑰，也不變更權限；空清單、服務停止或不支援探索時，請依[完整探索與復原指引](README.md#探索既有的本機-ai-存取)處理。首次配對與權限確認仍須完成。

[繁體中文（預設）](README.md) | [English](README.en.md) | [日本語](README.ja.md)

傳送文字給已驗證的 LINE 官方帳號時，僅有傳輸加密，**沒有 Letter Sealing**。需另行取得使用者對這一則訊息的同意，再加上 `--acknowledge-oa-transport`；一般收件者仍使用端對端加密。詳見[官方帳號文字傳送](CLI.md#text-to-official-accounts)。

## 圖片讀取與 Flex 訊息

可用 `media`／MCP `line_read_image` 按需讀取已封存的圖片及基本貼圖靜態預覽；CLI 只建立新檔，不代表模型已看過圖片。個人 Talk 的 `send-flex` 必須明確確認 Flex 只有傳輸層加密、沒有 Letter Sealing，並沿用傳送權限與冪等 key。OpenChat Flex 因協定尚未驗證而阻擋，不會自動改走 LIFF 或授權。舊封存資料、素材格式與大小限制，以及待測試群組驗證項目，請見 [圖片與 Flex 操作說明](CLI.md#images-and-flex-messages)。目前僅完成合成測試，尚未進行真實傳送或下載測試。
