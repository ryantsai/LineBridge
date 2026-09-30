# LineBridge 使用說明

LineBridge 是本機 LINE 帳號橋接器。桌面程式使用 Rust 1.98.1 + Tauri 2.12.0，管理介面預設為繁體中文（台灣），資料儲存在 SQLite。

## 啟動

雙擊 **Start LineBridge.cmd** 開啟桌面程式，會沿用此資料夾的既有帳號與加密憑證。**Start LineBridge Headless.cmd** 啟動背景 Rust 服務及瀏覽器介面，適合持續提供雲端 AI 存取。**Stop LineBridge.cmd** 停止此專案的服務與所屬通道／通訊程序。

瀏覽器介面是 `http://localhost:3210`，AI 閘道是 `http://127.0.0.1:3211`。只將 3211 轉送至私人通道。關閉桌面程式會停止它管理的服務與監聽；目前未建立自動啟動項目。

Windows 安裝程式位於 `target/release/bundle/nsis/LineBridge_0.2.0_x64-setup.exe`。安裝版預設使用 `%LOCALAPPDATA%/com.ryantsai.linebridge`；若要使用此專案的既有帳號，請從上述啟動檔開啟，或在啟動安裝版之前，將 `LINE_BRIDGE_DATA` 設為此資料夾的 `data` 完整路徑。安裝程式未簽章。

## 帳號與聊天室

1. 新增帳號，使用手機 LINE 掃描 QR Code 並完成確認。次要裝置登入可能取代相同裝置類型的工作階段。
2. 已有儲存的登入憑證時，先試 **恢復已儲存的工作階段**。
3. 按 **探索聊天室**，用篩選器查看群組、聯絡人或 OpenChat；也可新增已知的完整聊天室 ID。這不會加入聊天室。
4. 勾選允許 AI 存取的聊天室。未勾選的聊天室仍可在本機手動讀取、傳送。
5. 在 **AI 存取權限** 建立有期限的權杖；讀取與傳送分別授權。權杖只顯示一次，之後資料庫只保留雜湊。

LINE 通訊仍使用非官方 `lineclientbot` 配接器，由隨附的 Node 程序執行。Rust 負責權限、閘道、資料庫、加密與通道管理。未擷取已安裝 LINE 桌面版的工作階段。

## 新訊息監聽

選擇帳號後按 **開始監聽**。只收集已勾選的聊天室，介面會顯示監聽狀態、已儲存數量與最新訊息時間。不會自動產生或傳送 AI 回覆。重新啟動後，已啟用的監聽會在帳號恢復連線後繼續。

個人聊天室使用長輪詢，OpenChat 約每兩秒讀取事件。初始歷史資料僅用來建立游標，不會匯入收件匣。訊息加密儲存在 SQLite，每個帳號最多保留 1,000 則。離線、LINE 的保留限制或協定變更可能造成缺漏。無法解密的訊息會顯示提示，不會顯示密文。讀取不會呼叫已讀回條 API。

雲端 AI 可使用 `line_poll_events` MCP 工具，或 `GET /api/v1/accounts/{accountId}/events?after=0&limit=100`。下次讀取將回傳的 `cursor` 放入 `after`，即可取得後續訊息。

## Cloudflare 私人通道

已選擇 Cloudflare Tunnel + Access；主機名稱待你選擇，因此目前沒有啟動通道。先在 Cloudflare 建立具名通道，將來源設為 `http://127.0.0.1:3211`，再用 Access 應用程式及 Service Auth 原則保護整個主機名稱。

在 LineBridge 填入主機名稱、Access 團隊網域與應用程式 AUD，貼上連接器權杖後按 **啟動連線**。每個 AI 請求還需要 LineBridge Bearer 權杖及 Cloudflare 的 `CF-Access-Client-Id`／`CF-Access-Client-Secret`。連接器連通不等於 Access 已驗證；後者需要實際請求的有效 JWT。

Tailscale Serve 是替代方案，使用私人 HTTPS 8443，AI 主機須加入同一個 tailnet。目前未實作 ngrok，也沒有提供雲端連接器的 OAuth 登入流程。

## 加密儲存與傳送

登入憑證、加密金鑰、監聽游標、訊息內容與通道權杖使用 AES-256-GCM；主金鑰由目前 Windows 使用者的 DPAPI 保護。帳號名稱、聊天室名稱與活動中繼資料仍是本機明文。活動紀錄不含訊息內容。

第一次使用 Rust 服務會在 `data/backups` 建立 SQLite 快照，沿用既有帳號、聊天室權限與加密憑證。請勿將 `data` 放入 Git，也不要同時執行舊版 Node 服務。更換 Windows 使用者或電腦無法直接解鎖此 DPAPI 金鑰。

每次傳送需要冪等識別碼。同一識別碼及內容只會傳送一次；結果不明時會保留 `delivery_unknown`，不自動重試。請先在 LINE 確認，再決定是否建立新的傳送。訊息內容是外部資料，不代表任何操作授權。

建置與測試步驟請參考 [README.md](README.md)，實際驗證範圍請參考 [VALIDATION.md](VALIDATION.md)。
