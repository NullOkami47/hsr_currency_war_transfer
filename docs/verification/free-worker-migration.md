# 免費 worker 遷移驗證紀錄

日期：2026-11-11（Asia/Hong_Kong）。結論：**原始碼設定與本機／Box x64 測試已驗證，
Uppcoder 測試架構為 `UPPCODER_NO_GO`，Oracle 與 Production 遷移仍未驗收。** 部署／回滾步驟見
[操作手冊](../infrastructure/free-worker-migration.md)。

## 來源及修改範圍

- 指定工作樹：`D:/CodexWork/hsr-free-worker-migration`，分支 `codex/free-worker-migration`。
  使用者提供來源資訊：原生工作樹原在 C 槽，已以 `git worktree move` 移至此 D 槽路徑。
  本分工開始時核實工作樹乾淨，沒有再次移動或修改其他工作樹。
- 精確基線：`8e37fbc49cec79a3594638c832c52839a0b1fc62`。
- 精確可執行實作 SHA：`1151e2e68d98f84856d10aaef873121100391509`。
  該提交只改 `.env.example`、`src/publisher.mjs` 及新增 `test/browser-config.test.mjs`。
  隨後提交的是本報告與操作手冊；本報告刻意使用已存在的實作 SHA，沒有以自引用 SHA 代替證據。
- 新選項只改 browser 啟動選擇。預設 Chrome、profile 路徑、headless 選項、
  發布請求、重試、keepalive、quota、session、CSRF、TOTP 及安全狀態沒有修改。
- 不更新相依套件、CI、Azure 登入腳本、部署 repo 或 Production；不讀取真實秘密、profile 或 cookies。

## 本機執行證據

Windows x64，Node `v24.18.0`、npm `11.16.0`、鎖定 `playwright-core 1.62.1`。
除下列模擬／測試建立的狀態外，沒有開啟使用者的 browser profile。

| 階段 | 命令 | 實際結果 |
|---|---|---|
| 基線 | `npm ci` | exit 0；安裝 1 package，audit 0 vulnerabilities。 |
| 基線 | `npm test` | exit 0；220 tests：219 pass、0 fail、1 skip。 |
| TDD RED，只有新測試、尚未改 production code | `node --test test/browser-config.test.mjs` | exit 1；7 tests：4 pass、3 fail。失敗為環境 channel、executable 優先序及有空格 executable 被忽略，仍送出 chrome channel。 |
| TDD GREEN，加入最小實作 | 同上 | exit 0；7／7 pass。 |
| 實作全套 | `npm test` | exit 0；227 tests：226 pass、0 fail、1 skip。 |
| 相依風險 | `npm audit --audit-level=high` | exit 0；0 vulnerabilities。 |
| 差異檢查 | `git diff --check`、提交前 staged diff check | exit 0；沒有 whitespace 錯誤。 |

略過原因是既有 Caddy metadata 測試需要 POSIX ownership；不將 Windows 略過視為 Linux 驗證。
新增測試呼叫真實 `BrowserSessionPublisher.start()`／`close()`，只替換外部 browser launcher，
核對傳入 Playwright 的 profile 與選項；涵蓋空值預設、環境 channel、executable 優先、
constructor 覆寫、有空格路徑、關閉重啟與啟動失敗不 fallback。
這組測試不是 ARM、真實 browser、HoYoLAB 登入或雲端部署測試。

## Box：區分 CLI、MCP 與真正驗證範圍

主協調者提供獨立執行結果；本分工另讀取 baseline／browser log 核對，沒有自行使用 Box 秘密。
證據在 repo 外的 `D:/CodexWork/free-worker-migration-evidence/`，不將外部登入或設定檔加入 Git。

| 項目 | 證據／結果 |
|---|---|
| MCP OAuth | Codex CLI `0.144.1` 兩次 consent 嘗試（第二次完整原始 URL），Chrome 已按 Allow；錯誤 `Authorization server response missing required issuer: expected https://mcp.box.simular.ai`。原生 MCP 驗收仍為 `SIMULAR_BOX_BLOCKED`。 |
| 官方 Box CLI | 後續官方 CLI OAuth 成功，實際 `exec --box main --sh ...` 成功。不能再將所有 Box 遠端能力標成不可用。 |
| 遠端環境 | Ubuntu 24.04.5 LTS x86_64、Node 24.21.0、npm 11.19.0、約 3.8 GiB RAM。來源 `global-box-integration.md` 及主協調者更新。 |
| 基線完整測試 | `box-baseline-tests.txt`：checkout `8e37fbc49cec79a3594638c832c52839a0b1fc62`，`npm ci`／`npm test` exit 0，220／220 pass、0 skip。 |
| 實作完整測試 | 主協調者提供 `box-implementation-tests.txt`：精確 `1151e2e68d98f84856d10aaef873121100391509`，`npm ci`／`npm test` exit 0，227／227 pass、0 skip，0 vulnerabilities。 |
| Playwright browser smoke | `box-browser-test.txt`：chrome channel、headless persistent context，Chrome `157.0.8103.38`，合成 `example.test` cookie 關閉／重開後保留，臨時 profile 已刪除。 |
| 真實 publisher 啟動 | 主協調者提供 `box-publisher-synthetic.mjs`／`box-publisher-browser-test.txt`：精確實作 SHA，預設 chrome 及明確 `/usr/bin/google-chrome` 的 start-close-start 均 exit 0，Chrome 同上；臨時 profile 已刪除。 |

最後一項 route 在 context launch 後才註冊；persistent page 重啟自動導航可早於 route 註冊，
其中一次頁面標題為 `Currency Wars Highlights Page`。只採認 launch／relaunch，
**不採認確定性路由隔離、登入恢復或完全沒有外部頁面讀取**。使用全新合成 profile，
沒有帶入真實憑證；此證據不是 HoYoLAB 登入、MFA、寫入或 auth recovery 驗收。
Box Linux x64 成果亦不能外推至 Uppcoder、Oracle 或 ARM。

## 供應商研究與實際 access 狀態

研究交付：repo 外 `uppcoder-research.md`（2026-11-11）；包含官方來源、動態 Pricing DOM
查證與條款。研究有更新，故不將較舊檔案 hash 當成最終版本標識。
重點已整合進操作手冊；原任務已授權免費實驗，不能把 access／前置條件不足寫成欠缺授權。

- Uppcoder 帳號**已登入**；已實測 Spark 免費方案，結果為 **`UPPCODER_NO_GO`**，
  範圍限此次受支援的免費 Node.js 架構。詳見下節；其他自訂或供應商映像未驗證。
- Oracle 已登入，確認新加坡 Home Region；一次 A1 1 OCPU／6 GB、Ubuntu 24.04 Minimal
  aarch64 建立請求，被 AD-1 Out of capacity 拒絕。`ORACLE_BLOCKED`，未改用付費資源。
  回查同 region／root compartment 的 Instances、VCN、Block volumes、Boot volumes 均無項目。
  詳見 repo 外 `oracle/provisioning-preflight.md` 與 `oracle/a1-capacity-failure.txt`。
  未驗證帳戶全域 Limits／帳務，沒有成功 VM、ARM、systemd、TLS 或登入測試。
- 現行 A1 Always Free 專頁為 **2 OCPU／12 GB**（1,500 OCPU-hours／9,000 GB-hours 每月）。
  較大 paid-tenancy allowance 與舊 4／24 說明不能當成未升級帳號保證。
  來源：[官方 Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)。

## Uppcoder 免費環境實驗

依 repo 外 `uppcoder-experiment.md` 與 `uppcoder-supported-browser-options.md`：後者是較早的
公開文件調查，其對 E2E Testing 可用性的未知狀態，已由後續實際介面與預檢結果補充。
實驗無資料庫、真實秘密或既有 browser profile；以下是實驗紀錄，不是本次文件編輯重新執行。

- Spark 帳戶頁顯示 €0／月、無付款方式。建立私有實驗 Node.js stack `hsr-worker-compat`
  （2113），checkout `7828024e914db59777fd6fb49d0601d8e2590ce1`，平台顯示 Deployment
  Complete。Debian 12 x86_64、非 root uid 1000、Node 26.13.0、npm 11.20.0；觀察到的
  cgroup 3 GiB／1 CPU 不是免費方案額度承諾。SSH host key 為首次使用時信任（TOFU），
  未經獨立認證。
- `npm ci` exit 0、audit 0 vulnerabilities。預設 `npm test` 為 **226 pass／1 fail／0 skip**：
  `worker.test.mjs:74` 等待 transfer call 時觀察到 0；單獨執行該檔 **13／13 pass**，
  完整測試以 `--test-concurrency=1` 執行 **227／227 pass、0 skip、exit 0**。
  並行時序可能相關，但未證明是失敗原因。
- Playwright 1.62.1 官方 CLI 成功下載 Chromium；以 `chromiumSandbox: true` 啟動持久
  context 失敗，exit 1（browser exit 127），缺少 `libatk-1.0.so.0`；`ldd` 亦列出其他
  缺失函式庫。環境沒有免密 sudo，無法自行以特權 apt 安裝系統套件；沒有用停用 sandbox
  或未核准的 binary 繞過。供應商 FAQ 描述系統套件需由供應商／映像支援。
- UI 顯示官方 E2E Testing，但既有 stack 的 Apply 停用，工具須在建立 app 時加入。
  使用者明確同意**僅刪除並重建此實驗 stack**，因此刪除 2113 與合成標記；這不是
  持久化失敗測試，不能據此宣稱重啟或重建會遺失狀態。重新配置 Node.js 加 E2E Testing、
  不加資料庫時，平台預檢拒絕：需 2 apps，超過免費方案 1 app 上限（0／1）；介面表示
  未建立任何項目且未收費。未升級付費方案，實驗紀錄的最新帳戶狀態為**零 stacks**。
- 結論僅適用已測架構：缺少 browser 系統依賴，官方 E2E 組合又超出免費 app 額度。
  其他自訂映像是否可行未知；如日後出現供應商支援的單 app browser 映像可重新評估。
  沒有完成 HoYoLAB 登入、讀取、發布、worker 外部 API、狀態重啟、MFA 或 ingress 驗收。

## Box OAuth 後續修復

獨立官方 `@openai/codex 0.167.1` 安裝於 D 槽，用相同 Codex home 完成 OAuth，
沒有替換桌面程式、匯出 token 或放寬全域工具核准。
原版 `0.144.1` 隨後透過原生 `box/box_list` 成功取得既有 main box；
這是原生 MCP 握手及授權讀取成功證據。`box/shell` 回傳 user cancelled MCP tool call，
沒有執行輸出，不能計為遠端 shell 通過。另一次新 CLI session 沒有提供原生工具，亦未計為成功。
證據在 `D:/CodexWork/box-oauth-fix/repair-report.md` 及其 verification logs。
先前表格的 issuer 錯誤是修復前歷史，不能再作為目前 OAuth 狀態；完整
`SIMULAR_BOX_READY` 仍待互動式 session 允許原生唯讀 shell。

## Production 唯讀頁面 smoke

主協調者回報 2026-11-11 以 `Invoke-WebRequest` GET：
`https://hsrcurrencywartransfervercel.vercel.app/` 回應 HTTP 200、14,267 bytes；
`/admin` 回應 HTTP 200、9,552 bytes。未登入或提交。本次文件編輯未重新執行；
此結果只證明當時公開頁面可取得，不證明 Azure backend 健康、登入或授權正常。

## GitHub 與部署稽核

透過 `gh api` 唯讀查證當下基線 `main` 與部署關聯，沒有讀取 repository secrets。

- `main` 為 `8e37fbc49cec79a3594638c832c52839a0b1fc62`，branch protection 啟用，
  strict required checks 綁 GitHub Actions app `15368`：`ubuntu-latest / Node 20`、
  `ubuntu-latest / Node 22`、`windows-latest / Node 20`、`windows-latest / Node 22`。
  四項在**基線 SHA** 全部 completed／success。
- 同基線的 CircleCI Linux Node 20.20.2／22.23.4／24.18.0 commit statuses 也為 success。
  不以 CircleCI 代替 required GitHub Actions checks；本次沒有新增 runner 或修改保護。
- `.github/workflows/ci.yml` 已對 main PR 執行 `npm ci`／`npm test`，Linux Node 22 另跑 high-severity audit。
  本次保留原設定；新 PR CI 是另一個 SHA 的證據，不能引用基線綠燈聲稱新 PR 已通過。
- 部署 repo `main`：`db495549ba889d6c1ff609ae7b09b9721ba35692`；提交訊息
  `deploy: add seven-cost Aha from main 8e37fbc`。GitHub Production deployment `7701616363`
  建立於 `2026-11-11T04:19:22Z`，status success。沒有核實遠端 worker 檔案、
  Azure service 設定或 Vercel 環境值；提交訊息的來源關聯不等於完整部署內容比對。

## 尚未通過的驗收

| 驗收 | 狀態 |
|---|---|
| ARM executable／channel 真機啟動及實際 browser 相容性 | 未執行。 |
| Uppcoder 持久 browser worker、每日資源預算、重建／重啟 | 已測免費 Node.js 架構為 `UPPCODER_NO_GO`；持久化、用量及重啟仍未驗證。 |
| Oracle 免費資格、容量、VM／磁碟及 ARM runtime | Console 顯示 A1 Always Free-eligible；實際建立遭新加坡 AD-1 容量不足拒絕。沒有 VM／ARM 驗證，帳務未核實。 |
| HoYoLAB 登入、MFA、過期恢復及真實建立／編輯 | 未執行；沒有 Production 寫入。 |
| 真實持久狀態搬移、session 撤銷延續、端到端發布／去重 | 未執行；本機既有 regression suite 不能替代。 |
| 目標 HTTPS ingress／rate limits、DNS／Vercel 切換與回滾演練 | 未執行。 |
| Box 原生 MCP OAuth／tool 驗收 | OAuth 已透過獨立 0.167.1 CLI 修復；原版 0.144.1 原生 box_list 成功。原生 shell 被核准層取消，尚未通過。 |

只有原始碼與測試／文件可以提交供審查。保留 Azure，不合併、不部署、不宣稱遷移完成。

## Oracle 合成工具的新增驗證

本次新增離線 browser 檢查、loopback HTTP／JSON 與程序重啟合成工具，操作方式見
[Oracle staging 操作稿](../infrastructure/oracle-staging-bootstrap.md)。
Windows Node24.18.0 完整 `npm test`：237 tests、236 pass、0 fail、1 既有 POSIX skip，exit0；
log：`D:/CodexWork/free-worker-migration-evidence/oracle/local-final-tests.txt`。
子代理聚焦驗證另記：Windows48/48、WSL x86_64 Node22.23.2 17/17；合成 HTTP exit0、
三份 JavaScript syntax check、五段 shell bash-n。這些不是 Oracle／ARM 實機結果，
WSL 無權建立 network namespace，沒有把未執行的 browser launch 計為 pass。
精確交付 commit 由 PR head 指定；遠端獨立 exact-commit 結果另於後續證據紀錄。

### Box 獨立驗證新增交付 commit

以官方 Box CLI 於全新 `/tmp/hsr-oracle-verify.*` checkout 固定
`b220723cbf26bb6c3f5cf619dd9612b4a3c6933c`，Linux x86_64、Node24.21.0、npm11.19.0。
`npm ci` exit0（audit0 vulnerabilities）；`npm test` **237/237 pass、0fail、0skip**；
`node scripts/infrastructure/oracle-synthetic-http.mjs` exit0，驗證 loopback health、未授權拒絕、
合成工作及 JSON 重讀。整個遠端命令 exit0。完整 log：
`D:/CodexWork/free-worker-migration-evidence/oracle/box-b220723-tests.txt`。
這是官方 CLI 路徑的獨立 Linux x64 證據，沒有執行 Oracle、ARM、登入或真實發布。
本段後續提交只補文字證據；可執行來源以此固定 SHA 為準，不能聲稱尚未測的後續變更已通過。
