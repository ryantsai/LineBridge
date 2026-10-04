# LineBridge

LineBridge 0.6 在你的 **Windows、Mac 或 Linux 電腦** 連接 LINE，並提供有權限限制的 AI 存取；遠端 AI 可透過選用通道連線。包含繁體中文管理介面、Talk／OpenChat 新訊息監聽、SQLite 加密封存、任意語言全文搜尋，以及有帳號權限的 MCP／HTTP API。

## 開始使用

從 [GitHub Releases](https://github.com/ryantsai/LineBridge/releases) 下載。此次本機發布的 **v0.6.1** 提供 Windows x64 套件及需 Node 的 npm 壓縮包；macOS／Linux 原生套件請先使用 [v0.6.0](https://github.com/ryantsai/LineBridge/releases/tag/v0.6.0)。

1. **Windows x64：**下載 [LineBridge_0.6.1_x64-setup.exe](https://github.com/ryantsai/LineBridge/releases/download/v0.6.1/LineBridge_0.6.1_x64-setup.exe)，執行安裝程式，再從開始功能表開啟 **LineBridge**。
2. **macOS：**下載符合 Mac 架構的 DMG（Apple Silicon 選 `aarch64`，Intel 選 `x64`），開啟後將 **LineBridge** 拖到「應用程式」，再從該處啟動。

已包含 Node 與 cloudflared；使用者無需安裝 Rust、Node 或編譯器。Windows 安裝程式未簽章；Mac 程式採 ad-hoc 簽章，尚未公證。監控與通道連線期間請保持程式執行。

Dot 或其他 AI 若已獲授權操作這台電腦的終端機，可使用 Windows／macOS／Linux **可攜式 CLI 套件**。完整解壓縮後，Windows 執行 `.\linebridge.cmd serve`，macOS／Linux 執行 `./linebridge serve`。已包含 Node 與程式相依套件，不需另外安裝 Node 或 npm。[建置與系統需求](PACKAGING.md#portable-cli-and-service-bundles)。

Windows 可直接下載 [LineBridge-0.6.1-windows-x64.zip](https://github.com/ryantsai/LineBridge/releases/download/v0.6.1/LineBridge-0.6.1-windows-x64.zip)，選擇「全部解壓縮」，在解壓後的 `LineBridge-0.6.1-windows-x64` 資料夾開啟終端機，再執行 `.\linebridge.cmd serve`。保留整個資料夾並保持終端機執行，開啟 [本機管理介面](http://127.0.0.1:3210)，用手機配對 LINE、指定聊天室並建立 API 金鑰。需要停止時，在另一個終端機使用相同啟動器執行 `stop`。

若已安裝 Node.js 24+，可下載 [line-bridge-0.6.1.tgz](https://github.com/ryantsai/LineBridge/releases/download/v0.6.1/line-bridge-0.6.1.tgz)，執行 `npm install -g ./line-bridge-0.6.1.tgz`，再執行 `linebridge serve`。這個壓縮包由 GitHub Releases 提供。

首頁精靈只需綁定 LINE 帳號，完成後即可複製 CLI 指令給雲端 AI。其他功能各有左側導覽頁面：

1. 在「帳號與聊天室」探索並指定聊天室，勾選「監聽並封存新訊息」。
2. 在「封存搜尋」手動查找聊天室與已封存訊息；「監控狀態」提供接收健康度及成功輪詢時間。
3. 在「API 金鑰與 AI 存取」建立有期限的金鑰，分別授權帳號讀取與傳送。明文只顯示一次。
4. AI 位於遠端時，再到「雲端連線與通道」設定通道；若 AI 直接操作這台電腦的終端機，可使用 localhost，無需通道。

提供通道的 HTTPS `/mcp` 網址與 `Authorization: Bearer 權杖` 給雲端 AI。**LINE API 由這台電腦存取，AI 不需在 VM 安裝 LINE 用戶端。** Cloudflare Access 另需服務權杖標頭。管理介面只在本機 3210 開放，通道只轉送 AI 閘道 3211，無法存取管理路由。[連線設定](CONNECTIONS.md)。

## 本機 AI 讀取 + 傳送設定

設定精靈依序綁定帳號、選擇聊天室，並在啟用前顯示帳號、聊天室名稱／ID 與「讀取 + 傳送」權限。只有按下明確的啟用按鈕才會建立授權並開始本機接收及加密封存。應用程式自動將專用 CLI 設定檔保存到 Windows DPAPI、macOS Keychain 或 Linux Secret Service；不需要複製權杖或使用 Terminal 登錄。

專用設定檔只供同一台電腦的 AI 用戶端存取已確認聊天室；新增指定聊天室不會自動擴大權限。變更範圍或更新 90 天授權時，先停用再重新確認。既有 default／手動設定檔不會被覆寫。停用立即撤銷授權；若 OS 憑證儲存無法使用，介面會保留可重試的清理狀態，沒有明文備援。所有選定接收串流均有近期成功輪詢才顯示就緒，沙盒會另行標示。此設定不會建立 AI 自動工作排程。遠端／手動金鑰與通道設定保留在左側選單。

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

Windows PowerShell 可用 `.\scripts\release.ps1`，Command Prompt 可用 `scripts\release.cmd`，macOS／Linux 可用 `sh scripts/release.sh`；共用命令為 `bump`、`tag` 與 `publish`。也可使用跨平台的 `npm run version:bump -- patch` 同步版本，檢查並提交變更後執行 `npm run release:tag -- --push` 標記目前 commit 並推送，最後以 `npm run release -- publish` 建置及上傳。若要一次完成版本遞增、提交、標籤、推送與發布，可執行 `npm run release -- publish --bump patch`；加上 `--dry-run` 可先預覽。[各平台範例](PACKAGING.md#release-helper-scripts-windows-macos-and-linux)。

本機建置並上傳到 GitHub Releases：先提交程式變更，再用 `npm run publish:github -- --bump patch --dry-run` 預覽，確認後執行 `npm run publish:github -- --bump patch`。`--bump` 支援 `patch`、`minor`、`major` 或明確指定較高版本，會同步應用程式版本；測試與建置通過後，只提交版本檔案、建立標籤，將分支與標籤推送到 `origin`，再上傳發布檔案。需要乾淨的分支工作目錄，且 `origin` 指向選定的 GitHub 儲存庫。其他平台或已準備好版本與標籤時，執行不含 `--bump` 的 `npm run publish:github`。[發布設定、失敗復原與選項](PACKAGING.md#publish-local-builds-to-github-releases)。

Node 服務共用所有授權、SQLite、LINE 與監控功能，Rust 只負責 Tauri 視窗及服務生命週期。Windows NSIS 與 ARM／Intel Mac DMG 使用校驗過的原生執行檔。[打包說明](PACKAGING.md)、[驗證結果](VALIDATION.md)。命令列與 npm 壓縮包保留供本機維運使用，未發布到 npm registry；桌面版一律要求權杖。本機免權杖僅保留為 CLI 明確指定 `--trust-local` 的開發選項。
