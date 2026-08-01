# VM HoYoLAB 登入流程

本文件說明如何登入部署在 Azure VM 上的 HoYoLAB 發布帳號。登入狀態只會儲存在 VM 的專用 Chrome profile，**不會**上傳至 Vercel，也不應從本機複製 cookies 或 Chrome profile。

## 安全設計

- worker 平時只在 VM 本機監聽；Vercel 透過 HTTPS 與 `bearer token` 呼叫它。
- 登入畫面只由 SSH tunnel 轉送至你的電腦 `127.0.0.1`。
- 不開放 VNC、noVNC 或 RDP 的公網連接埠。
- 登入完成後應關閉暫時圖形服務與 SSH tunnel，再重啟 worker。

## HoYoLAB 裝置身份

- HoYoLAB 官方頁面會使用專用 Chrome profile 內的 `_HYVUUID` 或 `_MHYUUID` Cookie 作為 `x-rpc-device_id`。
- worker 只會在該瀏覽器頁面內使用這個值，不會將它回傳至 Node.js、寫入工作紀錄、上傳至 Vercel 或顯示給使用者。
- 不要手動新增、複製、修改或刪除這些 Cookie。若工作階段失效，應重新執行完整登入流程。
- 登入期間與正式 worker 不可同時開啟同一個 Chrome profile，否則 profile 可能被鎖定或損壞。

## 登入步驟

1. 請管理員啟動臨時登入模式；此步驟會先停止 worker，避免專用 profile 被同時使用。
2. 在自己的電腦開啟管理員提供的本機網址，通常是：

   ```text
   http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale
   ```

3. 如看到 **Connect**，按下它，便會看到 VM 裡的專用 Chrome。
4. 在該 Chrome 登入目標 HoYoLAB 帳號，完成驗證碼或 MFA。
5. 等待 HoYoLAB 頁面完整顯示已登入狀態；只看到登入視窗消失並不足以證明 API session 已恢復。
6. 登入完成後，關閉 VM 畫面裡的 **Chrome 視窗**，不要只關閉 noVNC 分頁。
7. 告知管理員「已登入並關閉 Chrome」。管理員會驗證 Chrome 已退出、關閉臨時登入服務與 SSH tunnel，然後重啟 worker。

## 管理員完成檢查表

登入者關閉 VM 裡的 Chrome 後，管理員應依序完成：

1. 確認專用 Chrome 程序已完全退出。
2. 使用相同 profile 啟動 publisher，連續執行兩次不會寫入資料的「我的貼文」請求。
3. 兩次請求都成功後，關閉測試用 publisher。
4. 停止並移除臨時 Xvfb、VNC、noVNC 與 websockify 程序及暫存紀錄。
5. 關閉本機 SSH tunnel。
6. 啟動正式 worker，確認 VM 本機 `/health` 與公開 HTTPS `/health` 都回傳 `200` 及 `{"status":"ok"}`。

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

## 不要做的事

- 不要將本機 Chrome profile、cookies、密碼或 MFA 代碼傳送到 VM、Vercel 或其他人。
- 不要輸出、記錄或複製 `_HYVUUID`、`_MHYUUID` 或任何其他 Cookie 值。
- 不要將 noVNC、VNC、RDP 連接埠直接公開到網際網路。
- 不要在臨時登入期間讓 worker 同時執行。
