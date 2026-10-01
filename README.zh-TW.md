# LineBridge

LineBridge 0.4 是 **headless npm 服務**，提供繁體中文網頁管理介面、SQLite 加密儲存，以及讓 AI 讀取與傳送指定 LINE 聊天室訊息的 MCP／HTTP API。讓雲端 AI 在自己的 VM 安裝並執行，預設 localhost 連線**不需要建立或複製權杖**。只需 **Node.js 24 以上**；無需 Rust、Tauri、桌面安裝程式或編譯器。

## 安裝到 Linux AI VM

目前提供可直接安裝的 npm 壓縮包，**尚未發布到 npm registry**。將 `release/npm/line-bridge-0.4.0.tgz` 複製到 VM 後：

```sh
npm install -g ./line-bridge-0.4.0.tgz
linebridge serve --data-dir /可持續保存且可寫入的路徑/linebridge-data
```

如果不想全域安裝，可執行：

```sh
npm exec --package=./line-bridge-0.4.0.tgz -- linebridge serve --data-dir ./linebridge-data
```

AI 和 LineBridge 在同一台 VM 時，直接使用 `http://127.0.0.1:3211/mcp`，**不需要權杖、通道或額外服務帳號。** HTTP API 位於 `/api/v1`。AI 可先呼叫 `/api/v1/status` 或執行 `linebridge status --data-dir DIR`，取得設定步驟、帳號狀態與 MCP 網址。尚未配對帳號、指定聊天室前，帳號清單為空。

從自己的電腦開啟管理頁面：

```sh
ssh -L 3210:127.0.0.1:3210 user@your-vm
```

接著在瀏覽器開啟 `http://127.0.0.1:3210`。兩個服務只監聽 loopback；AI 閘道不提供管理操作。

## 開始使用

1. 依首頁精靈新增 LINE 帳號，使用手機掃描 QR Code。先嘗試恢復已儲存的工作階段；重新登入可能取代相同裝置類型的工作階段。
2. 探索一對一、群組與已加入的 OpenChat，並指定 AI 可存取的聊天室。手動加入 ID 不會加入聊天室。
3. 指定聊天室預設允許同一台 VM 的 AI 讀取與傳送。可在精靈或「AI 存取權限」分別關閉讀取、傳送；兩者皆關閉即停用該帳號的本機 AI。每次請求、排程執行及讀取回傳前都會重新檢查權限，無需建立權杖。
4. 在「訊息監控」啟用監聽。僅儲存已指定聊天室的新訊息，每個帳號最多保留 1,000 則，支援事件游標及去重。
5. AI 與服務同一台主機時直接使用 localhost；跨主機時才需要選用 Cloudflare 或 Tailscale。

帳號、監控、AI 權限、詳細連線設定及活動紀錄各有獨立頁面。名稱使用聯絡人別名、LINE 顯示名稱或 OpenChat 暱稱。讀取不送出已讀回條；聊天內容一律視為不可信資料。傳送需有權限並提供冪等識別碼；結果不明時不會自動重送。

## 給雲端 AI 的安裝指令

可將 npm 壓縮包與以下指令交給 AI：

> 請在你的 VM 安裝附上的 LineBridge npm 壓縮包，使用 Node.js 24 以上版本。以持續儲存的資料目錄執行 `linebridge serve`，交由 VM 程序管理器維持執行。MCP 連接 `http://127.0.0.1:3211/mcp`，不提供驗證標頭。協助我在管理介面取得 LINE QR Code、用手機配對並指定你可以存取的聊天室。同一台 VM 不需要建立權杖或通道。完成後回報服務狀態與帳號權限。

手機掃 QR Code 與聊天室選擇仍由你完成。同一台 VM 的其他程序共用本機 AI 權限；如需區分不同用戶端，可選用權杖模式。

## 選用的遠端存取

選擇任何通道提供者後，**整個閘道（包含 localhost）都要求 Bearer 權杖**，即使通道尚未啟動。遠端權杖位於「AI 存取權限」的選用區段，可分別授權帳號讀取／傳送及到期日；只顯示一次，資料庫只儲存雜湊。Cloudflare Access 另需服務憑證。停止通道後須切回「同一台主機 · 直接連線」才恢復本機免權杖。

自行設定反向代理或需要同一台 VM 的用戶端隔離時，使用 `linebridge serve --require-token` 或 `LINE_BRIDGE_REQUIRE_TOKEN=1`。瀏覽器與含代理標頭的請求不適用本機免權杖。已提供的權杖一律驗證其自身權限，不會在失效時改用本機權限。舊版權杖仍可使用。

## 資料與執行方式

服務在前景執行，可交由 systemd 或 VM 的程序管理器維持運作。使用相同 `--data-dir` 執行 `linebridge status` 或 `linebridge stop`，也可用 SIGINT／SIGTERM 正常關閉。不會自動安裝開機服務。

Linux 預設資料位置是 `$XDG_DATA_HOME/linebridge` 或 `~/.local/share/linebridge`；可用 `LINE_BRIDGE_DATA` 或 `--data-dir` 指定持續儲存的目錄。資料與 npm 安裝位置分開，升級後保留。訊息、憑證及別名使用 AES-256-GCM 加密；Linux 金鑰檔權限為 0600，目錄為 0700。

舊版 SQLite 格式保留。先停止舊服務，再以同一個 OS／使用者與資料目錄啟動 Node 版；首次啟動會建立一致的 SQLite 備份。Windows DPAPI 金鑰不能直接移到 Linux 解密，請在 Linux 使用新資料目錄重新掃 QR 登入。備份時須一併保存金鑰。

LINE 使用非官方 `lineclientbot` 介面，OpenChat 功能仍屬實驗性。完整歷史、離線期間訊息與所有帳號的相容性不保證；媒體不下載。Cloudflare／Tailscale 都是選用功能，輔助程式須另外安裝。

[完整英文說明](README.md) · [打包方式](PACKAGING.md) · [連線選項](CONNECTIONS.md) · [名稱查詢](ALIASES.md)
