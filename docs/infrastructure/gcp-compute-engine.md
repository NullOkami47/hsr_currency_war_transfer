# GCP Compute Engine 待命 worker

2026-11-12：此方向取代先前 Cloud Run 重構方案。Azure 保持 Production；GCP 只準備合成待命環境，測試後停止 VM、保留開機磁碟。未獲 cutover GO 前不改正式 Vercel、DNS 或 Azure publisher。

## 當前證據與選型

- 現有 worktree：`D:/CodexWork/hsr-free-worker-migration`，分支 `codex/free-worker-migration`，Draft PR #5；未重設到舊 SHA。
- 正式 Azure 實際路徑與備份限制見 [Azure 備份](azure-worker-backup.md)。先完成可驗證的 recovery 程序，實際備份目的地/短暫服務暫停另行核准。
- GCP 帳號已在 Chrome 再核對為 ChingG；不可使用 Chrome 預設帳號。專案建立/權限結果以驗證紀錄為準。
- 首選固定規格 `e2-micro`、Ubuntu 24.04 LTS **x86_64**、20–30 GB `pd-standard`，單一 VM；先測 `us-central1-a`，容量不足才檢查同區其他 zone、`us-west1` 或 `us-east1`。尚未宣稱該 zone 有容量。
- 免費規則按 billing account 合計：合格 US 區域的一整月 e2-micro 時數、30 GB-month standard PD、指定目的地的 1 GB outbound。其他專案已用掉的額度也必須計入。Ubuntu 一般映像，不選 Ubuntu Pro 或付費 marketplace image。
- 固定 e2-micro 的 RAM 以實際 machine-type API 為準；本方案預期約 1 GiB 級別。共享 CPU 與 browser 峰值須實測，不能以較大 Box 的結果宣稱 e2-micro PASS。

官方來源（2026-11-12 查核）：[Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features)、[general-purpose machines](https://docs.cloud.google.com/compute/docs/general-purpose-machines)、[IPv6 設定](https://docs.cloud.google.com/compute/docs/ip-addresses/configure-ipv6-address)、[network pricing](https://cloud.google.com/vpc/network-pricing)、[VM runtime limit](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime)。

## 部署前 gate

1. 確認真正 Project ID、正確使用者、billing linkage、Compute API 與 IAM；不以「已填表」當成專案建立成功。
2. 核對全帳戶 free-tier usage、quota/capacity 與 root disk SKU；配置專案 gross/net budgets 和收件人。Budget 是警示，並非硬性上限；不得啟用 NAT、負載平衡器或 paid machine 作為隱藏 workaround。
3. 確認備份程序已 reviewed、合成 restore 成功、正式 recovery 風險已明確列出；正式部署備份工具和暫停需另行核准。
4. 核准既有 Cloudflare domain 的 **staging hostname**；不買域名、不改正式 record。先核對權限，未授權不傳輸密鑰。
5. 建立 VM 時就加 provider-side `maxRunDuration`（建議一小時）和 `instanceTerminationAction=STOP`，讀回同一 VM 的 scheduling 欄位。不能只依賴本機 timer、SSH 或人醒來後關機。

本 repo 的 `gcp-standby.mjs` 可操作**已存在**、明確標記 `purpose=hsr-worker-standby,mode=synthetic` 的 VM；不會建立或默默升級資源。配置範例故意將費用 gate 設為 false。`costEvidence` 只接受管理者從真正 billing/quota 查核取得的最近 24 小時紀錄，並不是由工具偽造的帳單證據。

```powershell
npm.cmd run gcp:preflight -- D:/<private>/standby.json
npm.cmd run gcp:start -- D:/<private>/standby.json --authorise-staging
npm.cmd run gcp:verify -- D:/<private>/standby.json
npm.cmd run gcp:stop -- D:/<private>/standby.json --authorise-staging
```

命令逐次明確傳 `--account`、`--project`、`--zone`，不變更全域 gcloud account。start 要求 VM 先為 TERMINATED，設定及讀回 STOP limit 後才啟動；不重設正在執行的測試期限。stop 只操作同一標記的合成 VM，核對 TERMINATED 並保留 boot disk。CLI 沒有配置好、專案不明或 gate 未滿足時停止，不建第二台。

## 可重現安裝流程（尚未在 GCP 執行）

保留每個命令的 SHA、版本、exit code。先透過受限管理連線確認 Ubuntu image、architecture、network、disk、provider STOP；只有 Linux/browser 相容性需要的公開原始碼可放到目標。

1. 在獨立 custom VPC 建立 dual-stack subnet，internal IPv4 + external IPv6；VM 不配置 external IPv4。管理入口使用受限 SSH/IAP 中合規可達的一項，不能因此公開 VNC/CDP 或建立 Cloud NAT。
2. 精確確認下載用上游 IPv6 可達。從官方 Node 發布取得固定 Node 24 x64 並核對官方 SHASUMS；以官方 Google Chrome apt repository 安裝 `google-chrome-stable` 及原生依賴。不得下載不明封裝或加入 `--no-sandbox`。
3. 建立非 root `hsr-worker` 帳號，程式只讀目錄 `/opt/hsr-transfer-worker-staging`，state `/var/lib/hsr-transfer-worker-staging` 0700，所有 JSON 0600；root 管理 0600 staging environment file，獨立隨機 worker token；不要配置正式 administrator secret。
4. 精確 checkout 已驗證 SHA，`npm ci --ignore-scripts`。以非 root 執行 `CURRENCY_WAR_BROWSER_CHANNEL=chrome npm run gcp:memory`，保存兩次 sandbox-requested persistent-context 啟動/close/reopen 的結果。
5. 以獨立 systemd synthetic service 執行真實 HTTP handler + 合成 transfer function，Caddy 只代理 loopback；正式 `worker-server.mjs` 不應在這個階段使用正式 profile 或 publishing account。既有 `oracle-synthetic-http.mjs` 可做不持久的基線 API 測試；它本身不證明跨 service restart，不能混稱。
6. 驗證 service 自動 restart、跨重啟 JSON 持久化、pending recovery、duplicate suppression、quota/rate limits、memory.peak、memory.events/oom、CPU 和安全 shutdown；沒有實例就保持 PENDING。
7. 如 RAM 不足，可在同一標準磁碟評估 1 GiB swap，確認磁碟餘量、swap 權限、latency 和 OOM；這是候選實驗，不能掩蓋不穩定。若仍失敗，列出 paid e2-small 正確 region 報價並先請求核准，不能自行建立。

`measure-browser-memory.mjs` 每 100ms 用 PID/PPID 計算整棵 Node + Chrome process tree 的 RSS 峰值，會重複計算 shared pages，也可能錯過瞬間峰值。**必須**加上 GCP systemd cgroup `memory.peak`、`memory.events` 及 OS 可用記憶體，才是 sizing 證據。Box 測量只證明量測工具可用，不能證明 1 GiB VM 足夠。

## IPv6 與 HTTPS

候選入口為 `Vercel → Cloudflare proxied AAAA → VM IPv6:443 → Caddy → 127.0.0.1:8787`。使用受限 staging hostname、Full (strict)、有效 origin TLS、worker bearer token；firewall 只允許 Cloudflare 官方 IPv6 ranges 的 443，SSH 另限制管理來源。Origin CA 憑證不適合直接讓一般 client 驗證；經 Cloudflare 的公網 chain 與 origin strict verification 應分別測試。不以公開 HTTP health 取代 bearer job API 測試。

Cloudflare DNS proxy 解決入口雙協定，不解決 VM 的 IPv4-only egress。實測至少包含：`sg-act-public-api.hoyolab.com`、`act.hoyolab.com`、`github.com`/release endpoints、npm registry、Node/Chrome apt 和 certificate endpoints。先用 VM 上的 `getent ahosts`、`curl -6 --connect-timeout 10 --max-time 20` 測公開唯讀/首頁；不得用合成負載打 HoYoLAB。

若某個必要上游只有 IPv4，無 external IPv4 的 dual-stack VM 不會因此自動取得 IPv4 Internet egress。比較直接 ephemeral IPv4 與 Public NAT/NAT64；不要為了省 IPv4 位址費而部署更貴 NAT。任何 paid IPv4 均須列明費用並獲核准。Vercel 是否能直連 IPv6 origin 保持未驗證，必須由真正 staging Function 測試；本機 curl/Box curl 不可代替。

## 測試後待命

停止 synthetic service，核對無 browser/process writer，`gcp:stop` 後讀回 VM TERMINATED；保留標準 boot disk、非機密 configuration、精確版本及測試收據。不得將 Stop 當成磁碟免費證據。自動 STOP policy 仍保留，未來每次 staging start 都重新讀回；正式 cutover 後如果要取消時限，必須納入該次明確核准且確認已不再是臨時實驗。

目前尚無已建立且驗證的 GCP VM；final power state 是 **N/A（未建立）**，不是 TERMINATED。選型、安裝 runbook 和 guarded controls 不等於 standby ready。

最新 Box 合成診斷的 proportional PSS peak 約436.35MiB（整棵 Node/Chrome tree），RSS 約1.11GiB（共享頁面重複計算）；只有19個抽樣點，不是 HoYoLAB 真實工作負載，也不是 GCP 1GiB 的可行性證據。仍維持先測 e2-micro，沒有因此選擇或購買 paid VM。

## 可執行的合成服務與重啟演練

`synthetic-worker-server.mjs` 現在提供可長駐的真實 worker HTTP handler + JsonWorkerJobStore/JsonTransferStore/JsonSecurityStore；transfer function 只產生 `SYNTHETIC-` code，先完成全新 profile 的真實 Chrome probe。它不匯入正式 publisher，也不讀 HoYoLAB credentials。拒絕所有 inherited `CURRENCY_WAR_*`、未標記的非空資料夾、browser profile、symlink；只綁127.0.0.1:8788，使用獨立 staging token，回傳明確 mode。

目錄具有 synthetic UUID marker 與程序 ownership lock。第二個 live owner 被拒絕；只有明確不存在的 PID 所留下的 synthetic owner/transfer lock 可復原。不允許跨機共用 JSON state；不將此測試專用恢復邏輯套用正式 Azure publisher。若不完整 JSON/temp file/ownership 不明，保持拒絕，不刪除或採用資料。

安裝範本：`scripts/infrastructure/hsr-worker-synthetic.service` 和 `synthetic-worker.env.example`。先核對 Node 路徑、staging account、SHA、0700目錄、0600 environment file、官方 Chrome/原生函式庫。服務具 control-group kill、有限 restart burst、strict filesystem、獨立tmp、non-root、NoNewPrivileges 和一小時 RuntimeMaxSec。不因此移除 Chrome sandbox；若 Ubuntu user namespace/AppArmor 阻止 sandbox，回報失敗並調查官方支援，不能以 no-sandbox 通過。

```sh
# 無正式 credentials 的獨立 Linux 程序演練，使用暫存 synthetic directory。
npm run gcp:restart-drill
# 在經核准的開發/測試 Linux 主機：唯一命名 transient systemd unit，最長180秒。
# 需要 sudo；只操作 hsr-synthetic-drill-<random>，finally stop 並清理自身暫存資料。
HSR_SYSTEMD_DRILL_ALLOW_SUDO=1 npm run gcp:systemd-drill
```

程序演練會驗證真實 Chrome job、兩次程序重建的 state persistence、duplicate mapping、以及在合成 running 邊界 SIGKILL 後回復佇列且 quota 不變。systemd 演練驗證實際 supervisor crash restart、state、accounting 和停止。兩者都不是 GCP 證據；GCP 要在相同 commit 實際執行，並補 origin TLS/Vercel/IPv6 與機型 sizing。

systemd 實測修正：Chrome 在 ProtectHome/strict filesystem 下需要自己的可寫 HOME/XDG；使用 `/var/lib/hsr-transfer-worker-staging/home`，JSON 僅放 sibling `state` 目錄，避免 browser cache 進入 state allowlist。安裝前建立兩個0700、由服務帳號擁有的目錄。TasksMax256 是有限 runtime 配額：128 的實際演練遇到 pthread_create EAGAIN，調整後 Chrome 成功；未停用 Chrome sandbox、NoNewPrivileges、ProtectSystem 或 PrivateTmp。

Box 上 exact commit66f0211e3e6d4e2787b607eedd98e70d75be3ee1 的真實程序與 transient systemd 演練已通過：4次程序啟動、正常停止、running合成工作SIGKILL復原、quota不變、三檔跨restart保留；systemd PID變更且NRestarts1，最後停止、無測試unit留在running。Chrome工作cgroup MemoryPeak約242.06MiB，完整278測試通過。這只驗證工具與systemd配置，**不**替代GCP e2-micro/真實HoYoLAB容量或網路驗收。詳細命令/版本/時間/限制見驗證文件。

## 2026-11-12 帳戶與網路前置作業更新（尚未建立 VM）

本段取代較早「專案 ID、billing linkage、project budgets 未確認」的狀態。使用官方 Google Cloud CLI 593.0.0，以本次 OAuth 明確登入原指定 ChingG 帳戶；CLI 與受限設定目錄位於 D:/CodexWork/gcp-tools，credential/code 未放入 repo 或聊天。

- 已建立並從 dashboard 與 Resource Manager CLI 讀回專案 `hsr-currency-war-worker`，編號 `282550645630`，ACTIVE、無組織。
- `billing projects describe` 確認連結原有效付費帳戶，billingEnabled=true；帳戶幣別由 API 確認 HKD。舊 closed 帳戶未使用。
- Credits 頁仍顯示 Free Credit HK$2,353.66，2027-02-10 到期；七筆 Developer 月信用額各 HK$78.46、100%。報表存在延遲；沒有實際 transaction 證明誰先扣款。優先序 UNKNOWN。
- 已啟用 Compute API 與 Billing Budgets API。已存檔並用 budgets list 獨立讀回：`hsr-project-gross-warning` HK$30/month、EXCLUDE_ALL_CREDITS、actual 50/75/90/100% 與 forecast100%；`hsr-project-net-warning` HK$1/month、INCLUDE_ALL_CREDITS、actual1/50/100%。HK$30 是本次選定的保守門檻，不宣稱是已驗證匯率換算的 US$5。帳戶既有 HK$0.10 net 警示保留。default IAM recipients 未停用；未實測寄信，未成功列出收件人 role membership。Budget 是警示，不是付款硬上限。
- 已建立 `hsr-worker-vpc`（custom）、`hsr-worker-us-central1`（10.42.0.0/24），只允許 IAP 35.235.240.0/20 對標籤 hsr-worker-standby 的 TCP22。沒有公開 worker/VNC/CDP/HTTPS ingress、NAT、負載平衡器或 static address。
- `us-central1-a` e2-micro API 回傳 2 guest CPUs、1024 MB RAM；Ubuntu image `ubuntu-2404-noble-amd64-v20261105` READY/x86_64。這不證明建立時有實際容量或 Chrome 可運行。
- 新專案 instance/disks list 均空；同有效 billing account 僅此專案與原 gcp-pay 專案，後者 Compute API 未啟用。當前零資源不能證明整月 shared Free Tier 未曾使用。

### IPv4 出口門檻

Google DoH 與 Cloudflare DoH 即時 AAAA 查詢：`sg-act-public-api.hoyolab.com`、`act.hoyolab.com` 只有 CNAME，沒有 AAAA；A 查詢均有位址。`github.com` 亦無 AAAA。npm、Node、Google 下載站具有 AAAA 不足以令整個 worker 相容。這是外部 DNS 證據，尚未冒稱在 GCP VM 上測過連線。

原純 IPv6 direct-egress 方案不能直接連這些 IPv4-only 端點。候選改為同一 e2-micro、20GB pd-standard、臨時 external IPv4、無 VM service account、IAP SSH、Google maxRunDuration=1h / STOP；建立前需使用者核准 IPv4 及非零費用風險。停止會釋放 ephemeral IPv4，但保留 boot disk。既有 `gcp-standby.mjs` 明確拒絕 IPv4；不能繞過它或造假的 costEvidence。得到核准後須以明確的 IPv4 staging 操作與 readback 驗證，或先更新並測試控制工具。

官方 IPv4 定價 US$0.005/hour，monthly first hour allowance 是 billing-account shared；持續開機720h時 IPv4部分約US$3.60/月（扣一小時後US$3.595），不含其他資源或出站。Credit 可能抵扣符合資格費用，不能保證指定抵扣順序、永久免費或零現金支出。Public NAT 另有 gateway、處理流量與 IP 費，沒有部署。

已備妥 guarded provisioning 腳本於本次工作目錄 work/gcp-online/New-GcpStandby.ps1，明確要求 -AuthoriseTemporaryIPv4，且若專案已有 VM 就拒絕重複建立。尚未執行。**GCP 尚未上線，VM final state N/A；等待 IPv4／費用邊界確認。** Azure 與 Vercel production 未切換。

來源：Google 官方 [IPv4 定價](https://cloud.google.com/vpc/network-pricing)、[Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features)、[VM 時限](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime)、[budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets)。實際 JSON 收據與 DNS 查詢位於本次工作目錄 work/gcp-online，非帳單延遲結算保證。
## 2026-11-12 已核准的 GCP IPv4 實機測試與最終待命狀態

使用者於本對話對「單台 e2-micro、臨時 IPv4、最長一小時且 Google 端自動 STOP」明確回覆 ok。此核准不包含常駐付費 IPv4、延長測試、正式 cutover、真實 HoYoLAB 發布或 Azure 除役。

### 實際資源與安全邊界

- 專案 `hsr-currency-war-worker`，`us-central1-a`，VM `hsr-worker-standby`；Ubuntu `ubuntu-2404-noble-amd64-v20261105` x86_64，e2-micro API 1024MB，OS MemTotal 953MiB。
- 單顆 20GB `pd-standard`，autoDelete=false，保留 boot disk。專用 VPC 與 IAP TCP22規則；沒有公開 worker、VNC、CDP入口、Cloud NAT、負載平衡器或 static address。
- 建立使用 `--no-service-account --no-scopes`，最終完整 VM 讀回沒有 serviceAccounts。OS Login、阻擋project SSH keys、Shielded Secure Boot/vTPM/integrity均設定。
- `maxRunDuration.seconds=3600`、`instanceTerminationAction=STOP`、automaticRestart=false 均在 RUNNING與TERMINATED狀態重新讀回。沒有重設時限；本次手動提早停止，不宣稱已實測自動到時STOP。
- 實際執行 **2026-11-12 14:57:14.551～15:52:04.463 +08**，約54分50秒。最終 **TERMINATED**；20GB磁碟 **READY**；無配置中external IPv4、無static address。
- IAP最初因本機連線問題逾時；官方CLI為generic archive，在Windows用bundled Python呼叫，沒有原生gcloud ssh支援。以本機獨立IPv4解析launcher及Windows OpenSSH經IAP連線成功；未改官方SDK碼。SSH host ED25519由Google序列console取得，再StrictHostKeyChecking=yes核對。臨時OSLogin key TTL1h，私鑰留D槽受限目錄，未上傳VM。IAP程序已停止。

### 精確來源與安裝

測試原碼 **5940d2fd969347a227231ef1a9384c60cda2dfe5**，程式相對2886e9f無差異，5940d2f只有文件。由Git archive提供**公開原碼**，不含.env、browser profile、正式state或token。

首次Windows archive帶CRLF造成既有 `caddy-file-metadata.sh` shell測試失敗。讀取Git blob確認原始LF；以 `git -c core.autocrlf=false archive` 重新封存同一SHA，部署後全套通過，未修改測試以掩蓋錯誤。LF tar SHA-256 `a8650e3fb6aeae23fc8689c925e5a136118cbff48840d1be23c3e3577a787f66`；VM讀回一致。

Node **v24.22.3**／npm **11.19.1**，官方Node SHASUMS256核對成功；Google簽名apt來源安裝 Chrome **157.0.8103.78**。程式root-owned `/opt/hsr-transfer-worker-staging`，非root `hsr-worker`，獨立0700state/home，root0600 `/etc/hsr-worker-synthetic.env`，只存新生成synthetic token。正式publisher未啟動。

### GCP實際驗證

- `npm ci --ignore-scripts` 成功、audit0；非root `node --test`：**278/278 pass、0fail、0skip**，10.72秒。這是精確公開原碼在真實GCP主機驗證；不是獨立審查人員的遠端二次驗證。
- `measure-browser-memory.mjs`：兩次Chrome persistent-context啟動/close/reopen成功、合成cookie保留、chromiumSandbox=true；未使用no-sandbox。PSS peak459,374,592bytes（約438.09MiB），RSS peak1,003,577,344bytes（共享頁重複計算），109samples／107完整PSS samples，sampled swap0。不是HoYoLAB登入頁記憶體。
- `synthetic-process-restart-drill.mjs`於15:41:14.909+08通過：4OS程序啟動、3graceful stop、1running synthetic工作SIGKILL，工作恢復／quota不變／mapping、jobs、security跨restart保留、duplicate不改mapping、401/400安全拒絕。沒有real publishing。
- `synthetic-systemd-drill.mjs`於15:41:19.878+08通過：真實transient unit，PID6260→6511、NRestarts1，Chrome合成工作完成、三檔保留、最後inactive/MainPID0。sandbox NoNewPrivileges=yes、ProtectSystem=strict、PrivateTmp=yes、TasksMax256。工作cgroup MemoryPeak238,678,016bytes（227.62MiB）；CPU3.50s。通用測試輸出仍寫gcpVerified=false，因工具不自我判定平台；本節平台證據來自實際GCE身份／SSH／控制平面readback，未改寫原始log。
- 已安裝 `hsr-worker-synthetic.service` 的實際smoke於15:44:38.578+08通過：loopback127.0.0.1:8788，未授權POST401，授權Chrome合成工作成功。MemoryPeak370,782,208bytes（353.61MiB），MemoryCurrent234,676,224bytes，CPU4.52s；之後stop並核對inactive/MainPID0。非正式service測試與正式worker隔離。
- 公開唯讀HTTPS：HoYoLAB活動精確URL `https://act.hoyolab.com/sr/event/currency-wars/index.html` HTTP200/TLSverify0；sg-act-public-api根路徑HTTP404/TLSverify0，HEAD405屬根端點回應，不能當API授權驗證；GitHub/npm根HTTP200。**未登入HoYoLAB、未發真實策略、未測兩次authenticated read-only API。**
- 後續memory.events補充收集未取得完整收據：IAP連線在最終stop前關閉。不得宣稱OOM counter=0；原browser-sizing oneshot結束卸載後cgroup欄位not set也不是測量值。以上有效峰值來自執行中的systemd restart與installed-service收據。

原始失敗與成功證據封存在 `D:/CodexWork/free-worker-migration-evidence/gcp/gcp-actual-e2micro-evidence-20261112.tar.gz`，SHA-256 `240890f2f3f91af4726fd0f0471f47b44525f46eae3598885661b79fc518cebc`；download已核對，解壓於同目錄actual-e2micro-20261112。最終控制平面readback見本次work/gcp-online/final-vm-summary.json。

### 成本／正式切換

先前HK$30 gross／HK$1 net專案預算及HK$0.10帳戶net預算仍保留。15:55+08重讀credits頁，Free Credit仍顯示2,353.66、七筆Developer各78.46、八筆均100%；**報表延遲未消除，不能據此宣稱本次免費、先扣哪筆或零現金帳單。** IPv4位址本次不到1h；每billing account首小時能否全額適用未獲結算證據。已停止VM且無external IPv4；保留20GB標準PD仍受shared free-tier餘額影響。

Azure已另行完成自動Blob備份與VM外還原驗證；GCP本次不搬正式state/profile或recovery key。Azure VM最後讀回running，Vercel Production/DNS未切換。備份工具在獨立 `/opt/hsr-backup`，不是本次GCP公開原碼版本的生產部署證明。

狀態：**GCP_STANDBY_BASELINE_VERIFIED**、**E2_MICRO_SYNTHETIC_PASS**、**IPV4_EGRESS_BASELINE_PASS**、**E2E_PENDING**、**PRODUCTION_CUTOVER_BLOCKED**、**AZURE_FALLBACK_PRESERVED**。下一階段仍需核准staging hostname/TLS、實際Vercel測試入口、新HoYoLAB登入/MFA、兩次授權唯讀及明確批准的live transfer；驗收後才可請求Production GO。不得把本次一小時核准當成常駐付費IPv4或正式切換授權。