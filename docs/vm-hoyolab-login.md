# VM HoYoLAB 登入流程

本文件說明如何登入部署在 Azure VM 上的 HoYoLAB 發布帳號。登入狀態只會儲存在 VM 的專用 Chrome profile，**不會**上傳至 Vercel，也不應從本機複製 cookies 或 Chrome profile。

## 安全設計

- worker 平時只在 VM 本機監聽；Vercel 透過 HTTPS 與 `bearer token` 呼叫它。
- 登入畫面使用網站既有的 HTTPS 443，並放在每次隨機產生的 48 字元路徑之下；noVNC 另有一次性密碼。
- VNC 與 noVNC 仍只監聽 VM 的 `127.0.0.1`，不開放新的 Azure NSG、VNC、noVNC 或 RDP 公網連接埠。
- 登入完成後執行 `stop`，會還原原本的 Caddy 設定、關閉暫時圖形服務並重啟 worker。

## HoYoLAB 裝置身份

- HoYoLAB 官方頁面會使用專用 Chrome profile 內的 `_HYVUUID` 或 `_MHYUUID` Cookie 作為 `x-rpc-device_id`。
- worker 只會在該瀏覽器頁面內使用這個值，不會將它回傳至 Node.js、寫入工作紀錄、上傳至 Vercel 或顯示給使用者。
- 不要手動新增、複製、修改或刪除這些 Cookie。若工作階段失效，應重新執行完整登入流程。
- 登入期間與正式 worker 不可同時開啟同一個 Chrome profile，否則 profile 可能被鎖定或損壞。

## 登入步驟

1. 在 VM 的 repository 目錄執行以下命令；此步驟會先停止 worker，避免專用 profile 被同時使用：

   ```sh
   sudo npm run vm:login -- start
   ```

2. 命令只會在這一次顯示臨時 HTTPS 網址與 VNC 密碼。開啟該網址並輸入密碼；如看到 **Connect**，按下它便會看到 VM 裡的專用 Chrome。
3. 在該 Chrome 登入目標 HoYoLAB 帳號，完成驗證碼或 MFA。
4. 等待 Currency Wars 頁面完整顯示已登入狀態；只看到登入視窗消失並不足以證明 API session 已恢復。
5. 登入完成後，在 repository 目錄立即執行：

   ```sh
   sudo npm run vm:login -- stop
   ```

若要確認目前是否仍在臨時登入模式，可執行 `sudo npm run vm:login -- status`。基於安全理由，`status` 不會再次顯示 VNC 密碼；若遺失密碼，請先 `stop` 再重新 `start`。

## 管理員完成檢查表

登入者關閉 VM 裡的 Chrome 後，管理員應依序完成：

1. 確認專用 Chrome 程序已完全退出。
2. 使用相同 profile 啟動 publisher，連續執行兩次不會寫入資料的「我的貼文」請求。
3. 兩次請求都成功後，關閉測試用 publisher。
4. 執行 `stop`，停止臨時 Xvfb、Chrome、VNC、noVNC 與 websockify transient services，並刪除臨時密碼、路徑與備份。
5. 確認原本 Caddy 設定已還原，正式 worker 已啟動，而且 VM 本機 `/health` 與公開 HTTPS `/health` 都回傳 `200` 及 `{"status":"ok"}`。

唯讀驗證只能確認登入與裝置身份可連續使用，不會建立或修改攻略。真正的發布驗證仍須由管理員或使用者明確指定來源攻略。

## 驗證與故障排除

- 登入後應先做兩次連續唯讀驗證；只做一次無法檢查「第一筆成功、第二筆登入失效」的問題。
- 真正的發布測試必須由管理員或使用者明確指定策略，因為它可能建立或更新 Global 策略。
- worker 第一次收到 `Login expired. Please log in again` 時，會自動重新載入 Currency Wars 事件頁、等待八秒，再重試原請求；第二次仍失敗時，會完整關閉並重建瀏覽器 context、再等待八秒後作最後一次嘗試，不會無限重試。
- 若 VM Chrome 本來就顯示帳號已登入，通常只需讓事件頁完整載入以刷新 API session，不必先登出再登入。
- 若完整重建瀏覽器 context 後仍然失敗，請記下失敗時間與工作 ID，再啟動臨時登入模式。只有全新 context 仍持續回 `retcode -100` 時，才需要真正登出並重新登入。
- HoYoLAB 頁面看起來已登入，不代表發布 API session 一定有效；以連續兩次唯讀請求的結果為準。
- 若第一筆發布成功、第二筆立即登入失效，應確認 worker 使用的是官方 Cookie 對應的 `x-rpc-device_id`，而不是自行產生的 UUID。
- 變更 Wi-Fi、行動網路或 ISP 後，管理員的公網 IP 可能改變；此時需在 Azure 的網路安全性規則更新 SSH 的來源 IP，網站的 80/443 不受影響。

## Session keepalive 與診斷日誌

- worker 預設每 360 分鐘執行一次唯讀的「我的貼文」請求。這有助於維持可能採用滑動到期的 session，但 HoYoLAB 仍可因帳號安全政策、伺服器撤銷或固定期限要求重新登入，因此無法保證永久有效。
- 可用 `CURRENCY_WAR_SESSION_KEEPALIVE_MINUTES` 調整間隔；設為 `0` 會停用，最大值為 10080 分鐘。
- 日誌只會記錄 `keepalive_ok`、`keepalive_failed`、`auth_recovery`、`auth_recovered`、HTTP status 與 API retcode 等診斷欄位，不會記錄 Cookie、裝置 ID、請求 payload、profile 內容或上游回應訊息。
- VM 上可用以下命令查看最近事件：

  ```sh
  sudo journalctl -u hsr-transfer-worker.service --since "24 hours ago" --no-pager \
    | grep '\[publishing-session\]'
  ```

- `auth_recovery` 的 `action` 會顯示 worker 採用 `reload_event_page` 或 `rebuild_browser_context`；連續出現 `retcode:-100` 且沒有 `auth_recovered`，才代表需要管理員重新登入。

## 不要做的事

- 不要將本機 Chrome profile、cookies、密碼或 MFA 代碼傳送到 VM、Vercel 或其他人。
- 不要輸出、記錄或複製 `_HYVUUID`、`_MHYUUID` 或任何其他 Cookie 值。
- 不要分享臨時登入網址或 VNC 密碼，也不要讓臨時登入模式在完成登入後繼續運作。
- 不要將 noVNC、VNC、RDP 連接埠直接公開到網際網路。
- 不要在臨時登入期間讓 worker 同時執行。
