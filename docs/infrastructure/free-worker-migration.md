# 免費常駐發布 worker 遷移操作手冊

日期：2026-11-11（Asia/Hong_Kong）。**這是待部署的操作手冊，尚未切換 Production。**
來源基線：`8e37fbc49cec79a3594638c832c52839a0b1fc62`；瀏覽器設定實作：
`1151e2e68d98f84856d10aaef873121100391509`。部署時必須記錄實際核准的完整 SHA，
不可直接使用持續變動的分支名稱。測試範圍見 [驗證報告](../verification/free-worker-migration.md)。

## 目前決策與存取狀態

保留 Vercel 網站／API 與現有 Azure worker；先在免費目標上驗證，再另外切換。
原任務已授權免費實驗，不需重複索取相同授權。Uppcoder 曾建立獨立實驗 stack，
沒有 Production 遷移、Production 寫入或使用真實秘密／profile。

| 候選 | 目前證據與限制 | 狀態 |
|---|---|---|
| Uppcoder Spark | 已登入並實測免費 Node.js stack：Chromium 缺系統函式庫，無權透過 apt 安裝；Node.js 加官方 E2E Testing 被預檢以需 2 apps、免費上限 1 app 拒絕。使用者明確同意刪除實驗 stack 後，目前為零 stacks。 | **`UPPCODER_NO_GO`：限此次測試的受支援免費 Node.js 架構。** 其他自訂或供應商映像未驗證，不能推論全部不可行。 |
| Oracle A1（備選） | 現行 Always Free 專頁：合計 2 OCPU／12 GB、每月 1,500 OCPU-hours／9,000 GB-hours。不可沿用較舊 4／24 額度。Home Region 與建立頁免費標示已核實；容量請求遭拒，完整帳戶配額及實際帳務未核實。 | 已登入新加坡 Home Region；實際申請 1 OCPU／6 GB A1、Ubuntu 24.04 ARM64，被 AD-1 容量不足拒絕。`ORACLE_BLOCKED`，沒有 VM 或 ARM browser 驗收。 |
| Simular Box | CLI 遠端 Linux x64 測試與 Chrome 啟動已成功；以獨立官方 Codex CLI 0.167.1 完成 OAuth 後，原版 0.144.1 原生 MCP `box_list` 已成功。原生 shell 仍被核准層取消，尚未驗收。 | 測試環境可用；沒有免費常駐 Production 的可用性、費用或託管承諾驗證。 |

來源：2026-11-11 公開網站／Chrome DOM 查證及實際實驗紀錄；細節見驗證報告。
[Uppcoder Pricing](https://portal.uppcoder.com/pricing)、
[免費方案指南](https://portal.uppcoder.com/guides/free-app-hosting-no-credit-card)、
[條款](https://portal.uppcoder.com/terms)、
[Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)。
Oracle 有容量及閒置回收限制；免費額度不是服務持續運作保證。

500 CPU 秒是 CPU 使用預算，不是只能在線 500 秒；約等於單核心整日平均 0.579%。
目前沒有此 worker 在 Spark 的用量證據，不能宣稱必然超額或已適合。
Uppcoder 的公開 TLS、terminal／SSH 及備份說明也不足以證明 browser session 能跨重建保留。
條款對以轉送他人流量為主要用途的 proxy／tunnel 有限制，不能一概認定管理自有 app 的 SSH
轉送違規；採用具體互動設計前仍需核對適用範圍。此次 `UPPCODER_NO_GO` 基於實測的
瀏覽器依賴與免費 app 上限，並非對供應商所有映像的判斷。

## Oracle 實際建立結果與資源回查

2026-11-11 已在 Chrome 登入 Console，確認新加坡 `ap-singapore-1` 為 Home Region。
建立 staging 請求一次：`VM.Standard.A1.Flex`（Always Free-eligible）、1 OCPU／6 GB、
Canonical Ubuntu 24.04 Minimal aarch64（2026.10.27-0）、預設 46.6 GB boot，
無附加磁碟、無 public IP、SSH 公鑰、fault domain 由 Oracle 選擇。
請求被 API 拒絕：**Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1**。
未改用付費 shape、未升級帳號、未循環重試；沒有可測的 VM，因此 ARM、Chrome channel、
systemd、TLS、持久化及登入仍未驗證。這證明當時 AD 的 A1 容量阻礙，沒有證明 ARM 不相容。

建立失敗後，Console 新加坡 root compartment 的 Instances、VCNs、Block volumes、Boot volumes
四個清單均顯示 No items to display，未發現本次請求殘留資源，沒有進行刪除。
這是特定 region／compartment 的清單證據，非全帳戶帳務稽核；Limits 頁沒有返回可讀配額，
帳戶用量與最終帳務仍未核實。零月費仍是目標，未取得成功部署與帳務證據前不作保證。
原 Azure 仍保留；實際 cutover 及真實攻略寫入仍須分別取得 GO。
可取得容量後的準備與合成驗證見 [Oracle staging 操作稿](oracle-staging-bootstrap.md)。

## 原始碼與部署連結稽核

- `scripts/worker-server.mjs` 使用常駐 Node.js 程序、`BrowserSessionPublisher` 及單程序 JSON
  佇列；預設只監聽 `127.0.0.1:8787`，不是可直接改成無狀態 serverless 的工作。
- Vercel 端透過 `CURRENCY_WAR_WORKER_URL=https://<worker-host>/jobs` 及 server-side
  bearer token 呼叫同一 worker；瀏覽器不應取得 token 或 HoYoLAB session。
- `src/publisher.mjs` 從已登入頁面送出官方請求，沿用裝置 cookie；設定修改沒有更動發布、
  驗證、quota、黑名單、session registry、CSRF 或 TOTP 規則。
- `scripts/vm-hoyolab-login.sh` 的預設帳號仍是 `azureuser`，瀏覽器仍為 `google-chrome`，
  並依賴 systemd、Caddy、Xvfb、x11vnc 及 noVNC。這份 Azure 輔助腳本沒有自動適配容器或 ARM。
- GitHub 唯讀查證：主來源 `main` 為基線 SHA。另有部署 repo
  `NullOkami47/hsr_currency_war_transfer_vercel`，其 `main` 為
  `db495549ba889d6c1ff609ae7b09b9721ba35692`，提交訊息指出來源 `8e37fbc`；
  Production deployment `7701616363` 的 GitHub status 為 success。
  這只證明 GitHub 記錄，沒有核實 Azure 正在執行的 SHA、Vercel 真實環境設定或端到端健康。
  本 PR 只推送來源 repo，不同步部署 repo。

## 瀏覽器設定契約

| 設定 | 行為 |
|---|---|
| 兩者未設定或為空字串 | 保留 Playwright `channel: "chrome"`。 |
| `CURRENCY_WAR_BROWSER_CHANNEL` | 選用已安裝且相容的 channel，例如 `chrome` 或 `chromium`。 |
| `CURRENCY_WAR_BROWSER_EXECUTABLE_PATH` | 明確指定 executable，優先於 channel，啟動參數不再傳 channel。 |

設定在 publisher 建構時讀取，套用於 `worker`、`connector:login`、`transfer`；變更後需重啟程序。
明確 constructor 選項可覆寫對應環境值；選擇失敗會回報錯誤，不自動改用其他瀏覽器。
`playwright-core` 不附瀏覽器，須另安裝相容版本與系統依賴。自訂 executable 是相容性選項，
不代表任意 Chromium／ARM 組合都已獲驗證。
[Playwright API](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。

## 資源與營運需求

原始碼沒有宣告硬體最低值；尚無長時間負載量測，不能把建議規格視為已驗證最低需求。
本次選 1 OCPU／6 GB A1、約 47 GB boot 作為測試起點，容量不足而未建成。
Box 約 3.8 GiB RAM 的 x86_64 browser／測試成功，只能作開發參考。
建議至少為 OS、Node、相容 Chromium、字型、獨立 profile、三份狀態及輪替 logs 保留容量；
正式 sizing 必須量測尖峰 RSS／CPU、profile／狀態增長與磁碟水位。
無論架構，必須有相容 shared libraries、支援的 browser executable、非 root 執行與可用 sandbox。
Node 需符合 package.json 的 >=20，VM 優先採仍受支援的 LTS；ARM 成功必須另有真實啟動證據。

營運需輪替 journal／proxy log、監控磁碟與服務退出、/health 失敗、佇列停滯及認證錯誤。
避免記錄 bearer token、OTP、cookie、payload 個資或完整 profile；health 成功不等於登入成功。
備份需離機、限權且加密，還原時校驗 mappings、jobs、security state 一致，不靠 Box-local 唯一副本。

| 方案 | 月費判斷 | 目前結果 |
|---|---|---|
| Uppcoder Spark | 官方 €0；本次未升級 | 不相容的已測架構，實驗已刪除 |
| Oracle A1 | 成功配置且總用量在核實免費額度內時，計算／儲存目標為零 | 容量不足，沒有成功部署；帳務未核實，不能保證零費用 |
| Azure fallback | 保留現有訂閱的實際費用，金額未取得 | 本次沒有停止、縮放、除役或改付費設定 |

## 目標準備（未執行）

1. 先確認免費方案資格、費用、CPU／RAM／磁碟、持久化路徑與允許的啟動方式。
   Spark 此次架構已判定 `UPPCODER_NO_GO`；若日後有供應商支援的單 app browser 映像，
   仍須重新證明依賴、受監督重啟、安全登入及保留狀態，否則維持 Azure。
   Oracle 要先取得可用 console、確認 home-region 容量與標示為免費的最小配置，不能靜默升級。
2. 選擇相容的 Linux／Node／瀏覽器版本。ARM 優先評估 Playwright 支援的 Ubuntu arm64，
   實際檢查 `uname -m`、`node --version`、瀏覽器版本及依賴。ARM 與 Chrome 並非全面不相容，
   但本報告沒有 ARM 執行證據。不以 root／新增停用隔離旗標作為相容性解法。
3. 以非 root 專用帳號執行。以下 VM 範本假設帳號／群組為 `hsr-worker`、
   程式在 `/opt/hsr-transfer`、持久目錄在 `/var/lib/hsr-transfer-worker`，權限為 0700，
   狀態檔 0600；確認磁碟加密、容量及備份涵蓋所有狀態。託管容器須改用供應商確認的持久路徑。
4. 在獨立 checkout 固定核准 SHA，執行 `npm ci`、`npm test`、`npm audit --audit-level=high`。
   先用全新臨時 profile 驗證 browser 啟動、關閉／重啟及合成 cookie，完成後刪除；不使用真實帳號。
5. 用平台秘密管理或 root 管理的 0600 environment file 設定既有 worker token（或安排 API／worker
   原子輪換）。不要將值放在 Git、CLI 參數、測試輸出或聊天。Node 不會自動載入 `.env.example`。

VM 的 `/etc/hsr-transfer-worker.env` 應包含下列非機密設定；worker token 由管理者另行安全注入：

```dotenv
CURRENCY_WAR_WORKER_HOST=127.0.0.1
CURRENCY_WAR_WORKER_PORT=8787
CURRENCY_WAR_HEADLESS=1
CURRENCY_WAR_PROFILE_DIR=/var/lib/hsr-transfer-worker/browser-profile
CURRENCY_WAR_STATE_PATH=/var/lib/hsr-transfer-worker/transfers.json
CURRENCY_WAR_JOB_STATE_PATH=/var/lib/hsr-transfer-worker/jobs.json
# 僅在選定並驗證相容 executable 後啟用；否則保留 chrome channel。
# CURRENCY_WAR_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
```

systemd VM 範本（Spark 不保證提供 systemd，不能直接套用）：

```ini
[Unit]
Description=HSR publishing worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hsr-worker
Group=hsr-worker
WorkingDirectory=/opt/hsr-transfer
EnvironmentFile=/etc/hsr-transfer-worker.env
ExecStart=/usr/bin/node /opt/hsr-transfer/scripts/worker-server.mjs
UMask=0077
Restart=on-failure
RestartSec=10
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
```

先確認 Node 實際路徑，安裝為 `hsr-transfer-worker.service` 後再 `daemon-reload`／啟動。
尚未完成狀態移轉前不啟用自動開機，並先保持對外路由關閉。
預設 keepalive 會在啟動後最多一分鐘首次使用 browser；在合成測試階段設
`CURRENCY_WAR_SESSION_KEEPALIVE_MINUTES=0`，完成登入及切換才恢復預設 360 分鐘。

## 登入、網路與切換（未執行）

1. 新機使用全新專用 profile，由本人完成 HoYoLAB 登入／MFA；不從舊機搬 cookies 或 profile。
   登入與 worker 不得同時開啟同一 profile。可在已核實的 SSH X11 轉送上，切到專用帳號、
   使用與 worker 相同的 profile／executable 設定執行 `npm run connector:login`，關閉登入視窗
   後才啟動 headless worker。需要可用 display、受信任 SSH host key 及客戶端 X server，
   此路徑尚未在候選平台驗證；若不支援則阻擋切換，不能公開 browser debug／VNC 埠替代。
   現有程式沒有可宣稱已實作的即時 MFA 接手／暫停功能；過期時應停止 worker，再人工登入。
2. VM 只開放經控管的 SSH 及 HTTPS；worker、VNC、noVNC、CDP 留在 loopback／私網。
   HTTPS reverse proxy 轉送到 `127.0.0.1:8787`，保留 bearer 驗證並設定 body／連線／速率限制。
   託管 ingress 必須核實等效限制，不將公開 HTTPS URL 當成授權。保留 API 端 TOTP、CSRF、
   session secret 及可信 proxy 規則，不能為了接通而放寬。
3. 切換前透過管理介面停用公共提交，等既有佇列完成並核對沒有執行中工作；
   凍結 API／管理流量後停止舊 worker，確認舊程序已退出。不要只依賴 SIGTERM 當作佇列已排空。
4. 在停止狀態下安全移轉最新 `transfers.json`、`jobs.json`、`jobs.json.security.json`，
   包含 mappings、quota、黑名單、持久請求預算及 session registry，核對校驗碼與權限。
   不刪除 security state、不用空白狀態重建 quota，也不以 bootstrap 旗標覆蓋已停用設定。
   備份需受限、加密，不能加入本 repo。一次只准一個 worker 使用同一發布帳號與狀態。
5. 新 worker 先以公共提交關閉的最新狀態啟動。檢查 loopback 與 HTTPS `/health`、
   未授權 `/jobs` 被拒絕、管理登入／登出與原有安全政策、磁碟重啟持久性。
   `/health` 200 不證明 browser、登入、發布或 quota 正常。
6. 只有上述驗收完成才將 Vercel 的 server-side worker URL 指向新 HTTPS `/jobs`，
   同步 token（如有輪換），確認需要更新的 Vercel deployment 已實際生效。
   再做受控端到端測試並核對帳號、share code、寫入次數、去重、quota 及登出撤銷；
   真實發布會寫入 HoYoLAB，必須在當前明確允許的部署／測試範圍內執行。本分工沒有執行。
7. 確認錯誤率、資源預算、冷啟動／重啟及重新登入流程後，再由管理者恢復公共提交。
   驗收前保留 Azure 復原能力，不刪 VM、磁碟、DNS 或舊環境設定。

## 回滾（未執行）

任何 browser／MFA、quota、狀態一致性、資源或端到端驗收失敗，都先停用公共提交，
凍結 API／管理流量、排空佇列並停止新 worker。確認只會有一台 worker 啟動。

- 新機尚未接受工作／管理變更：可沿用凍結時的舊狀態及原 Azure 設定恢復。
- 新機已接受任何工作、quota、session 或管理變更：停止後將**最新完整三份 JSON 狀態**安全同步回舊機，
  不恢復過時的切換前快照，避免重複發布、遺失映射或復活已撤銷 session。
  寫入結果不明的工作先核對官方結果與 mapping，不能直接重送。
- 恢復舊的 worker URL、協調後的 token、proxy 及核准來源版本，保留舊機自己的登入 profile。
  設定 browser 新選項為未設定可恢復 Chrome 預設；不得退回安全修補之前的版本。
- 重新檢查 health、未授權拒絕、登入／撤銷、設定及佇列，再恢復公共提交；
  舊登入失效時先人工重新登入，不能透過略過驗證恢復流量。

回滾紀錄須含原因、兩端完整 SHA、停啟時間、最後已確認工作、狀態校驗碼及重新開放時間，
不可含任何 token、OTP 或 profile 內容。備份／還原及實際切換仍待後續驗證。
