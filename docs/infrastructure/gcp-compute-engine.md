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
