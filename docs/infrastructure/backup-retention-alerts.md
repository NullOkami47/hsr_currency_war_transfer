# 加密備份保留與警報評估

此功能以 `f834d232aa4d4b469b728483f6a982c891e67d17` 的既有格式為基礎，只新增保留模組、watchdog、測試與此文件。沒有啟用雲端刪除、遠端監控或 email。主流程另行整合 GCS、Azure WIF 與已獲授權的通知管道。

## 設計與實作順序

1. 先以合成物件測試七日保留、36 小時新鮮配對、外部還原基準、generation／ETag 競態和操作上限；再實作完整預檢及條件刪除。
2. 先測試各目的地、每日香港時間 03:00 排程、26 小時過期、journal、狀態與 spool；再實作純函式警報評估。
3. 檢查五檔範圍、跑既有及新增測試、提交後於乾淨的精確 commit checkout 驗證。Simular Box 工具不可用，使用 D 槽本機合成資料，記錄環境與結果。

## 安全邊界

僅接受 `hsr-state/hsr-state-YYYY-MM-DDTHH-mm-ss-sssZ.enc.json` 與同 stem 的 `.receipt.json`。receipt 的五個欄位為 `format, createdAt, sha256, bytes, recipient`；format 必須為 `hsr-worker-backup/v1`，檔名、UTC 時間、實際 byte 長度與 SHA-256 必須一致。密文 envelope 限定 `format, encryptedKey, iv, tag, ciphertext`，檢查 canonical base64、RSA 包裝金鑰長度、12-byte IV、16-byte tag 及非空密文。不得讀取或刪除金鑰、其他 prefix 或子路徑。

這些檢查僅證明 transport hash／envelope 格式，無法證明 GCM 認證、解密或可還原。雲端不需要也不得部署解密私鑰。外部釘選基準必須由受保護設定提供，來源是既有的外部 GCM 解密、manifest 與實際還原驗證。不可由新上傳的 receipt、日常成功狀態或雲端可寫標記自動取代。

## 保留模組介面

```js
import { planBackupRetention, executeBackupRetention } from './backup-retention.mjs';

const options = {
  storage, // 每次只處理一個目的地，由主流程分別傳入 GCS / Azure adapter。
  pinnedBaseline: {
    format: 'hsr-worker-backup/v1',
    archiveName: 'hsr-state/hsr-state-2026-10-01T19-00-00-000Z.enc.json',
    createdAt: '2026-10-01T19:00:00.000Z',
    bytes: verifiedReceipt.bytes,
    sha256: verifiedReceipt.sha256,
    recipient: verifiedReceipt.recipient,
    verification: 'external-gcm-restore/v1',
    restoreVerifiedAt: externalVerification.completedAt,
  },
  now: () => new Date(),
};
const plan = await planBackupRetention(options);
const dryRun = await executeBackupRetention(options);
// 只有已由主流程授權保留刪除時，才傳 literal boolean true：
const applied = await executeBackupRetention({ ...options, apply: true });
```

上例日期僅為合成示例，部署時必須填入**現存初始外部驗證備份的真實識別資料**。模組不探測私鑰或自動建立信任；缺少基準、基準物件消失、hash／recipient／時間不符均阻止全部刪除。相同目的地的 recipient 必須與基準一致；金鑰輪替需要另行審查基準及遷移政策。

本次主流程指定的正式基準識別資料如下；這些是身分釘選，不能單獨代替外部還原證據。整合時另從既有受保護 receipt／外部驗證紀錄取得真實 name、createdAt、bytes 與 restoreVerifiedAt，禁止使用上例日期或猜測值。

| 欄位 | 釘選值 |
| --- | --- |
| sha256 | `ba6f02b0cc6c289352bdb215b47b09aa2cc0698af286a2a5674fdab868a4c803` |
| recipient | `1b7198fa8f2009311bff67b8df7376f08809d07dc4ffb456076baf67467a56d8` |

GCS 整合需保留 bucket 七日 minimum retention 與 soft delete，初始正式 canonical pair 的 temporaryHold 永不由此模組移除。MI uploader 使用 objectCreator＋Viewer，不提供刪除；遠端 monitor 的自訂角色限 get/list/delete，不提供 update。此介面沒有 update／hold 變更操作。Azure 由主流程以現有 VM BlobContributor 角色實作條件 adapter。以上是整合要求，本變更沒有建立或修改這些雲端設定。

`storage` 僅提供下列非同步方法，不帶供應商 client、憑證或 URL。所有方法必須遵守 `signal`、上限及條件，失敗時 throw，不能把 404／412 或 timeout 當成成功：

```js
list({ prefix, limit, signal })
// => { complete: true, objects: [{ name, bytes, version }] }
get({ name, version, maxBytes, signal })
// => { body: Buffer, version }
delete({ name, version, signal })
// => { deleted: true }，僅在供應商確認成功之後回傳。
```

`version` 僅能是 `{ generation: '123456789' }` 或 `{ etag: '"0x8ABCDEF"' }`，不得同時存在、缺漏或使用 wildcard。generation 是 canonical 正整數字串，不經 JavaScript Number 轉換。ETag 保留原有雙引號。adapter 的 list/get 版本必須識別同一個物件；不得使用快取冒充已驗證的條件 GET。

| 儲存 | adapter 必須實作的條件 |
| --- | --- |
| GCS | GET 與 DELETE 帶 `ifGenerationMatch`，值為 list 捕捉的 generation；條件不符停止。 |
| Azure Blob | GET 與 DELETE 帶 `If-Match`，值為 list 捕捉的原始 ETag；條件不符停止。 |

list 僅列目前物件，不列歷史版本或 soft-deleted 物件。不設定刪除所有版本、snapshots 或 prefix 遞迴刪除選項。若單頁不足，adapter 可在**同一個有界 list 呼叫內**收集至 limit；無法證明完整性時回傳 `complete:false`，不可截斷後謊稱完整。模組不會無界翻頁。GET 必須在配置 response body 前限制傳輸量；模組另外檢查回傳 byte 數、版本與累積預算。

預設及最大值：

| 限制 | 預設 | 可接受最大值 |
| --- | ---: | ---: |
| list 物件總數 `maxObjects` | 256 | 256 |
| 單一密文 `maxArchiveBytes` | 64 MiB | 64 MiB |
| 全程讀取 `maxTotalReadBytes` | 256 MiB | 512 MiB |
| list/get/delete 總呼叫 `maxOperations` | 1024 | 1024 |
| 單次配對刪除 `maxDeletePairs` | 8 | 32 |
| 全程 deadline `timeoutMs` | 120000 | 120000 |

receipt 固定最多 4096 bytes。可透過 `limits` 降低上限；非法值不執行任何儲存操作。超出物件量／讀取量／操作量／deadline 都停止；不會改成跳過驗證以騰出刪除預算。

完整預檢後，會先檢查整個選定 batch 的剩餘 read／operation 預算，包含重讀保護配對及目標；已知預算不足會在第一個 DELETE 之前停止，而非在同一配對的兩次刪除中間耗盡。可降低 maxDeletePairs 後重新產生計畫。deadline 或外部錯誤仍可能造成非原子的中斷。

完整預檢會驗證所有 scope 內配對，包括未選進本次 batch 的配對。任何孤立、損壞、未來時間或無法取得版本的備份均阻止全部刪除。其他 prefix、金鑰及巢狀路徑不讀取、不刪除。直接子路徑中看似備份但時間命名錯誤者視為異常。這是保守的停止政策，需由管理者調查，不自動清理孤立物件。

初次複製留下的 `hsr-state/.enc.json` 與 `hsr-state/.receipt.json` 不屬於 canonical 備份命名，刻意保留、不讀取且不刪除，也不影響有效配對的評估。canonical 名稱的孤立物件仍會停止保留作業。今天尚無滿七日的真實候選；條件刪除驗證使用合成操作。主流程若另測真實 wrong-generation precondition，必須確保條件必然不符且未發生刪除，不能把 bucket retention 拒絕提前刪除當成執行器成功刪除。

只選擇 `createdAt < now - 7 days` 的有效配對；恰好七日仍保留。基準與最新有效配對永遠受保護，且必須有 `0 <= age <= 36 hours` 的有效配對才可刪除。每次 DELETE 前重新條件讀取基準及最新配對、驗證目標 hash，並重查時鐘及新鮮度。時鐘倒退、未來 receipt 或格式無效即停止。執行器自行建立最新內部計畫，不接受呼叫者編造或修改的候選計畫。

`status` 為 `ready`（dry-run）、`applied`、`blocked` 或 `partial`；回傳 `protected`、有界 `candidates`、`remainingCandidates`、已確認 `deleted` 及 `unconfirmedDeletes`。所有失敗原因均為固定代碼，不回傳 SDK 錯誤、body、憑證或私鑰。`validation:'transport-only'` 與 `restoreVerified:false` 永遠不會被日常檢查提升為還原證明。

兩物件及多物件間沒有交易原子性。依序刪密文、再刪 receipt；第一步成功後第二步出錯會回報 partial，保留現場並停止。timeout／斷線可能發生於伺服器完成刪除之後，因此有 `unconfirmedDeletes` 時不能宣稱零刪除，必須重新觀測並人工 reconcile，不可直接重試舊計畫。adapter 必須真實實作條件刪除，模組無法補救忽略條件的 adapter。

主流程應序列化同一目的地的 upload／prune，限制其他 writer 的覆寫及刪除權限。條件 GET 與 DELETE 不能跨物件鎖定基準；外部管理者在最終檢查後強制刪除保護配對屬於介面無法排除的競態。此模組沒有建立分散式鎖，也不宣稱雲端整合已驗證。

## Watchdog 介面

```js
import { evaluateBackupWatchdog } from './backup-watchdog.mjs';
const evaluation = evaluateBackupWatchdog({
  now: new Date(),
  snapshot: { createdAt, sha256 }, // 最後一次本機加密 snapshot，不能用 attempt 代替。
  status, // 現有 backup-control-state.mjs 的 v1 status 結構。
  destinations: {
    gcs: { latest, successMarker, status: gcsStatus },
    azure: { latest: azureLatest, successMarker: azureMarker, status: azureStatus },
  },
  journal, // 現有 v1 journal；missing 也是 unknown，不默認 complete。
  spool: { bytes, capacityBytes, files, capacityFiles, observedAt },
});
```

`latest = {createdAt, sha256, transportVerified:true}` 必須來自該目的地已驗證的配對；`successMarker = {createdAt, sha256, completedAt, transportVerified:true}` 必須在雙物件 read-back hash 驗證完成後持久化。marker 要與 latest 的時間／SHA 及該目的地 status.lastSuccessAt 完全對應。上傳成功、list 看見新時間、另一個目的地成功，均不能代替此證據。collector 不可從同一個未經驗證的 marker 自行推導所有觀測值。

每個 status 的欄位為 `version:1, result, lastAttemptAt, lastSuccessAt, lastFailureAt, stage, workerHealth, transportVerified, restoreVerified:false`。lastSuccessAt／lastFailureAt 可明確為 null，不能缺漏。result 限 `running/success/failure`，stage 限 `coordinator/delivery/complete`，workerHealth 限 `unknown/confirmed`。成功需要 `stage:complete, workerHealth:confirmed, transportVerified:true`，時間順序必須合理。失敗與執行中狀態即使仍有新鮮的舊備份也會產生警報。執行中超過兩小時視為 interrupted。

排程固定香港時間每天 03:00，即 UTC 19:00；回傳最近及下一次排程時間，不依賴執行電腦時區。snapshot、各目的地最新配對、最近 attempt 與 success 超過 **26 小時（嚴格大於）**即報 overdue／schedule_missed。這是每日排程加約兩小時容許窗的 freshness 評估；不執行 timer、補跑或歷史排程稽核。缺少紀錄會直接報 unknown／missing，不等待 26 小時。

journal 的任一非 complete 已知階段報 critical interrupted；格式不明或未來時間報 unknown。complete journal 必須不早於目前 attempt／snapshot、不晚於成功狀態的 lastSuccessAt，且 26 小時內更新；舊 complete 紀錄不能證明最新嘗試已恢復。spool 的 bytes 與 files 各自評估；任一達 90% 為 warning，達／超過 100% 為 critical。容量必須為正整數，使用量為非負整數，spool.observedAt 過期也不能報 healthy。

回傳 `{version:1,state,evaluatedAt,schedule,restoreVerified:false,alerts}`。`state` 為 healthy／alert／unknown；alerts 僅包含固定 `code`、`severity`，以及選擇性的固定 `destination:gcs|azure`，不含輸入的錯誤、檔案路徑、帳號、金鑰或任意 destination 名稱。critical 優先為 alert；否則有 unknown 就為 unknown。有任何警報均不可當成健康。通知主流程可用 code＋destination 去重，但不能隱藏 unknown 或把寄送成功當成備份成功。

本模組沒有 email 寄件設定、通知憑證、常駐監控、雲端變更、排程安裝或自動修復。後續獨立遠端監控應收集以上觀測；email 寄送由主流程使用獲授權管道整合。正式啟用 apply、部署 adapter 或改變雲端 IAM／lifecycle 屬於另一次整合。

主流程的 Cloud Run wrapper 由獨立 agent 整合，預計每小時 `POST /check`，獨立於 VM 存活狀態。wrapper 缺少 VM 本機 journal／spool 或 Azure 證據時，必須以 null／unknown 顯示，不得用 GCS 最新 receipt 合成缺少的成功證據。HTTP／Monitoring heartbeat 送出成功與備份評估 healthy 是不同結果。

## 驗證方式

```powershell
node --test test/backup-retention.test.mjs test/backup-watchdog.test.mjs
npm.cmd ci
npm.cmd test
git diff --check
```

測試僅使用合成儲存與合成金鑰。涵蓋條件版本競態、兩物件中斷、未確認 DELETE、deadline、clock rollback、36h／7d／26h 邊界、實際既有 RSA-OAEP＋AES-GCM 格式及各目的地獨立失敗。測試的 GCM 驗證使用臨時合成私鑰，沒有讀取實際恢復金鑰。
