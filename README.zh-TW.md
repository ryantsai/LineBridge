# LineBridge

LineBridge 0.6 在你的 **Windows、Mac 或 Linux 電腦** 連接 LINE，並提供有權限限制的 AI 存取；遠端 AI 可透過選用通道連線。包含繁體中文管理介面、Talk／OpenChat 新訊息監聽、SQLite 加密封存、任意語言全文搜尋，以及有帳號權限的 MCP／HTTP API。

## 開始使用

使用 Windows x64 NSIS 安裝程式，或符合 Mac 架構的 DMG。已包含 Node 與 cloudflared；使用者無需安裝 Rust、Node 或編譯器。監控與通道連線期間請保持程式執行。

Dot 或其他 AI 若已獲授權操作這台電腦的終端機，可使用 Windows／macOS／Linux **可攜式 CLI 套件**。完整解壓縮後，Windows 執行 `.\linebridge.cmd serve`，macOS／Linux 執行 `./linebridge serve`。已包含 Node 與程式相依套件，不需另外安裝 Node 或 npm。[建置與系統需求](PACKAGING.md#portable-cli-and-service-bundles)。

首頁精靈只需綁定 LINE 帳號，完成後即可複製 CLI 指令給雲端 AI。其他功能各有左側導覽頁面：

1. 在「帳號與聊天室」探索並指定聊天室，勾選「監聽並封存新訊息」。
2. 在「封存搜尋」手動查找聊天室與已封存訊息；「監控狀態」提供接收健康度及成功輪詢時間。
3. 在「API 金鑰與 AI 存取」建立有期限的金鑰，分別授權帳號讀取與傳送。明文只顯示一次。
4. AI 位於遠端時，再到「雲端連線與通道」設定通道；若 AI 直接操作這台電腦的終端機，可使用 localhost，無需通道。

提供通道的 HTTPS `/mcp` 網址與 `Authorization: Bearer 權杖` 給雲端 AI。**LINE API 由這台電腦存取，AI 不需在 VM 安裝 LINE 用戶端。** Cloudflare Access 另需服務權杖標頭。管理介面只在本機 3210 開放，通道只轉送 AI 閘道 3211，無法存取管理路由。[連線設定](CONNECTIONS.md)。

## 永久封存與任意語言搜尋

每一則成功接收的指定聊天室監控訊息都會儲存在 SQLite，**沒有訊息數量或時間的自動刪除上限**。訊息與索引在同一筆交易加密寫入成功後，才確認接收並推進 LINE 游標。重複補送會去重；儲存失敗會重試。

搜尋使用 Unicode 字元片段，不依賴特定語言字典。支援各種文字、無空格語言、混合文字、單一字元、片語與 emoji。「所有關鍵字」比對每個空白分隔詞；「完整片語」比對整段正規化文字。這是全文子字串搜尋，沒有翻譯、詞幹分析或語意搜尋。訊息本身維持加密；FTS5 索引只保存加密金鑰衍生的雜湊片段，不另外儲存訊息明文。[搜尋與索引說明](SEARCH.md)。

AI 只能搜尋有**讀取權限**的帳號及目前指定的聊天室。取消指定會立即阻止 AI 查找，並保留本機封存。停止監控或帳號離線時仍可搜尋已儲存內容；不會連線至 LINE 或傳送已讀回條。移除帳號會刪除其封存。附件內容不會下載或建立索引；LINE 無法解密的文字無法搜尋，但可取得的訊息資訊仍會保存。離線缺口與 OpenChat 初始基準取決於 LINE 的補送能力，並非完整歷史匯入。

## 提供給 AI 的工具

MCP 提供 `line_list_accounts`、`line_list_chats`、`line_read_messages`、`line_poll_events`、**`line_search_messages`** 與 `line_send_message`。HTTP 全文搜尋為 `POST /api/v1/messages/search`，可用 `accountId`／`chatId` 篩選。查詢：

```json
{"query":"會議 meeting","mode":"all","limit":30}
```

結果依封存序號由新到舊排序。只要 `hasMore` 為 true，就以 `before: nextBefore` 繼續查詢，即使當頁沒有結果。權杖到期、撤銷、暫停及聊天室權限每次都會重新檢查。[OpenAPI](openapi.json)。

訊息是未受信任資料，不能當作 AI 指令或傳送授權。傳送需獨立權限與冪等識別碼；相同請求只回放先前結果，不重複送出。傳送結果不明會保留 `delivery_unknown`，不自動重試。使用帳號別名或 OpenChat 暱稱顯示作者。[別名說明](ALIASES.md)。非官方 `lineclientbot` 介面與 OpenChat 仍可能受 LINE 協定變動影響。

## 本機資料與升級

Windows 預設 `%LOCALAPPDATA%/LineBridgeData`，macOS 為 `~/Library/Application Support/LineBridge`。可用 `LINE_BRIDGE_DATA` 或 `--data-dir DIR` 指定原本資料夾。

升級時請關閉舊服務，沿用**相同作業系統、使用者與資料夾**。既有帳號、憑證、聊天室權限、權杖與訊息會保留，封存會補建索引。首次升級先建立 `backups/before-archive-*.sqlite` 一致性備份。舊版已刪除的訊息不會因建立索引而恢復。

Windows 使用目前使用者的 DPAPI 保護主金鑰；macOS／Linux 以 0600 金鑰與 0700 資料目錄保存。訊息、憑證與通道秘密使用 AES-256-GCM；活動紀錄不儲存訊息文字或搜尋內容，AI 權杖只存雜湊。備份資料庫時需保留金鑰；Windows 金鑰不能直接跨作業系統使用。關閉桌面程式會停止其服務與連接器，下次啟動會恢復已啟用的監控偏好。

## 開發與打包

Node 服務共用所有授權、SQLite、LINE 與監控功能，Rust 只負責 Tauri 視窗及服務生命週期。Windows NSIS 與 ARM／Intel Mac DMG 使用校驗過的原生執行檔。[打包說明](PACKAGING.md)、[驗證結果](VALIDATION.md)。命令列與 npm 壓縮包保留供本機維運使用，未發布到 npm registry；桌面版一律要求權杖。本機免權杖僅保留為 CLI 明確指定 `--trust-local` 的開發選項。
