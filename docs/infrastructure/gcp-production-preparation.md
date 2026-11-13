# GCP Production 離線準備：NO_GO，未啟用

本 sidecar 僅交付**離線產生器、範本與待驗收契約**，沿用既有 e2-micro、單機 JSON state、Caddy、非 root Chrome 與獨立 Cloud Run monitor；不是新架構，也不是切換授權。主控另處理私有 Vercel repository 的正式 runbook 與費用，本變更不讀寫該 repository。

## 邊界與版本

- 受信任公開來源：`D:/CodexWork/hsr-resilience`，基準 `ca657a47809e1b78aa278a13d71600ce5fd8614a`。
- 獨佔開發 clone：`D:/CodexWork/hsr-gcp-production-prep-20261113`，分支 `codex/hsr-gcp-production-prep`。只有本 sidecar 修改此 clone。
- 沒有雲端、Box、SSH、DNS、provider read/write、私有 upload、服務安裝／啟動／enable、正式環境變更、Azure shutdown、cutover 或 STOP 移除。未消耗 hosted CI。
- **provider `maxRunDuration=3600`、`instanceTerminationAction=STOP`、`automaticRestart=false` 維持不變**。範本的 `RuntimeMaxSec=3600` 只是額外程序界線，不取代 provider STOP。任何未來取消時限均須另一個明確 GO；產生器沒有該功能。
- `validate` 的 exit 0 只代表 schema 與離線範本可產生；不代表服務、HTTPS、備份、通知或還原已驗收。所有輸出保持 `NO_GO`／`activationReady:false`／`backupEnabled:false`。

本文件的資源／部署描述來自上述 commit 的 repository 證據，不是本次 live readback。既有 Azure Blob／GCS 備份與通知的歷史部署紀錄見 [resilience-live-deployment.md](resilience-live-deployment.md)；不把該紀錄延伸成 GCP-native 備份部署完成。

## 離線產生方式

產生器只 import Node filesystem、path、URL 與 hash 模組，沒有 network、subprocess、cloud SDK、activation API。先完整驗證輸入，再 render 固定檔名。它**不讀取** state、browser profile、token file、private key 或實際 environment contents。輸入不得有未知欄位，即使 `enable:false`、`productionAutorun:false` 也拒絕；只接受完全限定的非秘密 schema。

以下命令只操作此 D 槽 clone，均無雲端效果：

```powershell
Set-Location D:/CodexWork/hsr-gcp-production-prep-20261113
node scripts/infrastructure/gcp-production-prep.mjs validate scripts/infrastructure/gcp-production/preparation.example.json
if ($LASTEXITCODE -ne 0) { throw 'Offline schema validation failed' }

# var 必須是既有、非 symlink 的本機目錄；每次輸出使用全新名稱。
New-Item -ItemType Directory -Path ./var -Force | Out-Null
node scripts/infrastructure/gcp-production-prep.mjs generate scripts/infrastructure/gcp-production/preparation.example.json D:/CodexWork/hsr-gcp-production-prep-20261113/var/production-prep-review-1
if ($LASTEXITCODE -ne 0) { throw 'Offline bundle generation failed' }
```

範例 hostname `worker.example.invalid` 故意不能當成已部署網域；可在本機非秘密 config 改成未來要審核的穩定 FQDN。禁止 URL、port、credentials、wildcard、shell／Caddy interpolation、newline、大小寫混用及非法 DNS label。`futureStaticIpv4`／`staticIpv4ApprovalReference` 預設皆 null；填入可接受 public IPv4 與公開審核識別碼也**只是提案**，仍要求未來明確核准與真實 readback。不得在 reference 中放 token 或其他秘密。

state 路徑固定 `/var/lib/hsr-transfer-worker-production`，不能指向 Azure、synthetic state、秘密檔或任意目錄。profile 固定為原碼已釘選的既有 GCP profile；不能改成另一台主機或任意目錄。產生器不將它採用為已驗證的 Production profile。

輸出只准在**此 clone 的 `var/` 下全新子目錄**，祖先均須既有且非 symlink／junction；禁止跨 D 槽、traversal、覆寫與隱式 recursive mkdir。POSIX 建議權限為目錄 0700、檔案 0600；Windows 主控須保護父目錄 ACL，Node mode 不證明 NTFS ACL。若途中失敗，保留新目錄現場供檢查，不自動刪除或重用。

## 產物與防誤啟動

| 產物 | 用途與未完成界線 |
| --- | --- |
| `preparation-plan.json` | 固定來源 SHA、VM／disk 身分、STOP、網路提案、current owner 與完整 blockers；絕不回傳 ready。 |
| `manifest.json` | 除 manifest 本身之外所有檔案的 SHA-256／byte 數；可重現，無現在時間或隨機值。hash 是內容校驗，不是簽章、部署或 approval 證明。 |
| `Caddyfile.template` | 穩定 FQDN、public HTTPS、bearer matcher、未授權 401、只 proxy `127.0.0.1:8787`。無 TLS downgrade。 |
| `caddy.env.template`／`worker.env.template` | token **空白**，沒有生成或搬運秘密；worker env 保持 loopback、headless Chrome、`CURRENCY_WAR_CHROMIUM_SANDBOX=1`、public submissions 關閉、keepalive 關閉。空 token 不能啟動現有 worker。 |
| `worker-preflight.json` | 固定 GCP target VM/zone/instanceId、`/opt/node-v24.22.3-linux-x64/bin/node`、state 與 profile 路徑之非秘密 preflight 設定，供 `gcp-production-profile-preflight.mjs` 檢查。 |
| `backup.json` | 固定 GCP loopback worker endpoint、`paths` 三檔、`/etc/hsr-gcp-production/recipient-public.pem`、`gcp-production/hsr-state/` 與 `gcp-production/monitor/events/` prefix 及 `azureSecondary.enabled=false` 之非秘密備份設定。 |
| `hsr-worker-production.service.template` | 非 root、systemd sandbox、read-only filesystem、限定 state/profile/home writable、無自動 restart、3600 秒。`ExecStartPre` 已接上 `/opt/node-v24.22.3-linux-x64/bin/node` 執行 `gcp-production-profile-preflight.mjs /etc/hsr-gcp-production/worker-preflight.json`；仍受 `ConditionPathExists=/etc/hsr-gcp-production/EXPLICIT_GO` 阻擋且無 `[Install]`。 |
| `hsr-gcp-state-backup.service.template` | 每次有界 oneshot 備份契約，`OnFailure=hsr-gcp-backup-notify.service`；`ExecStart` 已接上 `flock` + `HSR_BACKUP_FLOCK_HELD=1` + `/opt/node-v24.22.3-linux-x64/bin/node` 執行 `gcp-native-backup.mjs /etc/hsr-gcp-production/backup.json`，不呼叫 Azure MI 上傳器；仍受 `EXPLICIT_GO` 阻擋且無 `[Install]`。 |
| `hsr-gcp-state-backup.timer.template` | 每日 UTC 19:00＝HKT 03:00，`Persistent=true`；尚未安裝或 enable。 |
| `hsr-gcp-backup-notify.service.template` | 45 秒上限、不遞迴 OnFailure、不重啟 worker／恢復 admission；`ExecStart` 已接上 `/opt/node-v24.22.3-linux-x64/bin/node` 執行 `gcp-backup-failure-notify.mjs /etc/hsr-gcp-production/backup.json`，僅寫入 allowlisted field 至 GCP event prefix；仍受 `EXPLICIT_GO` 阻擋且無 `[Install]`。 |
| `backup-contract.json` | 三檔、encryption/coordinator reuse、native token／IAM 提案、secondary 阻擋與 retention pin；`implemented=true`、`gcs.adapterNotImplemented=false`，但 `decision="NO_GO"`、`activationReady=false` 且 `azureSecondary.implemented=false`。 |
| `monitor-readiness.json` | current owner 來源、通知 owner 來源、`ownerScopedReadiness=true`（已實作 `HSR_ACTIVE_BACKUP_SOURCE=azure|gcp` 與 `gcp-production/` prefix 隔離），但仍待雲端實機部署、alert 收件與 external restore pin 驗收，`decision="NO_GO"`。 |

所有 unit／timer 都沒有 `[Install]` 或 enable hook，且有未產生的 `/etc/hsr-gcp-production/EXPLICIT_GO` condition。這不是可安全安裝的成品；`false` 與空 token 是誤操作保險，不應為得到綠燈而刪除。沒有產生 install script、GO marker 或可自動執行的 cloud commands。

## 固定目標、HTTPS 與持久 profile

依基準原碼／文件釘選：專案 `hsr-currency-war-worker`、zone `us-central1-a`、VM `hsr-worker-standby`、instance ID `4111188809525812699`、disk ID `9008789074271067611`、e2-micro、保留 20 GB pd-standard、`autoDelete=false`。不得自動接受同名替換資源。network／subnetwork 的精確 selfLink 本次沒有 live 證據，因此維持 null，不能猜成 default。

**runtime 精確釘選**：依主控 2026-11-13 已做的 live checks，正式 worker、native backup／coordinator (`gcp-native-backup.mjs`)、profile-owner preflight (`gcp-production-profile-preflight.mjs`) 與 failure exporter (`gcp-backup-failure-notify.mjs`) 一律使用 `/opt/node-v24.22.3-linux-x64/bin/node`。GCP Ubuntu apt 的 node 是 18.19.1，不是已審核的 Node 24；不使用 `/usr/bin/node`、`env node` 或 PATH fallback。本 repo 已完成上述離線腳本與單元測試，但尚未做 live cloud/Linux systemd 實機驗收；所有正式 unit 仍由 `ConditionPathExists=/etc/hsr-gcp-production/EXPLICIT_GO`、無 `[Install]` 與 `decision="NO_GO"` 嚴格阻擋。

未來 HTTPS 只提案：**經另行核准的 static IPv4 → 同一既有 NIC／network／subnetwork → 原有 Caddy → authenticated loopback worker**。不新建 NAT、LB、network、不擴大公開 worker/CDP/VNC ingress。尚未 reserve／attach static IP、改 DNS、配置 ACME 或改任何 Caddy。需要主控核對 static-IP 費用與持續占用費、DNS A/AAAA、現有 80/443 ingress、ACME TLS、同一私有 bearer 於 Caddy／worker／Vercel 的一致性。不得記錄 bearer；Caddy access logging 不在範本啟用。

已知 profile 精確路徑來自 `gcp-single-transfer.mjs` 的固定授權範圍：

```text
/var/lib/hsr-transfer-worker-staging/login/gcp-readonly-profile-login-20261112
```

必須保持原位置、`hsr-worker` ownership、0700、同 VM `.readonly-vm.json` 私有 receipt，以及原有全域 `.readonly-session-lock`／profile owner／Chrome singleton 防護。不能搬 Azure、本機 cookies、profiles 或 device/session 身分。啟動前須由 `scripts/infrastructure/gcp-production-profile-preflight.mjs` 與實際 Linux 驗收證明 login、synthetic、one-shot、production 及任何手動 Chrome／writer 不併行；未知或 stale lock 不能自動刪除、adopt 或 kill。範本的 `.production-worker.flock` **不是**原有全域鎖的替代；實機 Linux ownership/preflight 與 `EXPLICIT_GO` 驗收尚未完成，故仍維持 NO_GO。

**Explicit Chromium sandbox 實作狀態**：`src/publisher.mjs`（`BrowserSessionPublisher.start()`）及 `scripts/worker-server.mjs` 現已強制要求並傳遞 `chromiumSandbox: true`（若停用即擲錯拒絕啟動），且 `worker.env.template` 設定 `CURRENCY_WAR_CHROMIUM_SANDBOX=1`；`PRODUCTION_CHROMIUM_SANDBOX_NOT_EXPLICIT` 程式碼阻擋已解除。離線測試使用真實 publisher 與 injected browser stub 驗證 launch options，但 Linux/GCP VM 上實際 Chrome sandbox、cgroups/e2-micro 資源與 systemd 整合尚未實機驗收，因此 `LINUX_SANDBOX_AND_RESOURCE_ACCEPTANCE_REQUIRED` 仍維持 NO_GO。

正式 state 是另外的三檔路徑（`transfers.json`、`jobs.json`、`jobs.json.security.json`），不得使用 one-shot／synthetic fixture。未來必須在 admission 暫停、queue drain、ambiguous jobs reconcile、唯一 writer 停止及 profile owner 釋放後，從最新 authoritative snapshot 安裝。若 GCP 日後已有真實寫入，rollback 必須帶回最新 GCP state，不得覆蓋成切換前 Azure 舊檔。這些是主控 runbook 的未來 gate，本產生器不執行還原或初始化空白正式 state。

## GCP-native 備份：程式碼已實作離線契約，雲端仍 NO_GO

### 已實作與可重用介面

- `scripts/infrastructure/gcp-native-backup.mjs`：已實作 GCP-native immutable backup adapter（使用 `createMetadataTokenProvider`、`ifGenerationMatch=0`、bounded readback byte/hash 檢查、`coordinated-worker-backup.mjs` + `worker-state-backup.mjs` 三檔一致性快照，並寫入 allowlisted event 至 `gcp-production/monitor/events/`）。
- `scripts/infrastructure/gcp-backup-failure-notify.mjs`：已實作 bounded failure status exporter，僅上傳 allowlisted 失敗/階段欄位至 `gcp-production/monitor/events/`。
- `gcs-backup.mjs`：原有 Azure `managedIdentityToken` + GCP STS 流程保留給既有 Azure VM 使用，**不動**既有 Azure backup 排程。
- `azure-blob-backup.mjs`：`validateEncryptedBackup` 可重用 transport validation；`runScheduledBackup` 等協調介面可研究，但其既有 CLI／Azure delivery 不可當作 native GCP 上傳器。
- `coordinated-worker-backup.mjs` 的 `coordinatedBackup` 與 `worker-state-backup.mjs` 的 `createStateBackup` 可沿用：外層既有 flock → 私有 recovery journal → close admission → drain／stop exclusive writer → 僅三檔一致快照 → 確認恢復 health 與原 admission → 密文離機。失敗／unknown 不得在 OnFailure 擅自啟動 publisher。
- `cloud-backup-monitor/server.mjs`：已實作 `HSR_ACTIVE_BACKUP_SOURCE=azure|gcp`、`gcp-production/` prefix 隔離、412 exact-match 與 `createMetadataTokenProvider`，並將 `gcp-native-backup.mjs` 與 monitor 的依賴方向保持單向（monitor 只依賴 `backup-watchdog.mjs` 與 `backup-retention.mjs` 以維持極簡 Docker layout）。
- `backup-failure-notify.mjs` 的 `notifyBackupFailure` 可研究 safe field allowlist；其 CLI 仍建立 Azure-MI GCS client，**不得安裝在 GCP 假裝 native notifier**。

### 未來最小 IAM／credential 方案，未核准未建立

只考慮另行核准的專用 VM service account，GCE metadata short-lived token，bucket/prefix 最小範圍 `storage.objects.create`＋`storage.objects.get`；候選 objectCreator＋objectViewer **無 delete/update**，但 Viewer 額外允許 list，需說明或使用經測試的 create/get 自訂角色及 prefix 條件。禁止 Editor／Storage Admin、project-wide role、SA JSON key、refresh token、解密私鑰或長期秘密。

現存 VM 原本無 service account；attach SA／OAuth scope／IAM 均是未來獨立授權的 security-sensitive cloud changes。本次沒有做。還須審查 metadata 存取隔離：同 VM 的 Chrome／其他 workload 可能取得附掛 SA token，`User=hsr-worker`、systemd sandbox 本身不保證 metadata 隔離，不能直接宣稱 production-ready。

未來 adapter 必須限制 deadline／response bytes／retry 數，以 `ifGenerationMatch=0` immutable upload ciphertext＋receipt，再逐物件 read-back byte/hash；412 僅在 bytes 完全相同時算成功。重用 RSA-OAEP＋AES-GCM 格式，VM 只持 public recipient key。驗 transport hash 不代表 GCM 解密／可還原；recovery private key 永不進 VM、Git、Box、聊天或 build source。

### 次要 Azure Blob 與舊備份

既有 Azure Blob、GCS Azure namespace、held canonical pair、七日 minimum retention／soft delete、原有排程及通知**全部保留，不覆寫、不刪除、不換 pin**。它們保護既有 Azure 來源，不代表切換後的 GCP 新 state 已有相同備份。

**GCP→Azure Blob secondary 尚未實作，NO_GO。**需要未來另行測試、核准的 keyless federation 或獲准的 scoped credential；不能假裝 Azure MI 在 GCP 工作，不能依賴日後 deallocated Azure VM 轉送，也不能默默放入 storage account key。`backup-contract.json` 明確保留這個 gate，不將未完成 secondary 報成「雙目的地已完成」。

## 獨立監控、source owner 與 retention pin

本基準的 current authoritative owner 是 **Azure**（來源為上述 deployment 文件；本次未做 live readback）。通知對象沿用既有 Cloud Monitoring owner channel，實際 address／channel ID 在主控 protected runbook 核對，公開輸出留 null，不猜測 email。

GCP daily timer 在 VM 上，不依賴 Windows PC；**VM 停止時 timer 也不會執行**，因此必須保有獨立於 PC、Azure VM、GCP worker VM 的 Cloud Scheduler → authenticated Cloud Run hourly check。預期 gate 為 GCP-specific backup／status 26 小時 missed/overdue，以及 monitor heartbeat 缺失 2 小時；沿用既有通知並驗真實收件，HTTP 200／heartbeat 成功不等於 backup healthy。

既有 monitor（`cloud-backup-monitor/server.mjs`）與 `backup-retention.mjs` 現已支援 `HSR_ACTIVE_BACKUP_SOURCE=azure|gcp` 及獨立 namespace `gcp-production/hsr-state/`、`gcp-production/monitor/events/` 與 `HSR_GCP_RETENTION_BASELINE_JSON`／`HSR_GCP_RETENTION_APPLY`，並透過離線測試驗證「`HSR_ACTIVE_BACKUP_SOURCE=gcp` 時，fresh Azure backup／event 仍會觸發 `snapshot_missing`／`status_event_missing` 告警」、「`azure:skipped` 會觸發 `destination_unverified`」及「invalid source emit `active_source_invalid`」。

但雲端 Cloud Run service／scheduler 尚未切換、SA/IAM 尚未核准附掛、GCP→Azure secondary 未實作且 `HSR_GCP_RETENTION_APPLY` 仍須等外部 authenticated GCM restore pin 後才能啟用，因此仍維持 `decision="NO_GO"`。保留 Azure 原 monitor、historical evidence 與 pin；不得將另一個來源的 archive 當成 GCP 備份。

釘選既有 Azure-prefix baseline 身分：

| 欄位 | 值／來源 |
| --- | --- |
| archive | `hsr-state/hsr-state-2026-11-12T05-53-58-279Z.enc.json` |
| SHA-256 | `ba6f02b0cc6c289352bdb215b47b09aa2cc0698af286a2a5674fdab868a4c803` |
| recipient | `1b7198fa8f2009311bff67b8df7376f08809d07dc4ffb456076baf67467a56d8` |
| bytes／restoreVerifiedAt | 本次不知道，維持 null；從 protected `HSR_RETENTION_BASELINE_JSON` 與外部 authenticated GCM restore receipt 取得，不猜造。 |

既有 temporaryHold 永不移除。新 GCP namespace 不自動繼承可刪除資格：需另有受保護外部 GCM restore pin、generation conditional adapter 及測試，**此前 apply=false**。沿用 retention 的七日、最新／baseline 保護、36h fresh pair、bounded operation、ambiguous delete 不重試與 partial reconciliation 防護。日常 receipt／event／latest object 都不可自行升格為 restore pin。

## 驗收狀態與未來 GO 阻擋

以下任一項缺少真實證據都維持 NO_GO；「離線測試全過」不能移除 gate：

1. 未來明確 GO、exact evaluated commit、既有 immutable VM/disk/NIC readback 與成本接受；STOP 仍維持 3600，任何取消另議。
2. 同網路 future static IPv4 與 stable DNS/TLS/auth/loopback 的實機驗收；主控私有 Vercel runbook 決定 routing，不由 sidecar 修改 Production。
3. Production profile owner guard、single writer、最新 authoritative 三檔 restore、Linux systemd／Chrome sandbox、e2-micro 實際記憶體與 graceful stop。
4. GCP-native immutable uploader、coordinator wrapper、bounded OnFailure exporter 與專用 SA metadata／最小權限驗收；未知 recovery fail-closed。
5. 不依賴 Azure 的 source-scoped daily GCP ciphertext＋receipt／readback，外部 authenticated GCM decrypt／三檔 restore；private key 留在既有核准保管處。
6. **Azure VM 與本機 PC 不可用時**，GCP failure、missed run、VM stopped、notifier failed、monitor heartbeat absent 都能送到實際 owner；Azure fresh 不能掩蓋 GCP failure。
7. 新 GCP→Azure secondary 的已核准／已測試授權與實際 delivery；未實作保持 NO_GO，不自動改用長期 credential。

## 離線測試與證據範圍

先新增 `test/gcp-production-prep.test.mjs`，在 implementation／templates 尚不存在時執行，觀察 13 項預期失敗；再實作並重跑通過。後續額外先寫 publisher sandbox 缺口測試、觀察 blocker 缺少的 assertion 失敗，再補明確阻擋；原始候選共 14 項；主線獨立審查後另補 POSIX FIFO regression，最終 15 項。涵蓋 invalid hostname、state/profile 秘密路徑與 traversal、secret 欄位、autorun／STOP-removal flags、固定身分、空秘密、safe OnFailure、retention/current-owner gaps、deterministic manifest hash/bytes、D 槽本 clone 專屬寫入、覆寫／junction 拒絕及 CLI 不洩漏秘密。

```powershell
node --test test/gcp-production-prep.test.mjs
node --check scripts/infrastructure/gcp-production-prep.mjs
git diff --check
```

產生器輸出 fixture 在本 clone `var/`，不是 C 槽 temp。POSIX FIFO regression 使用 native `/tmp`（本機 WSL 的 ext4 VHDX 位於 D 槽），測後清除；Windows明示skip此項。完整／相關測試另由執行收據列出 exact commit、Node/npm、commands、exit codes 與 pass/skip 數。無 Box／cloud verification；fresh local exact-commit checkout 可驗證可重現性，但不冒稱獨立代理 review 或 Linux／實機雲端驗收。

本次可聲稱的是「產生器 13 項產物契約與 4 項本地程式碼模組（`chromiumSandbox:true`、`gcp-production-profile-preflight.mjs`、`gcp-native-backup.mjs`／`gcp-backup-failure-notify.mjs`、owner-scoped monitor／retention）之離線邏輯與安全 gate 已實作並通過單元測試」，不是 Caddy native validator、systemd-analyze、Linux 實機 profile owner guard、SA/IAM 權限、GCP-native 雲端上傳、live cipher restore、通知收件、Production deployment 或 cutover 完成。

主線輸入reader複審：Linux FIFO在open前可能阻塞的問題已由regular-file precheck、NOFOLLOW/NONBLOCK、16KiB+1有界讀取及前後inode/size/time核對修正。先在WSL重現2秒外部timeout，再以同一regression驗證有界拒絕；純錯誤輸出不含提供路徑或JSON內容。
