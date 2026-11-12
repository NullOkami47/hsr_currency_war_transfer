# Azure for Students 信用額監控器

2026-11-12。此交付提供收集器、純評估器與測試；主工作整合每日 Azure MI 執行、WIF uploader 及外部通知。所有結果均為 `notify-only`，不啟停 VM、不切換 Production、不建立 budget、不更改登入帳戶。Azure 仍為 Production。監控失敗或 credit 警告皆不構成切換授權。後續使用者明確授權後，本次另授予 worker 系統指派 MI 訂閱範圍的 Cost Management Reader；沒有加入 Monitoring Reader。

## 實際 API 支援及失敗證據

本機 Windows、Node v24.18.0、Azure CLI 2.88.0，透過已登入 CLI 取得短效 ARM token；token 只在程序記憶體中。2026-11-12 09:30 UTC 的唯讀探查確認訂閱為 Enabled、quotaId 為 `AzureForStudents_2018-01-01`。09:40 UTC 正式收集器重現以下結果，沒有推論餘額為零。

| 唯讀介面 | 版本／回應 | 判讀 |
| --- | --- | --- |
| `GET /subscriptions/{subscriptionId}` | `2022-12-01`，HTTP 200 | 確認目標確實為啟用的 Students 訂閱 |
| `GET /providers/Microsoft.Education` | `2021-04-01`，HTTP 200 | 廣告 Grants、labs 等資源類型；不代表支援 remaining balance |
| `GET /providers/Microsoft.Education/grants` | `2021-12-01-preview`，HTTP 200 | 一筆 Student grant。實際欄位為 displayName、offerType、effectiveDate、expirationDate、status、offerCap；沒有 remaining balance。provider 層級 grant 未證明綁定目標訂閱，連 expiry 也不自動套用 |
| `GET /subscriptions/{subscriptionId}/providers/Microsoft.Consumption/balances` | `2024-08-01`，HTTP 404；無可辨識 JSON error code | 該路徑不是官方文件所載的 billing-account balance 路徑；僅記錄不可用，不作 Students 餘額依據 |
| `GET /providers/Microsoft.Billing/billingAccounts` | `2024-04-01`，HTTP 200 | 一筆 MicrosoftCustomerAgreement 帳戶，不等同 Students／Sponsorship credit balance |
| `GET /providers/Microsoft.Billing/billingAccounts/{billingAccountId}/providers/Microsoft.Consumption/balances` | `2024-08-01`，HTTP 404，error code 字串 `404` | 官方 Consumption balances 路徑。錯誤內容為 `No billing period information found for the specified Enrollments:`，後接已遮蔽的識別碼。不能當作零餘額，也不能將不同帳務範圍的 balance 當作學生信用額 |
| `POST /subscriptions/{subscriptionId}/providers/Microsoft.CostManagement/query` | `2025-03-01`，HTTP 200 | 此 POST 只是唯讀查詢 ActualCost，沒有建立資源或設定 |

結論是**此次帳戶未取得可用的 Students remaining-credit API**，不是宣稱所有 Azure Students 或 Sponsorship 帳戶永遠沒有 API。Grants 的 `offerCap` 是額度上限、`allocatedBudget` 是分配預算，均不等於剩餘額。收集器刻意不解析任何 Consumption balance 為 Students balance；未來接新 adapter 必須先證明合約、訂閱／grant 範圍、幣別、有效時間與 remaining 欄位語意。

Microsoft 官方資料：

- [Students 使用量與預算](https://learn.microsoft.com/en-us/azure/education-hub/navigate-costs)：Education Hub 提供使用量、續期資訊與 budgets。
- [Students 停用與餘額查核](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/azurestudents-subscription-disabled)：官方指引以 Students 身分登入 Sponsorships portal 檢查 remaining credit 及 expiry。主工作既有紀錄中 browser identity 沒有 active Sponsorship，本次未改用 cookies 或未公開網站介面。
- [Consumption Balances](https://learn.microsoft.com/en-us/rest/api/consumption/balances/get-by-billing-account?view=rest-consumption-2024-08-01)：文件中的作用域是 billing account，非 subscription。
- [Microsoft 官方 Education REST 規格](https://github.com/Azure/azure-rest-api-specs/blob/main/specification/education/resource-manager/Microsoft.Education/Education/preview/2021-12-01-preview/education.json)：核對 Grants 路徑與欄位。

本次 live report 的 `balanceState=unknown`、`remainingUsd=null`、`runwayDays=null`，產生 `balance-missing`／`runway-unknown`，exit 1。官方成本查詢取 2026-11-04～10 七個完整 UTC 日，日均 USD 0.7075672235859313，與既有 `D:/CodexWork/free-worker-migration-evidence/gcp/azure-seven-day-cost.json` 一致。這是整個訂閱的成本代理，不能宣稱等於信用額扣款。沒有餘額就不能用成本反推起始 USD100 尚餘多少。

## 執行與主工作整合

### 外部監控 artifact 合約

`collectCredit({subscriptionId, now?, balance?, previousBalance?, request, timeoutMs?})` 回傳 JSON-safe `{format, report, diagnostics}`。`format` 固定為 `hsr-azure-student-credit-monitor/v1`。request 的合約為 `(ARM_PATH, {method, body?, timeoutMs}) => Promise<{status, body}>`，body 為解析後 JSON；內建 `boundedJsonRequest(path, {token, ...options})` 可直接使用。

`report` 包含 `checkedAt`（UTC）、`action=notify-only`、`severity`（ok/warning/critical）、`balanceState`（known/unknown/stale）、`remainingUsd`、`balanceAsOf`、`estimatedRemainingUsd`、`estimateAsOf`、`dailyBurnUsd`、`burnRateBasis`、`runwayDays`、`warnings[]`、`alertCodes[]`、`thresholdsActive`。數字未知一律為 null。diagnostics 只包含 endpoint 代號、HTTP status（或 null）及短 error code（或 null）。

當 `balanceState !== known`，**必定**輸出 `CREDIT_BALANCE_UNAVAILABLE`；stale 另加 `CREDIT_BALANCE_STALE`。此時 `thresholdsActive.authoritativeUsd=false`，外部監控必須警告資料不可用，不能宣稱真實 USD20／10 門檻正在工作。只有真實可信額可發出 `CREDIT_USD_20`／`CREDIT_USD_10`；估算另用 `CREDIT_ESTIMATED_USD_20`／`CREDIT_ESTIMATED_USD_10`／`CREDIT_ESTIMATED_EXHAUSTION`。runway 未知用 `CREDIT_RUNWAY_UNAVAILABLE`，≤5 日用 `CREDIT_RUNWAY_5_DAYS`。`thresholdsActive` 分列 authoritativeUsd／estimatedUsd／runway，三者獨立。

主工作的既有 WIF uploader 應原樣保存此遮蔽 artifact 至 GCS `monitor/credit/`；寫入每次 UTC／內容 hash 命名的不可變 JSON，以及 `monitor/credit/latest.json` 最新指標／副本，並沿用外部 monitor 的 freshness、immutable-write 與通知規則。uploader 必須在 collector exit 1 時仍保存證據；exit 1 是缺資料或警告的正常輸出，不是應丟棄 stdout 的失敗。此模組不持有 GCS credentials、不讀 WIF 憑證、不另造 uploader，也不存原始 Azure 回應。

使用 Node >=20、已登入且具目標訂閱唯讀權限的 Azure CLI。新增程式沒有第三方相依套件。Windows 自動以 `where.exe az.cmd` 尋找 MSI CLI 隨附的 Python，直接執行 `python.exe -IBm azure.cli`，不使用 shell 拼接。其他安裝可傳 `--azure-cli-python` 絕對路徑；Linux 預設直接執行 `az`。

```powershell
# 在主工作整合後的 checkout 執行；不執行 az account set。
node scripts/infrastructure/azure-student-credit-monitor.mjs collect --subscription '<subscription-uuid>'

# Azure VM 的每日收集模式：直接固定 IMDS，無需 az login 或 Azure CLI。
node scripts/infrastructure/azure-student-credit-monitor.mjs collect --subscription '<subscription-uuid>' --auth managed-identity

# 檔案必須是本機受保護、未納入 Git 的官方查核快照。
node scripts/infrastructure/azure-student-credit-monitor.mjs collect --subscription '<subscription-uuid>' --balance-file 'D:/CodexWork/private-credit-monitor/latest.json' --previous-balance-file 'D:/CodexWork/private-credit-monitor/previous.json'

# 離線純評估；input 為 {subscriptionId, now, balance, previousBalance, costs}。
node scripts/infrastructure/azure-student-credit-monitor.mjs evaluate --input 'D:/CodexWork/private-credit-monitor/evaluation.json'
node --test test/azure-student-credit-monitor.test.mjs
```

stdout 只輸出白名單欄位的 report／diagnostics，不輸出訂閱 ID、帳戶 ID、API 原始訊息、headers、token 或輸入檔內容。invalid input 的 stderr 為固定文字。正常 0；任何 warning／critical／unknown 為 1；輸入錯誤為 2。沒有自動保存檔案；主工作可將 stdout 存至 D 槽受保護目錄，讀取 exit code 並送到既有警告管道。不得將 exit 1 當作無需處理的普通成功。

主工作每天執行一次，設定外部 90 秒程序期限，監看最近成功執行時間；即使日誌沒有新警告，也必須能偵測排程完全沒跑。exit 2、程序被殺或連續沒有新報告都應警告。此變更尚未安裝排程／WIF uploader／通知服務／CI。授權後僅新增上述 MI RBAC；未自動發信，也沒有將本機私密資料上傳到第三方。

CLI token 取得上限 15 秒；Windows CLI 搜尋上限 5 秒；每次 HTTP 絕對期限 10 秒、最多六次，無重試、無分頁追蹤、無 redirect。只向固定 `https://management.azure.com` 原生 HTTPS 連線，不讀 proxy 環境設定；回應最多 1 MiB。401／403／404／429／5xx、逾時、無法登入、無法辨識 schema 均保留 unknown 警告。多個或分頁 billing accounts 不猜測應選哪一個。

MI 模式只向 `169.254.169.254` 的固定 IMDS token 路徑 GET，要求 `Metadata: true`，5 秒期限、64 KiB 上限、不經 proxy、不跟 redirect。驗證 Bearer、ARM resource、token 到期時間，整次 collection 共用該短效 token；不回退 CLI 或其他 identity。`managedIdentityToken()` 僅供同程序組合，回傳值不得寫到報告或交給 uploader。Cost Management Reader 已含 subscription read 及 CostManagement read；Education／Billing provider 層級仍可能 403，這些 discovery 失敗不會阻擋獨立 subscription cost query，也不會授予額外 provider 權限。

2026-11-12 10:07 UTC 已建立該 MI 的 subscription Cost Management Reader，保留既有 container Blob Data Contributor。直接 SSH 唯讀 MI probe 因連線逾時未能進入 VM，因此 **MI 實際 token／成本查詢仍待主工作在 Azure 執行驗證**；不能以 RBAC assignment 或本機 CLI HTTP200 宣稱 MI end-to-end 已成功。此步未改 NSG、未開 port、未呼叫 VM Run Command、未部署排程。

本機 JSON 僅接受絕對路徑的一般檔案，拒絕符號連結／目錄、限制 256 KiB。Linux 整合時應由管理員設為 owner-only；Windows 應限制 ACL。不要把快照、token、私鑰、cookies、production state 或原始帳務回應提交 Git。

## 官方人工快照合約

以下為純合成範例，**不是實際餘額**。來源必須由負責者在 Microsoft 官方頁面核對；欄位名稱不提供密碼學認證，輸入檔的權限與真實性由部署者負責。

```json
{
  "subscriptionId": "11111111-1111-4111-8111-111111111111",
  "source": "azure-students-portal",
  "remaining": 24,
  "currency": "USD",
  "asOf": "2026-11-12T00:00:00.000Z",
  "observedAt": "2026-11-12T00:00:00.000Z",
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "creditPeriod": "synthetic-2026-grant"
}
```

`source` 只接受 `azure-students-portal` 或 `azure-sponsorship-portal`；兩者都必須核對到同一目標訂閱。`asOf` 是官方數字的有效時間，`observedAt` 是查核時間；重新讀取舊快照不會延長有效時間。兩者需為 UTC、不得在未來、asOf 不得晚於 observedAt。若官方資料延遲，保留真實 asOf；無法判定其有效時間時保持 unknown，不填入虛構時間。

`remaining` 只接受有限非負數字，明確的官方數字 0 才代表 0。只接受權威 USD；不依貨幣符號、地區、GCP 畫面金額或硬編碼匯率轉換。此版本沒有 FX adapter，所有非 USD 都為 unknown；未來若加入換匯必須使用官方匯率、來源與有效時間。`expiresAt` 可省略，但保留 `expiry-unknown` 資訊；提供後必須是有效 UTC。`creditPeriod` 是同一 grant／續期期別識別，用來防止跨續期計算 burn rate；沒有期別就不使用兩筆餘額差。

## 評估與估算

| 條件 | 結果 |
| --- | --- |
| remaining ≤USD20 | warning；含等號 |
| remaining ≤USD10 | critical；同時保留 USD20 警告 |
| runway ≤5 天 | critical；與金額條件是 OR |
| missing／invalid／non-USD balance | unknown、缺資料警告；不填 0 |
| 餘額 asOf 或 observedAt 超過 24 小時 | stale、`remainingUsd=null`；保持 stale 警告 |
| 官方 expiry 已到 | critical、runway 0；不自行斷定餘額數字為 0 |

Cost Management 每次讀取七個完整 UTC 日，排除今天與昨天以留資料延遲空間。必須七日全部存在、每日唯一、非負數字、同為 USD、同訂閱、collection 不超過 24 小時、coverage 結束不超過 72 小時。缺日、空列、退款負數、混幣或 nextLink 都使成本代理 unknown；不補零。即使七日齊全，帳務仍可能回補，故只稱 cost proxy。

以每日平均成本估 runway；若有兩筆同來源、同訂閱、同幣別、同 expiry、同非空 creditPeriod 的可信餘額，相隔 1～30 日且較新一筆不超過 24 小時，才可用正數的 `(前額－後額)/天數` 作另一估算。加值、跨續期、重複／反序觀測不作 burn。兩種 rate 同時有效時取較大值，report 明列 `burnRateBasis`。零消耗不代表無限 runway，保留 unknown；有官方 expiry 時可用 expiry 上限警告。

較舊可信餘額若落在成本 coverage 內、恰為 UTC 午夜、最多七日舊，且之後完整日資料齊全，計算「最後可信額－之後完整日成本」。結果只填 `estimatedRemainingUsd`／`estimateAsOf`，不填 authoritative remaining，不假裝成本一定抵扣學生信用額。低額以 `estimated-` 警告；扣至零標記 `estimated-exhaustion`，不是宣稱官方餘額為零。午夜以外無法切開 daily costs，故不做該差額估算。沒有可用差額時，歷史低額可產生 `last-trusted-` 警告，但不據此建立今天的 runway。

runway 會扣除 amount asOf 到檢查時間尚未覆蓋的經過天數，並與官方 expiry 取較小值。它是線性估計，不能保證避免資源尖峰、成本延遲、續期、退款或扣款範圍變化。任何 stale／missing balance 警告均不會因估算看似足夠而消失。

## 驗證與交接

專屬測試涵蓋 inclusive 門檻、OR runway、真零與錯誤、scope／來源／幣別、過期／不合法／未來時間、expiry、成本欄位順序／分頁／缺日／退款、兩種 delta、更新／續期、錯誤遮蔽、請求數量／唯讀方法、無回應期限與檔案限制。live collector 實測拿到成本，但學生餘額仍 unknown，不能宣稱 credit alerts 已部署或已接上自動通知。

只交付三個指定檔案。主工作整合時保留現有備份、GCP standby／HTTPS 與切換程序，不複製或改造它們。Simular Box 工具在本次環境不可用，因此採 D 槽 Windows 本機驗證；提交後以相同 SHA 全新 checkout、乾淨 `npm ci --ignore-scripts` 及全套 `node --test` 重驗，另存 runtime、命令、exit code 與 test counts 至 D 槽證據目錄。
