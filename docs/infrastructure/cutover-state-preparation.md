# 完整 state 移轉／回復：離線驗證與未來操作來源

本文件是 **2026-11-13 的離線準備**，不是 Production GO、部署收據或已完成資料搬遷。使用者已批准完整資料計畫的準備；真正停服、傳輸正式 state、切換、啟動 publisher、變更 provider／Vercel 或回復仍須該次明確授權。本次只實作本機唯讀比較、測試和文件；不讀正式 state、profile、環境檔或金鑰，不連 provider，不停止 Azure。

## 1. 以程式碼為準的來源

基線 `ca657a47809e1b78aa278a13d71600ce5fd8614a`；重新操作時須核對 reviewed commit 及雙方**實際安裝**的 code／overlay，不能把本機 HEAD 當作 VM 版本。

| 原始碼／程序 | 本計畫採用的契約 |
| --- | --- |
| [`discover-worker-state.mjs`](../../scripts/infrastructure/discover-worker-state.mjs), `discoverWorker` | 從執行中的指定 systemd service 探知 User、cwd、三檔**實際路徑**；security 必須是 jobs path 加 `.security.json`。自訂檔名不能套用預設值。此 discovery 不是本比較工具的動作。 |
| [`worker-state-backup.mjs`](../../scripts/infrastructure/worker-state-backup.mjs), `createStateBackup`／`verifyStateBackup`／`restoreStateBackup` | 三檔 allowlist、每檔上限 8 MiB、transfers1/jobs4/security1、terminal jobs、manifest 的 byte length／SHA-256、GCM 認證、全新還原目錄與 0700/0600；缺 quota/security 絕不補零。 |
| [`store.mjs`](../../src/store.mjs), `JsonTransferStore`; [`transfer.mjs`](../../src/transfer.mjs) | source → Global mapping；成功 publish 後先保存 `globalId`、`sourceHash`、`verificationPending=true`，稍後才完成公開驗證。pending ID 不可丟失、不可用新 create 取代。人工 adopt 的 sourceHash/shareCode 可為 null。 |
| [`worker.mjs`](../../src/worker.mjs), `JsonWorkerJobStore`／`TransferJobQueue` | jobs v4、完整設定、`quota.events[{at,clientKey}]`、`blockedUntil`。正常 store reads 會正規化／裁剪資料；queue start 會重新排入 queued/running。不可拿這些 API 做唯讀移轉證據。 |
| [`security-state.mjs`](../../src/security-state.mjs), [`request-budget.mjs`](../../src/request-budget.mjs) | requests 的 roles/submit/poll buckets、count/resetAt/client counters，以及 session ID → expiry 表。撤銷是從權威 session 表刪除 ID，**並無另一份可丟棄的 revocation 清單**；還原舊 session 表可能復活撤銷。檢查 session 也可能清除過期項，驗證不得呼叫它。 |
| [`azure-to-gcp-cutover.md`](azure-to-gcp-cutover.md), [`azure-worker-backup.md`](azure-worker-backup.md) | 單一 publisher、最後靜止備份、私鑰留 VM 外、不可搬 Chrome identity、GCP 寫入後 rollback 必須反向搬最新三檔；daily coordinator 會重啟 Azure，不可當 final cutover snapshot。 |

本工具不改上述契約、不實作新的備份／解密／安裝器、不取代既有 security、CI、release 或 runtime gates。私有 Vercel 和成本檢查由主線另行處理。

## 2. 離線工具：兩個本機目錄，沒有其他動作

```sh
node scripts/infrastructure/cutover-state-audit.mjs \
  /absolute/private/source-reference /absolute/private/candidate
```

兩個目錄皆只按固定名稱讀取 `transfers.json`、`jobs.json`、`jobs.json.security.json`。原來自訂路徑由既有 archive manifest／還原流程對應到這三個固定還原名稱，不可找錯 production 路徑後以空白檔代替。可保留既有 `restore-receipt.json`，但工具**不讀也不信任**它；不掃描或開啟其他檔案。`transfers.json.lock` 只檢查是否存在，不讀內容，存在即拒絕。

### 檔案保護與漂移

- 檔案輸入模式只接受可驗證 uid/mode 的 POSIX 本機檔案系統。使用與輸入 owner 相同的有效使用者；目錄精確 0700、regular files 精確 0600、每檔只有一個 hard link。即使以 root 執行，也不接受另一位 owner 的檔案。
- 絕對、canonical、互異的目錄；不允許 `..`、symlink、symlink ancestor、hardlink／同 inode 的跨輸入 alias、非 regular file、缺檔或超限檔案。父目錄須由 root／執行者擁有且不可 group/other-writable；root-owned sticky directory（如 `/tmp`）例外，但輸入 leaf 仍須 0700。
- 每檔以唯讀／no-follow／non-blocking 開啟，有界讀取；比較開啟前後 inode、uid、mode、size、mtime/ctime。完整兩輪讀取比 byte，再檢查所有檔案與目錄身分及 lock，檢出讀取期間的原地修改／atomic replacement／目錄置換。不修改 chmod/chown/mtime，不建立輸出目錄、不寫 receipt。
- 這是**有界漂移偵測，不是原子跨檔 snapshot 或 writer 排他鎖**。最後檢查之後的變更、同 uid/root 的惡意競爭、來源本身早已混合的三檔，無法由比較證明不存在。必須先有外部 quiescence 與受信任 custody。唯讀開啟仍可能由 OS 更新 atime；不是取證磁碟映像工具。JS parsed strings 不承諾安全抹除，須在隔離受保護主機操作。
- 原生 Windows NTFS mode bits 不證明 ACL，CLI 會 fail closed，沒有 bypass flag。請使用核准的、D 槽承載且支援真實 POSIX owner/mode 的 WSL ext4 或離線 Linux 受限目錄；不要把 `/mnt/d` 的 mode 表象當成私有權限驗證。不得為測試自動把正式資料搬入 WSL。本次測試只用 synthetic fixtures。

### schema 與輸出

嚴格檢查現行版本和必要結構、job key=id、source/Global ID、完整現行 policy 範圍、quota、request buckets 和 session ID/expiry。拒絕不合法 UTF-8、duplicate JSON keys（含 escaped aliases）、超過 64 層 nesting、超過 500,000 結構 tokens 的 JSON。不遷移 legacy state，不套預設值、不裁剪過期 history。unknown fields 全部納入比較，不能悄悄丟棄；這不代表已證明未來 schema 的 runtime 相容性。

輸出單行 JSON：固定分類、逐檔 byte length/SHA-256、版本、mapping/pending/job status/quota event/client/request/session **數量**，以及固定差異／阻擋代碼。完整比較所有 records 和巢狀內容，而非僅比較 IDs 或 counts；包括 unknown fields、nested result IDs、pending Global IDs、quota 事件順序與重複、`blockedUntil`、client hash 字串、全部 policy、request counters、session 成員及 expiry。即使 JSON 重排／whitespace 是唯一差異，byte mismatch 仍失敗。

不輸出原始 ID、share code、client hash、session ID、expiry/blockedUntil 數值、state 內容、檔案路徑或 parser／OS exception。雜湊與 counts 本身仍是操作 metadata，不應公開正式比較輸出。報告不含時間戳，對相同資料可重現。

| classification | exit | 意義 |
| --- | --- | --- |
| `LOCAL_STATE_MATCH_UNATTESTED` | 0 | 三檔 byte/schema/count 完全匹配，且沒有已知阻擋；**僅本機一致證據**。 |
| `LOCAL_STATE_DIFFERENCES` | 1 | schema 合法但 bytes 或 records/policy/quota/security 不同。不得當作可忽略差異自動放行。 |
| `LOCAL_STATE_BLOCKED` | 1 | 任一邊仍開 admission、queued/running/unknown jobs、pending publication，或 mappings 和 jobs 同時為零。差異仍列出，保留 reconciliation 線索。 |
| `LOCAL_INPUT_REJECTED` | 1 | 缺檔、損壞、unsafe path/owner/mode、unsupported schema/platform 或漂移；只輸出固定錯誤代碼，不留下部分 state 報告。 |

每一種結果都固定 `runtimeGo=false`、`authoritativeSourceVerified=false`。空 synthetic0 pair 不能取得 match；非空 synthetic pair 仍可能本機匹配，但不能證明它是 Production。無外部 VM/disk/service identity、原路徑、當次 final archive 身分及 custody 證據，**不能宣稱來源權威、正式 state 已備份、跨 VM 移轉成功或 runtime GO**。`compareStateFiles` 是供測試使用的純 Buffer 比較 API，也不提供檔案安全證據。

## 3. 必須保留的完整資料與證據

1. transfers：全部 source mappings、Global IDs、sourceHash、shareCode、時間與 unknown metadata。pending ID 原樣保留，但任何 pending 都須先以唯讀 upstream 核對／人工 reconciliation，不能重發 create，不能刪 flag 只為通過工具。
2. jobs：所有 job IDs/source IDs、終態、完整巢狀 result/error/history，不可只複製 dashboard 投影。不接受 queued/running/unknown/ambiguous，或把失敗／不確定發布改標 completed。已標 failed 仍可能有 upstream side effect，工具無法證明其沒有；由外部 reconciliation 核實。
3. quota：events 的每個 timestamp/clientKey、重複事件與 `blockedUntil` 原樣保存，不因 retention、換日、空 jobs 或新 VM 重建為零。
4. policy/security：全部設定、blacklist、request budgets/client counters、session 成員及 expiry；最新 authoritative session absence 必須保留。client hash 對應的 secret／算法 identity 另由授權管理者私下驗證保持穩定；工具不讀取、複製或驗證該 secret，也不建議靠 rotation 清除 quota。
5. 外部 custody packet（不進 Git）：source/destination project/account、immutable VM/disk IDs、service/User/uid/gid、cwd、原三檔 paths、實際 code/overlay hashes、Node、UTC capture/quiescence window、停止與無其他 writer 證據、原 admission policy、archive timestamp/ciphertext SHA/recipient fingerprint/三檔 manifest、SSH host-key／交付證據及離線比較結果。archive receipt/manifest 不含 immutable VM 身分；須另行綁定。簽核人必須能追溯 final archive，而不是只填 `verified=true`。

## 4. 未來獲准切換時的精確資料順序（現在不執行）

以下補足既有 cutover 第 4–9 步的 state 細節；不能單獨用本文件開啟服務。任何前置條件不明即保持阻擋，不以合成資料頂替。先取得該次 GO，包含 exact identities、reviewed source、維護時窗、私有傳輸與 key-custodian 位置及明確 rollback 計畫。

1. **停止之前 discovery**：在 Azure 真正 running service 下使用既有 `backup:inspect` 契約，保存 allowlisted paths、service User/uid/gid、cwd。單獨核對 GCP 已安裝但停止的目標服務設定及 paths；不要假設兩機相同。此工具本身不執行 discovery，不讀 `/proc/environ`。核對上節 custody packet。
2. **排除自動復原與並行 writer**：按當次 GO 暫停／停用會執行 coordinated backup 的 timer、確認既有 backup service 不在執行、journal 為 complete，依既有 runbook 取得同一 kernel flock 並在最後備份／交付期間維持排他。未完成 journal 先人工 reconciliation；不刪 journal／lock 掩蓋問題。凍結 admission/settings/session/roles 等管理寫入與所有手動 transfer/adopt 操作；單單關 admission 不是排他屏障。
3. **最後 quiescence**：保留原 admission policy，關閉公開提交；確認最後 dashboard admission=false、queued=running=0，逐一核對可能不確定的 upstream publish。pending mapping／ambiguous job 不可帶過 readiness gate。GCP synthetic 與正式 publisher 均保持停止。只有本次 GO 已允許時，人工停止 Azure worker **service**，核對 inactive/dead、MainPID=0、無其他 writer、無 transfer lock；再次確認 GCP 唯一寫入者也不在。這不是自動停止／deallocate Azure VM，不刪磁碟或 profile。
4. **final archive**：在保持上述靜止與 lock 的條件下，執行既有低階命令：

   ```sh
   node scripts/infrastructure/worker-state-backup.mjs snapshot /etc/hsr-backup/backup.json
   ```

   config 必須指向剛 discovery 的三檔和正確 loaded service，且是既有 root-owned0600 私有設定；依真實安裝位置使用 reviewed module。snapshot 自己不 stop/start service。**不要**執行 daily coordinator／`backup-and-retain.sh`，它們可能重啟 Azure。若需保存原 admission，透過既有 `HSR_BACKUP_ORIGINAL_SUBMISSIONS` 的受控 metadata 契約保存真實原值，不把它當作自動 reopen 指令。核對 snapshot 前後 quiescence，將 ciphertext＋receipt 綁定當次來源身分、時間與 manifest；保持 Azure service stopped。
5. **VM 外驗證／還原**：經核准的受保護管道只把 ciphertext＋receipt 交付既有 off-VM key custodian；核對完整 cipher hash/length/recipient。使用既有 `worker-state-backup.mjs verify <private-config>`／`verifyStateBackup` 做 GCM、manifest、三檔驗證，再由既有受控 caller 使用 `restoreStateBackup({encrypted,privateKey,receipt,directory,assertQuiescent})` 還原到**全新**0700目錄，保留成功 restore receipt。私鑰／密語永不傳入 VM、Git、Box 或聊天。

   這裡沒有新增解密 wrapper。CLI `restore <private-config>` 只有在 Linux 且設定的真實 loaded service 已 inactive/dead/MainPID=0 時可用；不能在 Windows 假稱它可直接執行。離線 custodian 的 library caller 必須真實驗證**本機**沒有 publisher/writer，不可用空 callback 假冒遠端 Azure/GCP 已停服。custodian workflow／權限未具備即阻擋，不為湊流程複製 recovery key 到 VM。
6. **先核對外部 reference**：在 custodian 以受控方式將驗證過的三檔原 byte 準備為唯讀 reference；source-reference 與 restore candidate 必須是獨立檔案組、不能 hardlink。按工具 owner 要求授予同一核准本機 audit uid 的0700/0600私有存取；不要改寫 JSON。執行第 2 節比較，確認 manifest 的三檔 hash/length 與 source-reference 相同，還原 candidate 也 exact match。無外部 provenance，match 仍不足。
7. **交付並安裝全新目標組**：GCP publisher 持續停止且持有維護排他；透過驗證 SSH host key 的核准管道傳輸**固定三檔**，不傳 .env、browser profile/cookies/device identity 或 recovery key。目標舊 synthetic state 保留在非啟動目錄，不可讓 synthetic0 覆蓋正式來源。建立全新 versioned 目錄；以下只是已授權操作人員未來的 Linux 安裝片段，`STAGE` 是已核對的三檔交付目錄，`NEW` 尚不存在，User/Group 來自目標 discovery，沒有任何預設 owner：

   ```sh
   umask 077
   # 在排他維護期間以具權限的操作身分，先核實以下變數均為核准值。
   : "${STAGE:?}" "${NEW:?}" "${SERVICE_USER:?}" "${SERVICE_GROUP:?}"
   mkdir -m 0700 -- "$NEW" || exit 1  # exclusive，既有目錄即停止
   for f in transfers.json jobs.json jobs.json.security.json; do
     install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_GROUP" -- "$STAGE/$f" "$NEW/$f" || exit 1
   done
   chown -- "$SERVICE_USER:$SERVICE_GROUP" "$NEW" || exit 1
   stat -c '%a %u %g' -- "$NEW" "$NEW/transfers.json" "$NEW/jobs.json" "$NEW/jobs.json.security.json"
   ```

   所有 path／parents 須預先 canonical/no-symlink、非不受信任可寫目錄；這不是通用安全 copy 工具。片段失敗可能留下不完整新目錄，**不得啟動**；保留待查並選另一個新目錄，不能就地補缺檔後當作成功。以正確 service uid 比對 `NEW` 與獨立、同 owner 的核准 reference，並核對 archive manifest 逐檔 hashes/counts。比較 script 本身不 copy、chmod、chown 或安裝任何檔案。
8. **啟動前最後核對**：完整三檔均正確 owner/0600，dir0700，job terminal、無 pending/ambiguous、admission=false；Azure service 仍 inactive/dead/MainPID=0。由授權操作人員將目標服務三個實際路徑以同一維護窗口指向已驗證組；若採既有固定檔名，必須在服務持續停止時完成整組人工安裝與再比較，不能讓 worker 看見部分新／部分舊狀態。工具不執行 restore overwrite／path switch。新組未驗證前不開 publisher。
9. **另外的 runtime GO**：通過 state 比較仍須既有 runbook 的 identity、fresh login、read-only API、單一 publisher、Vercel 實際環境、授權 live acceptance 等 gates。啟動或更新 URL/token 由當次授權流程單獨執行，不是本工具動作。先保持 admission=false，全部 runtime smoke 成功才按保存原 policy 決定是否重開。**不自動停止 Azure VM／刪 profile／decommission。**

## 5. GCP 有任何寫入後 rollback：最新 return state 為必要條件

即使尚未公開提交，GCP worker 起動、session check、request budget 或 admin mutation 都可能改 state。不能假設「沒有策略 create」就沒有新 quota/security/session 狀態。

1. 在 GCP 關 admission、凍結所有管理與手動寫入、排空並人工 reconciliation ambiguous jobs／pending IDs；停止 GCP publisher，確認單一 writer 已消失。Azure 仍 stopped；先核實 Azure credits／原 session／服務可恢復，不能承諾一定可回去。
2. 在 GCP 以同樣 final-quiescence／低階 snapshot 程序產生**最新完整三檔 encrypted return archive**，交付 VM 外驗證／還原。不得用當初 Azure outbound archive 代替；兩邊一旦都有新寫入則 split-brain，停止並人工 reconciliation，沒有自動 merge。
3. 新 GCP return reference 與其還原／交付到 Azure 的全新 candidate 才是**必須 exact match 的 pair**。原 Azure outbound 與 return 的差異可能是合理進展；只供人工檢查新增 mappings/results、quota 和 revocation，不要求兩個時點無差異，也不能以較舊 count/hash 回滾。時間戳或「count 較多」本身不確立權威。
4. 使用同一 0700/0600、**Azure 實際 service owner**、全組人工安裝與再比較程序，保存 Azure 原 profile，禁止從 GCP 匯出 cookies。未取得、驗證並安裝最新 return state，**不得啟動 Azure 舊 queue**。即使 GCP 已無法連線也不豁免；保持 NO-GO，改走另行核准的災難復原與 upstream reconciliation。
5. 只有 GCP stopped、最新三檔核對與額外 runtime gates 成功，才按當次 rollback 授權啟動唯一 Azure publisher、更新主線管理的 Vercel paired settings、smoke，最後決定是否重新開 admission。保留雙方 archive、state、磁碟與證據，不自動刪 GCP 或停用 Azure。

## 6. 可重現測試（不使用正式資料）

```sh
node --test test/cutover-state-audit.test.mjs
```

測試覆蓋三檔精確匹配、同 counts 下 mapping／nested ID 損壞、pending ID、active/ambiguous queue、quota 的 blockedUntil/events/clientKey、多重事件、policy/request budgets、session 撤銷 absence、schema／duplicate keys／UTF-8／nesting／大小、unsafe paths/owner/modes/links/locks、原地／rename／目錄 race、read-only 行為和 CLI sanitisation／exit code。只用受控 synthetic fixtures；不是 broad synthetic restore drill、正式 archive 演練、雲端 rehearsal 或 runtime acceptance。

本機 Windows 可執行純比較與 CLI fail-closed 測試；POSIX 檔案測試在 Windows 明確 skip，必須另於 D-backed WSL ext4／核准 Linux 完整跑過才能報告檔案安全驗證。獨立 checkout 驗證須 fresh exact commit、clean dependency installation，記錄 SHA、OS、Node/npm、命令、exit codes、pass/fail/skip counts；Box 不可用時明記 local fallback，不宣稱遠端驗證。
