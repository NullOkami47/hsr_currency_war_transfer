# HSR 遷移：Google Cloud 信用額、成本保護與試算

查核日：2026-11-12（香港時間）。僅使用 Google 官方公開資料；未登入或檢查任何帳戶、帳單、信用額、專案、API 或瀏覽器，也未建立資源。附件提及 2026-11-11 升級、2027-02-10 到期及信用額餘額，以下均視為**使用者提供、未驗證**的前提。本文是交給遷移負責代理的研究，並非部署或端到端驗證。

## 重要結論

1. Google Developer Program 的一般每月 Google Cloud 信用額，原則上可用於符合資格的 Cloud Run 與 Compute Engine，但應由負責帳戶的代理核對每筆促銷的 SKU 範圍、有效期、餘額及帳戶；不能把僅限 GenAI 的舊式信用額視為通用額度。來源：[Developer Program 福利 FAQ](https://developers.google.com/profile/help/benefits?hl=en)、[促銷排除項目](https://cloud.google.com/skus/exclusions)。
2. **DEVELOPER_CREDIT_PRIORITY_UNKNOWN**：Google 文件說符合條件的促銷信用額會自動套用；本次未找到官方文件明定 Free Trial 和這一 Developer Program 信用額同時適用時誰先扣，也未找到可指定抵扣順序的官方設定。這不證明不存在設定；不能宣稱一定 Trial 先扣，亦不能承諾先扣 Developer 或保留 Trial。應詢問 Google Cloud Billing Support，並以延遲處理後的實際 SKU 信用額明細核對；單憑可用餘額不能推論。來源：[帳單費用與信用額](https://docs.cloud.google.com/billing/docs/how-to/cost-table)、[預算與 savings 設定](https://docs.cloud.google.com/billing/docs/how-to/budgets)。
3. **11 月 16 日門檻是註冊或升級日期，不是使用日期**：官方寫明，自 2026-11-16 起註冊 Free Trial **或**升級付費帳戶者，$300 Welcome credit 不可用於 Gemini platform（以前稱 Vertex AI）服務。如果同一試用帳戶確實在 11 月 11 日升級，依文件字面，這項新排除條件不因 11 月 16 日到來就自動套用；這只是條款解讀，不是指定模型、SKU、帳戶或後續政策的抵扣保證。升級不延長原始 90 天有效期；先確認具體 promotion scope 和 Gemini model SKU，必要時向 Billing Support 求書面確認。來源：[Free Trial 條款與限制](https://docs.cloud.google.com/free/docs/free-cloud-features)。
4. Google AI Studio 的 Gemini Developer API 是另一條計費路徑；官方對 2026 年 3 月後新開帳戶的 Welcome credit 排除該 API／AI Studio。不要把 Vertex AI 的日期規則混成 Gemini Developer API 規則。符合資格的 Developer Program 一般信用額可以用於 Gemini API，但若被分配 Prepay，必須先有正數的已付款預付餘額，促銷額才會優先於預付餘額扣除；預付餘額歸零後促銷額也不再扣。文件指出管線延遲仍可造成超額。**這不是 Trial 與 Developer 促銷額之間的優先順序**；不建議為研究購買預付額或開啟自動加值。來源：[Gemini API 計費](https://ai.google.dev/gemini-api/docs/billing)、[Developer Program FAQ](https://developers.google.com/profile/help/faq)。
5. 一般 budget 只警示、不阻止支出；Cloud Run spend cap 是較強的服務級管制，但不是零現金支出保證，且作用於整個專案的 Cloud Run 資源類型，而非單一 Cloud Run 服務。其他服務與延遲超額仍可能收費。來源：[預算](https://docs.cloud.google.com/billing/docs/how-to/budgets)、[spend caps](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)、[Cloud Run 計費設定](https://docs.cloud.google.com/run/docs/configuring/billing-settings)。

## 信用額的性質、範圍與帳戶分配

- **Free Tier** 是符合條件資源用量的優惠，並非可自由搬移的現金餘額；Cloud Run 免費額度跨同一 billing account 下的專案合計，按月重設，且以 Tier 1 定價為基礎做支出型折抵。不同地區、SKU、計費方式需重新計算。來源：[Cloud Run 定價](https://cloud.google.com/run/pricing)。
- **$300 Welcome／Free Trial**：升級會結束 Free Trial，但剩餘額度可於原始註冊日起 90 天內支付符合條件的費用。付費帳戶不再具有試用期「不會收費」的保障：超過免費額度、未獲信用額涵蓋或在信用額用完、過期之後的使用可向付款方式收費。[來源](https://docs.cloud.google.com/free/docs/free-cloud-features)。
- **Google AI Pro 的一般每月 Cloud 額度**：官方目前列 US$10／月；發放日依首次啟用開發者福利的每月週年日，非固定每月 1 日；月度額度自授予日起一年到期。按兌換時匯率換算成 billing account 貨幣。可選擇讓未來每月額度自動套用到指定 billing account；如果未啟用該選項，要逐期領取。是否已開啟、授予或有餘額均未查核。[福利 FAQ](https://developers.google.com/profile/help/benefits?hl=en)；[方案](https://developers.google.com/program/plans-and-pricing)。
- 同一 billing account 的專案共用其可用的適格帳戶信用額；另建專案可協助費用歸類，**不能據此保證特定促銷額度優先或保留 Trial**。每筆該 Developer 信用額只能套用一個 billing account；不同 billing account 不會自然共用，換帳戶可能使原有信用額不可用並產生現金風險。不要新建帳戶當作保證解法。[Developer Program FAQ](https://developers.google.com/profile/help/benefits?hl=en)、[Google Billing account 資訊](https://docs.cloud.google.com/billing/docs/concepts)。
- 官方資料存在需要個別確認的張力：Developer Program FAQ 將 Gemini API／AI Studio 與 Agent Platform 列為可用範圍，同時連結的 Discount Exclusions 清單列出 Generative AI。不能假設清單適用於每筆促銷的所有 AI SKU，亦不能忽略該排除項；應依具體促銷條款及 SKU 向 Google 確認。[福利 FAQ](https://developers.google.com/profile/help/benefits?hl=en)、[排除清單](https://cloud.google.com/skus/exclusions)。
- 舊版獨立 Premium 的 $50 GenAI 額度僅限所列 AI Studio／Agent Platform 模型及 SKU，不代表可支付 Cloud Run 或 VM；不可用「Premium」字樣推斷信用額內容。[來源](https://developers.google.com/profile/help/benefits?hl=en)。
- 經授權的帳戶負責者應以 Credits 頁核對各筆名稱、Credit ID、scope、起訖與實際餘額，再依 billing report 或 Cost Table 的 project、service、SKU、credit ID 與使用時段對帳。這些均是待查項，不能以本文或試算聲稱已發生。[Credits 與明細](https://docs.cloud.google.com/billing/docs/how-to/resolve-issues)、[費用表](https://docs.cloud.google.com/billing/docs/how-to/cost-table)。

## 預算與 spend cap：建議供帳戶負責代理評估

- 建立專案月預算 US$5 等值：如要**真正觀察原價 gross**，所有 Savings 類別都不選，包含 Free Tier 與 promotions；若只排除 promotional credit，Free Tier 仍會降低顯示費用。實際 50%、75%、90%、100% 及 100% forecast 規則需由負責者檢查介面是否可設及接收者。另設納入所有 savings 的小額淨支出預算、帳戶層全部專案預算；通知寄給所選角色時，預設包含 Billing Account Administrators **及 Billing Account Users**，而非自動保證只寄管理員。明細、發票、信用額更新可能延遲或負值，不能以淨預算替代支付保障。[預算文件](https://docs.cloud.google.com/billing/docs/how-to/budgets)。
- 若帳戶支援：Spend cap 限一個專案、一個 eligible Google Cloud **service**（Cloud Run API，非單一 Run service）、曆月；以不含 Free Tier 和促銷等 savings 的 gross 預估成本達上限執行，通知通常在 50%、80%、100%。此 cap 涵蓋該專案所有 Cloud Run 資源類型，可能使服務 5xx、Jobs 無法開始或完成；會影響可用性。一般 cap 文件稱 in-flight requests 完成，而 Cloud Run 專頁明確警告執行中的 Jobs 可能無法完成；工作須能安全恢復，不應假設所有執行都完整。下一月自動解除；人工提前解除後，除非提高上限，該月不會再觸發。[Spend cap](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)、[Cloud Run 影響](https://docs.cloud.google.com/run/docs/configuring/billing-settings)。
- Spend cap 執行非即時，超額正常計費；其他產品如 Storage、Firestore、Artifact Registry、Cloud Build、Compute Engine 的 VPC connector VM，以及持續性資源／固定成本不受 Cloud Run cap 覆蓋。Google 指帳單實際明細通常一天內但可能超過 24 小時，程式通知也可能延遲或重複。因此沒有全帳戶零元支出的硬性保證。[Spend cap 限制](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)、[程式通知](https://docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications)。
- 最小實例 0、合理 max instances／並行數、時間上限與 CPU／RAM、嚴格應用層配額、控制重試與輪詢、日誌和網路流量能降低風險但無法確保零元。max instances 不是可靠的持久鎖；request-based service 僅在啟動、停止及請求期間配置／計價 CPU，不能假定回應後背景處理能可靠完成。Jobs 使用 instance-based 計費。[Cloud Run 計費](https://docs.cloud.google.com/run/docs/configuring/billing-settings)。
- 換匯以帳戶本幣實際價格與兌換結果為準；附件 HK$78.46／US$10 只能用作歷史上下文，不可作即時匯率。不得把 cap 設定或通知送達視為本文已觀察到的事實。

## 免費額度與候選成本陷阱

| 產品 | 公開免費用量與重要條件 |
|---|---|
| Cloud Run service request-based | 每 billing account 每月 180,000 vCPU-s、360,000 GiB-s、200 萬請求；Tier 1 基礎，跨專案共用；網路另計。Jobs／instance-based 的 CPU 與 RAM 免費額度不同，不可混用。 [定價](https://cloud.google.com/run/pricing) |
| Cloud Tasks | 每月前 100 萬計費操作免費；API 呼叫與推送嘗試都算，按 32 KiB 分塊，重試也會增加用量。[定價](https://cloud.google.com/tasks/pricing) |
| Firestore | 公開 Free Tier 表列 1 GiB 儲存、每日 50,000 讀、20,000 寫、20,000 刪及每月 10 GiB 出站；須核對資料庫、地區、索引、其他項目與免費資格，不能推論任意架構全免費。[免費用量](https://docs.cloud.google.com/free/docs/free-cloud-features)、[Firestore 定價](https://cloud.google.com/firestore/pricing) |
| Cloud Storage | 特定美國地區 regional storage 5 GB-month、5,000 Class A、50,000 Class B；出站優惠有目的地條件，不能套用到其他地區或所有網路。[免費用量](https://docs.cloud.google.com/free/docs/free-cloud-features) |
| Secret Manager | 每月 6 個 active secret versions、10,000 次 access operations；位置、版本與存取次數皆影響成本。[定價](https://cloud.google.com/secret-manager/pricing) |
| Artifact Registry | 每個帳單帳戶 0.5 GiB-month 免費；超過的映像大小、傳輸另計，Playwright 映像可能很大但本次未量測。[定價](https://cloud.google.com/artifact-registry/pricing) |
| Compute Engine | 指定美國區域合計一台 e2-micro 對應一個月時數，外加 30 GB-month standard persistent disk；其他磁碟、備份、流量等另計。e2-micro 的 Chrome 記憶體是否足夠未測。[Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features) |

Compute Engine 若使用一般 VM 的外部 IPv4，即使是 ephemeral 亦非持續免費：官方列每小時 US$0.005，帳戶每月僅 1 小時免費（適用區域有例外）。以 30 天 720 小時計算約 US$3.595／月，另加其他費用；不是 VM 完整報價。[VPC 網路定價](https://cloud.google.com/vpc/network-pricing)。

## Cloud Run 試算：10／25／50／100 次每天

此為**虛構、可重算的 Cloud Run 使用情境**，不是 HSR 實測、服務驗證或帳單：30 天／月；`us-central1`；request-based service；最低實例 0；每筆 transfer 的完整計費時間總計 120 秒（含所有啟動、關閉、執行與輪詢；無額外請求活動），配置 1 vCPU、1 GiB；每筆共 10 次計費請求；無重試、沒有其他專案使用免費額度。假設用量符合服務上限；不代表該執行方式已解決 queue、背景處理、Chrome 登入、鎖或持久狀態。價格用 US$0.000024/vCPU-s、US$0.0000025/GiB-s、US$0.40/百萬請求的非承諾 Tier 1 公開牌價，稅前；帳單貨幣價格和時間進位可能不同。[Cloud Run 定價](https://cloud.google.com/run/pricing)。

令 `N = 日次數 × 30`；`t = 120N`。僅計上述 Cloud Run CPU、RAM、請求：原價 `G = t × (0.000024 + 0.0000025) + 10N × 0.40 / 1,000,000`；免費額度後 `A = max(0,t-180000) × 0.000024 + max(0,t-360000) × 0.0000025 + max(0,10N-2000000) × 0.40 / 1,000,000`。

| 次／日 | 次／月 | vCPU-s | GiB-s | 請求／月 | 原價 G（USD） | Free Tier 抵減 | 免費後 A、促銷前 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 300 | 36,000 | 36,000 | 3,000 | $0.9552 | $0.9552 | $0.0000 |
| 25 | 750 | 90,000 | 90,000 | 7,500 | $2.3880 | $2.3880 | $0.0000 |
| 50 | 1,500 | 180,000 | 180,000 | 15,000 | $4.7760 | $4.7760 | $0.0000 |
| 100 | 3,000 | 360,000 | 360,000 | 30,000 | $9.5520 | $5.2320 | $4.3200 |

這些數字**只含表列 Cloud Run 計算與請求**，假設其他費用為零；並非部署總費用。它們排除出站流量（尤其目的地、區域或中國相關限制）、Cloud Tasks、Firestore、Storage、Secret Manager、Artifact Registry、Cloud Build、日誌、監控、稅、其他專案共享用量與額外測試。支持服務若低於各自適用免費門檻可為零，但沒有用量不能假定。請依實測 Chrome、冷啟動、輪詢、重試、日誌、儲存、網路及匯率重估。30 天模型在 31 天月份亦低估。不同地域或 instance-based Jobs 不可使用本表費率。

若在該月有至少 US$4.32 等值、未過期且能支付上述 SKU 的 Developer 信用額，且其他用量沒有先消耗它，100 次／日的**該 Cloud Run 部分**理論上可由促銷抵扣至 $0；其他三列本身已被假設的 Free Tier 覆蓋。即使 Trial 過期，也只有在 Developer 權益持續有效、領取且足額的條件下如此；若任何信用額均不可用，表中免費後 A 就是此部分促銷後費用，100 次／日為 $4.32 加其他費用及稅。不能確定究竟哪個促銷額度被扣，也不能因此保證總現金支付為零。

US$5 Cloud Run spend cap 的估算以原價而非 A 為基礎：本情境下 50 次／日的 $4.776 已接近 cap，100 次／日的 $9.552 超過 cap，可能在月中暫停；估算時間並非觸發保證，其他 Run 使用與估算延遲會改變時點。不要因表內 50 次／日促銷後為零就以為 cap 不會觸發。

## 遷移負責者的未完成核對

- 從實際帳戶確認升級／註冊日期、適用 SKU、每筆信用額狀態與到期日，向 Google 支援確認促銷抵扣順序及 11 月 16 日之後既有信用額的精確適用範圍；不要用本文取代帳單證據。
- 在任何會產生費用的實驗前，確定告警收件人、gross 與 net 範圍、Cloud Run cap 及其它服務風險；若無法接受超額或 Trial 被消耗，依附件要求停止會計費的實驗並回報。
- 量測 Chrome 和實際帳單用量，驗證安全登入、MFA、持久工作狀態、重啟恢復、重試與上游重複寫入；Cloud Run 的低成本試算本身不構成可行性或生產切換證明。

## Actual account preflight (primary agent, 2026-11-12)

Chrome account badge was read twice: ChingG, the user-selected non-default account (authuser=7 at the time). Account identifiers and raw billing evidence are retained outside Git in `D:/CodexWork/free-worker-migration-evidence/gcp/`. Do not rely on the numeric authuser index after account ordering changes: verify the badge before mutations.

- Active `My Billing Account` was selected from the active-only list and its overview says paid account. The old closed account was not selected. Overview displayed zero cost; reporting delay means this is not a final invoice guarantee.
- Linked project observed: `gcp-pay`; no unrelated project was modified.
- Credits page: GCP Free Credit remaining **2,353.66**, original same amount, 100%, starts 2026-11-11, expires 2027-02-10, application type net price; detailed SKU scope links to promotion terms.
- Seven Developer Program premium CREDIT_TYPE_MONTHLY entries, each remaining/original **78.46**, 100%, start 2026-11-11, scope displayed all Google Cloud Platform services and Google Maps API, application type list price. Expiries: 2027-02-16; 2027-07-01; 2027-07-16 (two entries); 2027-08-16; 2027-09-16; 2027-10-16. Total 549.22 is arithmetic, not an additional credit entry.
- Billing pages show `$`; the resource manager linked-project cost explicitly shows HK$. A separate billing currency field was not retrieved. Do not treat historical redemption ratios as a verified current USD/HKD conversion rate.
- No eligible billable test transaction was made; credit consumption order remains UNKNOWN. List-price versus net-price application is not sufficient evidence to claim Developer credit consumes first.

### Saved protection and remaining work

Created `hsr-account-net-warning`: monthly, all projects/all services, target **0.10 in account currency**, actual thresholds **1%, 90%, 100%**, default billing administrator/user email option enabled; project-owner, Monitoring and Pub/Sub recipients disabled. Savings checkboxes were selected in the form. The saved budget was re-read in a separate browser page and showed 0.00/0.10 with those thresholds. No test email delivery was performed. The first threshold's displayed amount rounds to zero; it must not be advertised as a guaranteed immediate positive-charge detector. The default role-based recipient membership could not be enumerated, so administrator-only delivery remains unverified.

The user reported creating the dedicated HSR project. Direct access to the displayed proposed ID `hsr-currency-war-worker` returned missing `resourcemanager.projects.get`; expanded current-account resource lists did not show that project. This may be a different generated ID, propagation or access issue; do not infer it was created under another account. No second project was created to work around it. Actual project ID/linkage and labels remain unverified. Project gross/net budgets and a project Cloud Run spend cap are **not configured**. No billing account or subscription was created or upgraded.

The console offers an enforced spend-cap budget type. Its availability is not evidence that a cap is saved or enforced. The current protection status is **PARTIAL**, not READY. Target project gross budget: US$5 equivalent after confirming current account conversion, promotional savings excluded, actual 50/75/90/100% plus forecast100%. Target net budget: HK$1 equivalent or lower after currency verification, all savings included. Cloud Run cap: same conservative gross limit, single dedicated project and Cloud Run API only. Confirm saved configuration and intended recipients before deployment.

### Billable-experiment stop

The task explicitly says to stop billable experiments if billing cannot reliably prevent cash charges or unexpected use of reserved credits. Official spend caps permit delayed overages and exclude supporting services; credit priority is unknown. Therefore **no billable staging deployment was attempted**. Budget warnings cannot remove this limitation. Continuing requires a revised user-approved financial risk boundary and completed project protections, or authoritative evidence satisfying the original constraint. No resource was created merely to discover credit order.

Future daily cost checks should inspect account/project/SKU usage and credit IDs, preserve pre/post balances and distinguish delayed data from zero consumption. No scheduled automation was created in this step.
