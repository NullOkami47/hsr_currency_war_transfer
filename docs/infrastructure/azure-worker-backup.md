# Azure worker 加密備份與復原

更新：2026-11-12（Asia/Hong_Kong）。**Azure Blob 自動備份已部署並啟用；首次正式備份與 VM 外三檔還原均已驗證。** 本次僅更新獨立備份工具；正式 worker 因一致性備份短暫停止後已恢復，Chrome profile 未備份。下方原 Windows collector 程序屬歷史方案，現行操作以「現行 Azure Blob 部署收據」為準。

## 正式設定的實際發現

透過 Azure Run Command 執行唯讀 `systemctl show` 和 `/proc/<MainPID>/environ` 白名單查詢；SSH 本次在 banner exchange 逾時。未輸出 token、環境檔內容、JSON 內容或 Cookie。

| 項目 | 實測值 |
| --- | --- |
| VM / region | `hsr-transfer-worker` / `francecentral` |
| 服務 | `hsr-transfer-worker.service`，active/running，User=`azureuser` |
| 程式目錄 / Node | `/opt/hsr-transfer-worker` / `/usr/bin/node` |
| 環境檔 | `/etc/hsr-transfer-worker.env` |
| mapping | `/var/lib/hsr-transfer-worker/transfers.json`，0600，觀察時 7,528 bytes |
| jobs、quota、policy | `/var/lib/hsr-transfer-worker/jobs.json`，0600，觀察時 7,337 bytes |
| rate limits、admin sessions | `/var/lib/hsr-transfer-worker/jobs.json.security.json`，0600，觀察時 291 bytes |
| **排除的 Chrome profile** | `/var/lib/hsr-transfer-worker/browser-profile`，0700 |
| HTTP | `127.0.0.1:8787` |

這是程序實際環境的觀察，不是推測預設路徑。正式執行前再以 `sudo node scripts/infrastructure/discover-worker-state.mjs` 確認。觀察中的檔案大小不是一致性備份證據。私有收據位於本機 `D:/CodexWork/free-worker-migration-evidence/gcp/azure-state-paths.json`。

## 工具與一致性邊界

- `worker-state-backup.mjs` 僅納入三個明確設定的 JSON。`security` 必須恰為 jobs path 加 `.security.json`；缺檔、來源 symlink、transfer lock、舊版 quota schema、queued/running job 一律拒絕。不會補空白 quota/security state。
- 每個來源上限 8 MiB；加密 archive 上限 64 MiB。這是保護 1 GB VM 的保守限制，超限時須先評估，不自行放寬。
- `coordinated-worker-backup.mjs` 先鎖定維護流程，記住公開提交開關，關閉新提交，最多等候 120 秒排空，停止**指定服務**，核對 inactive/dead、MainPID=0 和其他已知寫入程序後讀取三檔，再次檢查服務已停止。
- 服務停止後才做最終狀態讀取；不是依序複製正在寫入的檔案。維護期間禁止其他管理員啟動手動 transfer/adopt 或修改政策。
- 日常備份會在 `finally` 嘗試恢復原服務、核對健康，再還原原公開提交開關。服務不健康時保持提交關閉並回報失敗。若 stop 結果或唯一寫入者未確認，也不會自動重啟 publisher；必須人工復核。只有兩次 stopped/exclusive 檢查成功後才恢復服務。此日常工具**不可**當作 cutover 的最終備份命令，因為它會重啟 Azure；cutover 使用停止後的低階 snapshot。
- SHA-256 manifest 保留靜止時三檔的位元組、長度與 hash；加密 maintenance metadata 另保存暫停前的公開提交開關。還原先保持提交關閉，經核准再依該值恢復。AES-256-GCM 加密內容，隨機資料金鑰以 RSA-OAEP-SHA256 包裝；RSA 至少 3072 bits。私鑰不部署到任一 VM。
- receipt 包含 ciphertext hash、timestamp、recipient fingerprint，不包含明文 state。傳輸後須在外部備份主機解密並逐檔核對，才能登記 `latest-verified.json`。
- `restore` 拒絕既有目的目錄；只寫入固定的三個檔名，0700/0600，逐檔 fsync，成功後留下 `restore-receipt.json`。中途失敗會清除自己建立的還原目錄；斷電可能留下不完整目錄，沒有成功 receipt 不能啟動 worker。
- 解密後保留整份原始 state，不重建 quota、不刪除 session/revocation、不重設保留期限。保留 session 代表還原也可能回復較早撤銷狀態；災難復原前須評估失效或撤銷管理員 session，不能以舊備份無條件重開服務。

## 歷史方案：Windows 外部儲存與金鑰託管（已由 Azure Blob 取代）

目前 Azure 帳戶的 `az storage account list` 回傳空陣列；未發現已核准的雲端備份儲存。未建立 Storage Account、bucket 或付費備份服務。

建議目的地為**這台 Windows 主機**的受限、加密磁碟目錄 `D:/hsr-worker-backups`，與兩台 VM 都分離；金鑰另存 `D:/HSRRecoveryKeys`。這兩個位置只是提案，**尚未建立正式備份或獲得目的地核准**。需要確認 BitLocker/其他磁碟加密、NTFS ACL、主機可用性及第二份離線 recovery key custody。單一 PC/磁碟遺失仍是風險；沒有核准就不轉移正式 state。

VM 上的 `/var/lib/hsr-worker-backups` 是短期 **encrypted spool**，不算外部備份。`backupUser` 只取得此加密目錄與檔案，不取得私鑰。來源 spool 與 collector 的 `latest-verified.json` 不能混稱遠端備份成功。

## 歷史方案：Windows collector 一次性設定（未安裝）

1. 核准外部目的地、金鑰保管者、每日短暫服務暫停及排程主機。部署僅限本次 reviewed scripts；不要把實驗分支整個覆蓋正式 worker。記錄部署 SHA。
2. 在本機 D: 以互動式密語產生 RSA-3072（或 4096）加密 PKCS#8 私鑰及 SPKI 公鑰。密語不得進入 shell history、Git 或聊天；可在 Node `generateKeyPairSync` 由 process-only 環境變數取得。另做經核准的離線金鑰備份。
3. 私鑰保留外部主機。只將公鑰部署到 `/etc/hsr-backup/recipient-public.pem`，核對 fingerprint。複製 `azure-backup.example.json` 為 `/etc/hsr-backup/backup.json`；依 discovery 核實 path、service 和 `backupUser`。root 擁有，mode 0600；環境檔必須 root-owned 0600。公鑰可 root-owned 0644。
4. 保留 Azure 現有 Chrome profile，任何命令都不複製或匯出它。不得從外部備份主機啟動 production publisher。
5. 複製 `backup-collector.example.json` 至本機私有設定位置，填入**已核對的** SSH host、私鑰路徑、repository、外部目錄和 backup private-key path。嚴格驗證 SSH host key，不能 `StrictHostKeyChecking=no`。
6. 互動式輸入 recovery-key 密語，以 `Read-Host -AsSecureString | Export-Clixml` 儲存在同一 Windows 使用者/主機的 DPAPI 檔案；只讓該身分及管理者可讀。排程程序從 DPAPI 取用密語，只暫時設定自己的 process environment，不輸出它。
7. 先執行一次 `Collect-WorkerBackup.ps1 -Config D:/<private>/collector.json -AuthoriseServicePause`，核對正式服務恢復、提交開關回復及本機 `latest-verified.json`。目前 SSH 逾時必須先解決，不能將未到達的 copy 當成功。
8. 在隔離、停用 publisher 的環境完成正式 archive 的還原驗證；不啟動 queue、不登入、不連線 HoYoLAB。JSON 內仍有個人/安全資料，只能在核准位置操作，不能放到 Box。
9. 再執行 `Install-WorkerBackupTask.ps1 -Config ... -PowerShellPath <verified-pwsh.exe> -InstallApprovedDailyPause`。會建立當地時間每日 03:00 的 Windows Task Scheduler task，禁止重疊、要求網路、錯過後於可用時補跑，10 分鐘執行上限。沒有系統級 credential 匯出。

這個 task 使用 Interactive 使用者登入；PC 關機、休眠、未登入、網路/SSH 失敗時不能保證每日備份。Windows 的 `LastTaskResult` 和 `latest-verified.json` 必須一併檢查。若需要不依賴 PC 的保證，需另核准既有常開安全目的地，而不是偷偷建立付費基礎設施。

## 七日保留與還原

`Collect-WorkerBackup.ps1` 只收集 ciphertext/receipt，傳輸 checksum 核對後以 recovery key 解密驗證，再執行七日 retention。只有檔名符合工具格式、receipt/ciphertext/三檔 manifest 全部驗證成功的過期 pair 才能刪除；至少有一個七日內的新成功備份才 pruning。未驗證、不完整、symlink、金鑰及其他檔案不會刪除。來源 VM encrypted spool 未自動 pruning；外部交付確認後再清理，不能讓來源滿碟。

低階命令（須私有 config；不能填假的 service 或 quiescence 證據）：

```sh
# 正式 service 已停止且佇列已排空，才可 snapshot；不自行停止/重啟服務。
node scripts/infrastructure/worker-state-backup.mjs snapshot /etc/hsr-backup/backup.json
# 外部主機；config 指定 archive、receipt 及加密私鑰，密語由 process environment 提供。
node scripts/infrastructure/worker-state-backup.mjs verify /private/restore-config.json
# 停止的 Linux 目標；只寫全新隔離目錄，不覆蓋現有 state。
node scripts/infrastructure/worker-state-backup.mjs restore /private/restore-config.json
# 不讀正式資料的可重現演練。
npm run backup:drill
```

CLI `restore` 需在 Linux 上證明 target service 已停止。跨機遷移建議在核准的離線主機受限還原目錄解密，再經驗證的 SSH 傳輸固定三檔到停止的 GCP；private key 不跟隨 VM。若以 library 在 Windows 離線還原，quiescence callback 必須代表那裡沒有 publisher，不能用它假冒正式 VM 停止證據。

## 歷史驗證收據（Blob 部署前）

- 正式外部備份位置：**尚未配置**。
- 最新已驗證正式備份 timestamp：**無**。
- Daily schedule：**未安裝**。
- 合成演練：實際 store 建立 mapping/job/quota/security 後，加密、驗證、還原、逐 byte 與實際 store dashboard 比較；結果見 [GCP 驗證](../verification/gcp-worker-tests.md)。合成成功不是正式備份成功。
- 復原風險：目的地/金鑰 custody 尚待核准、SSH 逾時、沒有正式 archive、沒有首次正式 restore drill、日常 pause 尚未核准、PC 非常開、備份至下一次間的 RPO 最長約一天且可能更長、來源斷電時未完成 publish 仍需唯讀核對後人工 reconciliation。

補充實測：正式 state schema 為 transfers1/jobs4/security1，符合備份工具的版本要求；當次唯讀統計為26mappings、6completed/3failed jobs，未見 queued/running。環境檔 root-owned0600，符合 coordinator 的保護檢查。這些分別的 live reads 不是一致性 archive。Azure 最後健康核對仍為原 MainPID559799、active/running，起始時間2026-11-11T09:27:57Z，loopback health ok。部署目錄沒有 `.git`，不能把本機 branch SHA 當成正式 worker SHA。

## Azure Blob 排程設計（已部署，以下保留設計限制）

此方案使用 systemd timer 在 Azure VM 執行既有 coordinated backup，待 worker 和原本的提交政策恢復後，僅將加密 envelope 與不含 state 明文的 receipt 寫入 `hsrstatebackup261112` / `worker-state` 的 `hsr-state/` 前綴。傳送程式以 VM 系統指派 managed identity 透過 IMDS 取得 Storage token，不輸出 token；Blob PUT 使用不可覆寫條件，接著各自 GET 並比對 SHA-256。這只證明當次讀回與本機檔案一致，**不是**私鑰解密、GCM 認證、三檔 manifest 驗證或還原演練。失敗或碰撞不覆寫、不刪除；部分上傳及本機 spool 保留供人工調查。程式不會自動重送舊 pair，下一次快照使用新名稱。

部署門檻：使用者確認 `D:/HSRRecoveryKeys` 的復原私鑰與 DPAPI 保管及獨立復原流程後，才進行任何正式快照或安裝／啟用排程。使用者已回報容器私人存取、停用 shared keys、HTTPS/TLS 1.2，以及 VM system-assigned identity 的容器範圍 Blob Data Contributor；這些是使用者提供的狀態，部署前應重新核對。確認公鑰 fingerprint 與受保護、在 VM 外的私鑰吻合，且完成離線解密／還原演練；私鑰與 DPAPI 密語不可放入 VM。這項工作未產生或轉移任何金鑰及正式 state。

部署時須先核對實際服務、環境檔、路徑與 `/usr/bin/node`；使用 Node 20.11 或更新版本。以 `azure-blob-backup.example.json` 建立 root-owned `0600` 的 `/etc/hsr-backup/backup.json`；不設定舊 SSH collector 的 `backupUser`，建立 root-owned `0700` 的 `/var/lib/hsr-worker-backups`；所有上層目錄須由受信任的 root 管理。只部署公鑰。systemd 範本的 `/opt/hsr-transfer-worker`、spool 及執行檔位置必須與實際部署相符。先以合成資料和非正式測試環境驗證，再經授權執行一次正式備份、讀回、外部解密與還原核對，最後才考慮安裝 timer。timer 是每日 19:00 UTC（香港時間次日 03:00），`Persistent=true` 會在錯過後補跑；請在排程前確認暫停時間可接受。systemd 同一 service 不會重疊啟動。30 分鐘上限若在協調期間終止程序，可能留下服務停止或提交暫停，需依既有程序人工查明與恢復；不得假設已自動復原。

**保留政策：至少保留七日，不啟用無條件按年齡刪除。** 目前模組不刪 Blob 或本機 spool，也不安裝 Azure lifecycle 刪除規則，避免清除最後一個有效備份或不完整證據。應監控容量與備份新鮮度；只有在 VM 外以私鑰核對候選舊 pair 和至少一份七日內較新的完整備份、確認沒有時間異常並保留最後有效副本後，才由授權人員依受控程序清理超過七日的 pair。現有本機 `prune` 僅處理外部可解密的本機副本，並不實作 Blob 清理。Blob soft delete／版本控管等可提供額外復原能力，但不能取代上述驗證條件。

## 中斷紀錄、鎖與人工復原

此版本的 service 在整次協調和 Blob 交付期間透過 `/usr/bin/flock` 持有 `/run/hsr-worker-backup.flock`；程序結束時核心釋放鎖，不依賴刪除鎖檔。**鎖是否已釋放不代表服務或 admission 已復原。** `/var/lib/hsr-worker-backup-control` 由 systemd `StateDirectory` 建立為 root-owned `0700`，不隨 `/run` 重開機消失。部署前確認該路徑位於持久、支援 fsync 的檔案系統；service 的 `ReadWritePaths` 和實際 spool 必須一致。獨立呼叫 coordinator 的舊 Windows SSH collector 沒有此 flock wrapper，會被新版入口拒絕；不要設環境變數繞過鎖。若要重新啟用舊 collector，須另行更新並驗證它使用同一把 kernel lock。

`journal.json` 記錄執行 ID、service、原始 admission 和階段；在第一次更改 admission 前寫入、同步檔案、原子更名並同步目錄。各階段在相關動作之前更新。完成復原、健康檢查及原 admission 讀回後才標為 `complete`。任何未完成、損壞或無法讀取的 journal 都阻擋下一次快照，不會由程式自行推斷原設定或解除。收到 SIGTERM/SIGINT 時，程序在有界操作的安全邊界要求停止並嘗試既有復原；SIGKILL、斷電、系統終止逾時、子程序異常及鎖外呼叫仍可能留下未完成紀錄。`TimeoutStopSec=240s` 不是服務已復原的證明。

人工 reconciliation 由有權限的管理者執行：先停止／停用 timer、排除所有管理操作和其他 writer，取得同一把 flock；檢查 journal 的 service、原 admission、階段與時間，保留 journal 及 systemd 日誌。分別確認 service 的實際狀態、健康、queue、其他 writer 和可能未完成的發布；停止或 writer 狀態不明時，不要直接重啟 publisher。只有確認單一 writer 與發布狀態安全，才能依原 policy 進行必要的人工恢復，再實際讀回健康與 admission。原 policy 無法可信判定時保持阻擋並升級處理。確認後，將舊 journal **保留為受保護的歸檔**，在持鎖下由管理者移離 `journal.json` 並同步目錄；不得僅因鎖已釋放或逾時就清除。正式重新執行及重新啟用 timer 仍須符合當前授權。

`status.json` 是 root-only、原子更新並同步的本機機器可讀狀態：`result` 為 `running`／`success`／`failure`，另有 `lastAttemptAt`、`lastSuccessAt`、`lastFailureAt`、`stage`、`workerHealth`、`transportVerified` 與 `restoreVerified`。`workerHealth=confirmed` 僅表示本次 coordinator 恢復時曾確認，並非持續監控；`restoreVerified` 不會因 Blob 讀回變為 true。執行中被強制終止可留下 `running`；外部監控應以時間戳判斷卡住，並處理缺檔、時間倒退或未來時間。可考慮監控：失敗或未完成 journal、service 的 systemd Result（包括 flock 衝突或 status 無法寫入）、running 超過執行與停止上限、最近成功過舊、worker 健康與 spool 容量。**目前沒有設定外部告警或證明有人監看。**

排空時每次 dashboard 和停止前最後一次 dashboard 都要求 admission 為 false，最後一次也要求 queue/running 為零；這些讀取不能提供排他性。現有 worker 沒有阻擋其他管理者重新開啟 admission 的 maintenance barrier，因此執行期間仍須凍結其他 admission 變更和手動 writer；最後一次讀取與 stop 之間仍有競爭窗口。首次正式暫停前，必須在獨立的非正式 Linux/systemd 環境驗證鎖、掛載權限、強制終止與人工復原，再完成部署審查。

新版部署必須一併核對同版四個模組：`worker-state-backup.mjs`、`coordinated-worker-backup.mjs`、`backup-control-state.mjs`、`azure-blob-backup.mjs`，以及 service/timer、Node 和 root 受信的模組父目錄。已安裝的 `/opt/hsr-backup` 內容與本範本路徑可能不同，必須先核實完整路徑和雜湊；缺少新 control-state 模組時 Node 在建立 status 之前便會失敗。此文件與範本未更新任何 VM，`systemd-analyze verify` 也不驗證 Node imports、flock 排他性或實際復原。

## 現行 Azure Blob 部署收據（2026-11-12）

使用者在本對話明確核准第三種 Azure Blob 方案與 `D:/HSRRecoveryKeys` DPAPI custody。首次正式快照時間 **2026-11-12 13:53:58.279 +08**；傳輸完成 **13:54:01.008 +08**。密文 28,505 bytes、receipt 242 bytes；SHA-256 `ba6f02b0cc6c289352bdb215b47b09aa2cc0698af286a2a5674fdab868a4c803`。本收據不包含 state、token、Cookie 或私鑰。

- VM：`hsr-transfer-worker`，`RG-HSR-TRANSFER`，France Central。Node `v20.20.2`。
- 目的地：`hsrstatebackup261112` / `worker-state` / `hsr-state/`，Standard LRS Hot；匿名存取與 shared-key 驗證停用，HTTPS/TLS 1.2。
- VM 系統指派 identity 僅有此容器的 Blob Data Contributor；目前 Azure CLI 使用者另有此容器的 Blob Data Reader，用於外部下載驗證。未部署 Storage Account key。
- Blob 與容器皆啟用七日 soft delete；**不是**七日自動清除。現階段不刪除本機 spool 或 Blob，至少保留七日；沒有無條件 lifecycle 刪除。
- 備份只含設定指定的 transfers/jobs/security 三檔，排除 browser profile、環境檔、登入資料。
- 四個正式備份模組位於 `/opt/hsr-backup`，root-owned；config `/etc/hsr-backup/backup.json` root-owned 0600，公鑰 `/etc/hsr-backup/recipient-public.pem`，spool 與 control 各 root-owned 0700。正式 worker 原始碼未覆蓋。
- 原碼提交 `d72c5ff81fbfd9542cc4012788d55a7ec4267318`；只有 service 的安裝路徑由範本轉換至 `/opt/hsr-backup`。實際部署雜湊已逐檔讀回比對。
- timer：`hsr-worker-backup.timer` **enabled/active**；`OnCalendar=*-*-* 19:00:00 UTC`，即香港時間每天 03:00。首次預定 **2026-11-13 03:00 +08**。`Persistent=true`，開機時可補跑錯過的工作；VM 關機或 Azure 訂閱停用期間不能產生新備份。
- 首次實際 service result success / ExecMainStatus 0；journal phase complete / originalAdmission true；worker 恢復 active/running，MainPID 564794，loopback health ok，提交恢復 true。
- VM 外從 Blob 下載兩檔，分別以 DPAPI 私鑰與獨立加密 PEM 解密。GCM 認證與 manifest 驗證成功，三檔還原逐 byte 相符；未啟動 publisher。受限隔離目錄的暫存明文已刪除。VM 上 `initial-restore-verification.json` 記錄此次外部驗證；每天 `status.json.restoreVerified=false` 仍正確表示日常傳送不等於逐日解密驗證。

### 金鑰保管

`D:/HSRRecoveryKeys` ACL 僅限目前 Windows 使用者與 SYSTEM。`hsr-backup-private.dpapi.xml` 為原 DPAPI 私鑰；`hsr-backup-public.pem` 為公開金鑰。公鑰 fingerprint `1b7198fa8f2009311bff67b8df7376f08809d07dc4ffb456076baf67467a56d8`。

另已產生並驗證 `hsr-backup-portable-private.pem`（AES 加密 PKCS#8）及 `hsr-backup-recovery-code.txt`（高熵隨機密語）。**目前兩檔仍在同一台電腦，尚非獨立離線副本。** 使用者須把 encrypted PEM 複製至自行保管的離線媒體，並將 recovery code 另存密碼管理器／不同安全位置；此工作不能證明使用者已完成實體離線保管。金鑰與 code 不傳至 VM、Git、Box 或聊天。

### 驗證與觀測

- Windows Node 24.18.0：301 tests，297 pass，0 fail，4 POSIX skips。
- 全新精確 commit checkout、clean npm ci、Linux WSL2（VHDX 位於 D:/WSL/hoyomix-runner）、Node 22.23.2/npm 10.9.8：301/301 pass，0 skip。Box 工具本次不可用，採同機隔離 Linux 驗證；不是遠端 Box 驗證。
- 初次 Linux 執行遇到 Windows CRLF shell script 與測試 spool 預設權限問題；以 LF 精確 checkout 及明確 0700 fixture 修正後全數通過，失敗 log 保留。
- 非正式 transient systemd 合成演練：與正式相同的主要 sandbox 及 flock，實際停止／重啟獨立 fixture service、恢復 admission、驗證密文；強制終止 lock owner 後鎖釋放。沒有碰觸 HoYoLAB 或正式資料。
- 執行記錄：`D:/CodexWork/hsr-azure-backup-test-evidence/`，Azure run-command 收據位於本次工作目錄 `work/azure-blob/`。

目前只有持久化本機 status、journal 和 systemd Result，**沒有外部 email/SMS/常駐監控告警**；未承諾故障會自動通知。管理者可檢查 `systemctl status hsr-worker-backup.timer hsr-worker-backup.service`、`journalctl -u hsr-worker-backup.service`、root-only `status.json` 和 Blob 最近兩個物件。若 journal 非 complete，先停用 timer，依前述人工 reconciliation 確認單一 writer、健康與原 admission 後再恢復；不要直接刪 journal。日常備份排空與暫停期間勿以管理端或手動腳本更改提交政策。