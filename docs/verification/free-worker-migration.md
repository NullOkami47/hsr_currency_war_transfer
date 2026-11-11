# 免費 worker 遷移驗證紀錄

日期：2026-11-11（Asia/Hong_Kong）。結論：**原始碼設定與本機／Box x64 測試已驗證，
候選供應商與 Production 遷移仍未驗收。** 部署／回滾步驟見
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

- Uppcoder 初次實際存取只到 Sign in；`/dashboard`／`/stacks` 顯示 Page not found，
  不代表正式路由或權限拒絕。最新主協調者更新為**已登入、正進行免費 stack 實驗**。
  本報告尚未取得該實驗的可執行環境、資源、持久化、MFA 或成功部署結果；維持待補。
- Oracle 初次 `cloud.oracle.com` 導向要求 cloud account name 的登入頁，沒有 tenant console。
  最新更新為**註冊進行中**。沒有實際免費資格、home-region 容量、費用或 provisioning 證據。
- 現行 A1 Always Free 專頁為 **2 OCPU／12 GB**（1,500 OCPU-hours／9,000 GB-hours 每月）。
  較大 paid-tenancy allowance 與舊 4／24 說明不能當成未升級帳號保證。
  來源：[官方 Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)。

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
| Uppcoder 持久 browser worker、每日資源預算、重建／重啟 | 實驗進行中，結果待補。 |
| Oracle 免費資格、容量、VM／磁碟及 ARM runtime | 註冊進行中，未驗證。 |
| HoYoLAB 登入、MFA、過期恢復及真實建立／編輯 | 未執行；沒有 Production 寫入。 |
| 真實持久狀態搬移、session 撤銷延續、端到端發布／去重 | 未執行；本機既有 regression suite 不能替代。 |
| 目標 HTTPS ingress／rate limits、DNS／Vercel 切換與回滾演練 | 未執行。 |
| Box 原生 MCP OAuth／tool 驗收 | issuer 相容性錯誤仍阻擋；CLI 執行已成功。 |

只有原始碼與測試／文件可以提交供審查。保留 Azure，不合併、不部署、不宣稱遷移完成。
