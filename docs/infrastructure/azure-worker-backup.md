# Azure worker 加密備份與復原

更新：2026-11-12（Asia/Hong_Kong）。本程序先於 GCP 待命部署。**尚未安裝到正式 Azure、尚未啟用每日排程，也沒有已驗證的正式備份。** Azure 服務未因本工作被停止或重新啟動。

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

## 外部儲存與金鑰託管：待核准

目前 Azure 帳戶的 `az storage account list` 回傳空陣列；未發現已核准的雲端備份儲存。未建立 Storage Account、bucket 或付費備份服務。

建議目的地為**這台 Windows 主機**的受限、加密磁碟目錄 `D:/hsr-worker-backups`，與兩台 VM 都分離；金鑰另存 `D:/HSRRecoveryKeys`。這兩個位置只是提案，**尚未建立正式備份或獲得目的地核准**。需要確認 BitLocker/其他磁碟加密、NTFS ACL、主機可用性及第二份離線 recovery key custody。單一 PC/磁碟遺失仍是風險；沒有核准就不轉移正式 state。

VM 上的 `/var/lib/hsr-worker-backups` 是短期 **encrypted spool**，不算外部備份。`backupUser` 只取得此加密目錄與檔案，不取得私鑰。來源 spool 與 collector 的 `latest-verified.json` 不能混稱遠端備份成功。

## 核准後的一次性設定

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

## 現況收據

- 正式外部備份位置：**尚未配置**。
- 最新已驗證正式備份 timestamp：**無**。
- Daily schedule：**未安裝**。
- 合成演練：實際 store 建立 mapping/job/quota/security 後，加密、驗證、還原、逐 byte 與實際 store dashboard 比較；結果見 [GCP 驗證](../verification/gcp-worker-tests.md)。合成成功不是正式備份成功。
- 復原風險：目的地/金鑰 custody 尚待核准、SSH 逾時、沒有正式 archive、沒有首次正式 restore drill、日常 pause 尚未核准、PC 非常開、備份至下一次間的 RPO 最長約一天且可能更長、來源斷電時未完成 publish 仍需唯讀核對後人工 reconciliation。
