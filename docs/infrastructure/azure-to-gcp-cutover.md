# Azure → GCP 切換與回復程序

2026-11-12。**Azure 繼續 Production。執行切換需該次明確 GO；不是 PR merge、測試綠燈或 credit alert 就自動切換。** 本程序尚無真實跨 VM rehearsal，狀態為 PARTIAL。

## 設定與來源

以 `backup:inspect` 找到來源三檔、User、service、cwd；目前正式來源實測值記錄於 [Azure 備份](azure-worker-backup.md)。來源 token、環境檔、SSH key、瀏覽器與 DB 都不進 Git、Box 或公用儲存。GCP 目標路徑應由已安裝服務的實際環境再次發現，不自動套用 Azure 路徑。

唯一正式 publisher 必須在整個流程中可被證明。`publicSubmissionsEnabled=false` 只拒絕新提交，不代表現有 queue 停止。`systemctl stop` 也不代表先前工作已排空。不能在未核對 queued/running 的情況下依賴 worker 的 SIGTERM handler。

## 切換前條件

- e2-micro、IPv6/egress、HTTPS、staging Vercel、job/quotas/security/restart 測試已完成；資源、free-tier 和 alerts 再查核。若需 paid fallback，另行核准。
- Azure 尚有足夠 credits/可回復時間；存在外部加密 archive、可用 recovery key 和實際還原演練。
- GCP synthetic service 停止，未匯入正式資料；在 GCP **重新**完成專用 HoYoLAB login/MFA，兩次連續 authenticated read-only API 成功。Chrome profiles/cookies/device identity 不搬移。
- 正式 GCP publisher 仍停止；沒有第二個使用同帳號的 queue。記錄雙方 systemctl/PID、profile owner、code SHA、state manifest 與時間。
- 核准 exact Vercel project/environment（Production）、舊/新 worker `/jobs` URL、對應 secret 管理方式。不能僅拿 repo 的另一個 Vercel remote 名稱當成 deployed project 證據。
- 核准策略測試才可進行一次 live transfer；記錄成功 Global code、重新抓取內容、mapping、重啟及 duplicate suppression。沒有此核准不得建立/修改/刪除真實策略。

## gcp-cutover：經 GO 後執行的順序

1. 保存 GO 的 exact source/destination identity、reviewed SHA、收據和有效時窗；通知維護操作人員停止並行管理寫入。
2. `npm run gcp:preflight -- <private-config>`；`gcp:start` 只用於合成標記/有時限的 staging machine。真正 Production 的啟動/期限變更需使用已核准的 cutover 指令，不能為繞過 guard 任意改 labels。
3. 驗證新機 HTTPS、origin strict TLS、健康、fresh login、兩次 authenticated read-only 及必要的授權測試；正式 queue 保持停止。
4. 在既有 Azure `/admin` 關閉公開提交；保存原政策。凍結會修改 security/admin state 的管理請求並暫停相關 API 維護操作。等候 dashboard `stats.queued=0`、`stats.running=0`。超時或不確定 publish 結果就停止切換；先唯讀核對 upstream，不能重發 create。
5. **經 GO 才**停止 Azure `hsr-transfer-worker.service`，核對 inactive/dead、MainPID=0、無手動 writer/profile 使用者。保留 Azure VM、Chrome profile、disks、Caddy 和 recovery configuration。
6. 使用低階 `backup:snapshot` 做 final consistent archive。**不能用日常 coordinated 工具**，它會自動重啟 Azure。把 ciphertext/receipt 傳至核准的 off-VM host，checksum + decrypt + manifest 驗證，再將三檔還原到新的隔離目錄。
7. GCP publisher 保持停止，將三檔透過已驗證 SSH 安全傳輸至目標。以 manifest 核對每個 byte length/hash、job counts/status、source-to-Global mappings、quota events/blockedUntil、policy、security limits/revocations。不可只複製 `transfers.json`；不可把缺少 quota 當成零。
8. 以 GCP 專用 service User、0700 directory、0600 state 安裝完整 state set；保存目標原來的合成資料於非啟動目錄，**不覆蓋或匯入 browser profile**。明確保留 `publicSubmissionsEnabled=false`。若要改 token，與 API 一起協調，保持 client hash keys/quota identity 穩定。
9. 啟動 GCP **唯一**正式 worker；再核對 Azure inactive 與 GCP single PID、profile lock、state paths。兩台 publisher 同時 active 就立即中止，不開公開提交。
10. 只更新經核准 Vercel Production 的 `CURRENCY_WAR_WORKER_URL`；若核准 token rotation，同時更新 `CURRENCY_WAR_WORKER_TOKEN`。`CURRENCY_WAR_CLIENT_HASH_SECRET` 應保持穩定；不要改 admin password/TOTP/hash secret 來「修復」部署。套用必要 Vercel deployment/environment 生效流程。
11. 從實際 Vercel Function 驗證 health、401 rejection、authorized polling/admin。確認 `/admin` 可登入；不要用假的測試頁聲稱部署成功。
12. 所有 smoke checks 成功後，依保存的原政策恢復公開提交；監看 authentication、job latency、duplicates、quota、Caddy 4xx/5xx 和 systemd logs。Azure 仍可 rollback，但不要重啟舊 queue。

## gcp-rollback：必須反向移轉最新狀態

1. 判斷 Azure credits、服務和 fresh session 仍可用。若 credit 已耗盡且訂閱停用，Azure rollback 可能不可行；不要承諾一定可回去。
2. 在 GCP 關閉新提交、凍結管理寫入、排空或人工 reconciliation 所有 queued/running/ambiguous jobs；**不重新送出不確定的 HoYoLAB create**。
3. 停止 GCP publisher；同樣做 final consistent encrypted backup 至外部主機並驗證。
4. Azure 保持 stopped。比較 cutover archive 與最新 GCP archive，以 GCP 的 completed results/mappings/quota/security 為新權威；檢查衝突和撤銷狀態。**不能**直接啟動 Azure 舊 state 或用舊備份倒蓋已發生的策略。
5. 在 Azure 使用完整三檔最新一致 state，核對 manifest/權限；使用 Azure 原 profile，必要時重新登入，從不從 GCP 匯出 cookies。
6. 確認 GCP publisher stopped，啟動唯一 Azure publisher，更新回經核准的 Vercel `/jobs` URL/paired token，跑 smoke，最後再開公開提交。
7. 回報兩機最終 power/service state 和最新 archive。不要自動刪除 GCP disk 或 decommission Azure。

`gcp-cutover`/`gcp-rollback` 目前是本文件的受控操作序列，**沒有宣稱一鍵自動執行已實作或已測通**。自動控制只涵蓋獨立 staging start/verify/stop 與備份工具。正式整合指令需在 account/project/domain/backup gates 解決後完成真實演練；不能靠人工填 true 的 JSON 收據取代驗證。

## Azure credits 與警示

2026-11-12 已以 Azure CLI 確認 Azure for Students 訂閱 Enabled、worker running。Sponsorship portal 在目前 browser identity 顯示沒有 active Sponsorship；Consumption balances API 回傳 Not Found，不能從這些結果推論 credit=0。

Cost Management 的實際唯讀查詢取得 2026-11-04～10 七日總成本 USD 4.952970565101519，日均約 USD 0.70757。前兩日包含較高歷史費用；11-06～10 五日約 USD 0.47805/day，較接近最近基線。這是**整個訂閱**的成本，不是只算 worker，也不是已確認學生 credit 扣款數或餘額。

餘額/到期日未取得，故剩餘天數 **UNKNOWN**。計算方式為官方 remaining credit 除最近完整日的移動平均，對 spike 和資料延遲留裕量。

在官方 Sponsorship balance 頁，以該 Azure for Students 訂閱真正的持有人登入，記錄查核 UTC、remaining、expiry。對照 Cost Management 完整日資料。餘額 ≤US$20 開始切換準備；≤US$10 或 estimated days ≤5 緊急警示。警示只提醒，永不自動 cut over。

目前未設定可讀取正確 student balance 的自動 notification，沒有匯出長效 Azure credentials。Azure 成本 budget 可以作為輔助，但不等同精確 remaining student-credit alert。帳號/官方 API 解決前，採用每天人工查核官方 balance + 更新計算；這是已準備的手動程序，不能標成 alerts configured。

官方說明：[學生 credit 與 Cost Management](https://learn.microsoft.com/en-us/azure/education-hub/navigate-costs)、[Sponsorship balance](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/azurestudents-subscription-disabled)。
