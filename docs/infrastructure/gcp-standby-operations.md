# GCP staging 啟動、唯讀登入與恢復程序

本工具從 `8e3b39c8914c22bc831ad55be58b8aaacb5c190d` 延伸。這次交付僅修改工具、文件與針對性測試，沒有執行雲端變更、登入、state 搬移或 live publishing。既有 synthetic 驗收不重跑。先前文件的 VM 狀態是歷史收據；本次未重新讀取控制平面，不能聲稱已即時確認電源狀態。

## 核准範圍與固定目標

只操作既有 `hsr-currency-war-worker / us-central1-a / hsr-worker-standby`，且須固定真正 account、VM immutable ID、boot disk immutable ID。磁碟名稱為 `hsr-worker-standby`。這些 ID 必須來自既有受信任收據與唯讀 readback；不能將替換資源自動當成原目標。

- `e2-micro`，labels `purpose=hsr-worker-standby,mode=synthetic`，無 VM service account。
- 單顆既有 boot disk，實際 disk describe 為 READY、`pd-standard`、20–30 GB，`autoDelete=false`。
- 300–3600 秒；啟動前設定並重新讀回 provider `maxRunDuration`、`instanceTerminationAction=STOP`、`automaticRestart=false`。已 RUNNING 的實驗不得重設期限。
- 預設拒絕 external IPv4。臨時 IPv4 同時需要獨立旗標及 private config 內明確、未過期、接受非零費用的核准；有效時間須涵蓋整次最長 runtime，且距現在不得超過 24 小時。
- IPv4 只接受單一既有 direct ONE_TO_ONE_NAT；RUNNING readback 的位址不得出現在本專案 reserved addresses。工具不附加 IP、不建 NAT、不保留 static IP、不開 firewall。
- 不 create/delete VM、disk、network 或 DNS；不改 Azure、Vercel Production、正式 publisher、帳號或 billing。Budget 是警示；shared Free Tier、credit 抵扣與延遲帳單仍需管理者查核，不能保證零費用。
- 後續修正：啟動 gate 改為 **PREPARED**：最近 24 小時主控已確認精確 Vercel Preview project/deployment 已部署，且 ephemeral IPv4 → hostname → Caddy/私有 token → Preview origin 更新方案已審核。**不要求 start 前已有 live HTTPS**；每次啟動可能換 IP，舊 HTTPS 收據不證明新 origin。此修正取代原本循環相依的 httpsReady/vercelReady gate，不填假的 true/false。主控仍須明確授權 staging；工具不登入 Vercel、不驗證帳號或偽造部署證據。

## 私有設定與命令

將設定放在受限的 D 槽目錄，排除 Git、Box 與一般日誌。以下刻意不能直接啟動；由主控人工填入真實證據，勿為了通過 gate 把 unknown 改成 true。

```json
{
  "account": "REPLACE_WITH_APPROVED_ACCOUNT",
  "project": "hsr-currency-war-worker",
  "zone": "us-central1-a",
  "instance": "hsr-worker-standby",
  "maxRunSeconds": 3600,
  "approvedTarget": {
    "account": "REPLACE_WITH_SAME_APPROVED_ACCOUNT",
    "project": "hsr-currency-war-worker",
    "zone": "us-central1-a",
    "instance": "hsr-worker-standby",
    "instanceId": "REPLACE_WITH_EXISTING_NUMERIC_ID",
    "diskId": "REPLACE_WITH_EXISTING_NUMERIC_ID"
  },
  "costEvidence": { "verifiedAt": null, "freeTierAvailable": false, "budgetsVerified": false },
  "temporaryIpv4Approval": { "approved": false, "nonZeroCostAccepted": false, "expiresAt": null },
  "approvedVercelProjectId": "REPLACE_WITH_VERIFIED_PROJECT_ID",
  "approvedPreviewDeploymentUrl": "https://REPLACE_WITH_APPROVED_DEPLOYMENT.vercel.app",
  "stagingReadiness": {
    "phase": "PREPARED", "verifiedAt": null,
    "previewDeployed": false, "bootstrapConfigReviewed": false,
    "vercelEnvironment": "preview",
    "vercelProjectId": "REPLACE_WITH_SAME_VERIFIED_PROJECT_ID",
    "previewDeploymentUrl": "https://REPLACE_WITH_SAME_APPROVED_DEPLOYMENT.vercel.app"
  },
  "bootstrap": {
    "hostnameTemplate": "gcp-staging.{ipv4}.sslip.io",
    "tokenFile": "D:/<private>/synthetic-token.txt",
    "outputDirectory": "D:/<private>/bootstrap-UNIQUE-WINDOW"
  }
}
```

Linux 使用官方 `gcloud`。Windows generic SDK 可填 `gcloudPath` 為 bundled Python executable，`gcloudScriptPath` 為同一 SDK 的 `lib/gcloud.py` 絕對路徑。工具以 execFile argument array 執行，不經 shell 展開，不改全域 gcloud account。compute 命令固定 account/project/zone；addresses list 不帶 zone，涵蓋本專案 reserved addresses。auth list 僅檢查指定帳號已登入，不能取代 main 的身分審核。

以下為日後明確啟動 staging 時的操作序列；本次沒有執行：

```powershell
$cfg = 'D:/<private>/standby.json'
node scripts/infrastructure/gcp-standby.mjs preflight $cfg --authorise-temporary-ipv4
if ($LASTEXITCODE -ne 0) { throw 'Preflight failed' }
try {
  node scripts/infrastructure/gcp-standby.mjs start $cfg --authorise-staging --authorise-temporary-ipv4
  if ($LASTEXITCODE -ne 0) { throw 'Staging start failed' }
  node scripts/infrastructure/gcp-standby.mjs bootstrap-files $cfg --authorise-staging --authorise-temporary-ipv4
  if ($LASTEXITCODE -ne 0) { throw 'Bootstrap file preparation failed' }
  # 主控依下節操作：known-host SSH 傳私有檔 → 設定 Caddy/worker env。
  # 再把新 healthUrl 同時寫入私有 config 的 healthUrl、approvedHealthUrl，
  # 更新 exact Preview 專案的 origin 並部署生效；不能先跑 verify 或沿用舊 IP。
  # 此處必須完成下節所有步驟；本範例沒有自動 SSH、更新 Preview 或部署。
  node scripts/infrastructure/gcp-standby.mjs verify $cfg --authorise-temporary-ipv4
  if ($LASTEXITCODE -ne 0) { throw 'Staging health failed' }
} finally {
  node scripts/infrastructure/gcp-standby.mjs stop $cfg --authorise-staging
  if ($LASTEXITCODE -ne 0) { throw 'STOP not confirmed: inspect the pinned VM immediately' }
}
```

`preflight` 只有 provider reads；`start` 是明確授權的 scheduling/start；`stop` 只停止 pinned VM，已 TERMINATED 時不再送 stop。停止不受過期 IPv4/費用 gate 阻擋；labels drift 亦不能阻止停止同一 immutable VM。ID 不符則拒絕操作替換資源。

若 start 失敗或 RUNNING/磁碟/網路/STOP readback 不符，只對同一 immutable VM 做一次有界 stop/readback；未確認就失敗，不稱 cleanup 成功。若 start 前 scheduling/readback 失敗，沒有 start。主控須獨佔此 staging 控制時段；不與另一位管理者同時操作。

`start` 僅回傳 BOOTSTRAP_REQUIRED，httpsVerified/previewOriginVerified=false；PREPARED 是啟動資格，不是健康狀態。`verify` 在設定完成後才執行，限定精確核准的 HTTPS `/health`，且 hostname 必須對應本次 VM readback IP；拒絕 credentials/query/redirect，要求 mode=hsr-synthetic-worker。它不證明 authenticated jobs、Vercel Function、production state 或 live publishing。沒有 hostname/TLS 時保留 PENDING，不自動配置。

完成後停止 synthetic/圖形服務與所有 profile owner，scoped stop 並讀回 TERMINATED、保留 disk。VM 閒置時必須停止。provider STOP 不能取代 finally cleanup，也不代表 disk 免費。不自動 destroy/decommission 或在失敗後重啟 production。

## Ephemeral IPv4 bootstrap 的可重現順序

1. **PREPARED**：主控確認 exact Preview project ID、已部署的 deployment URL、登入/權限、既有 staging firewall/80/443、Caddy 與 synthetic unit 已安裝，以及獨立 synthetic token 可用。這些 prerequisite 不代表 worker origin 已連通。VM 未啟動時不要求讀回新的 IPv4 或有效憑證；缺少既有 ingress/unit 時停止，不自動建立資源。
2. **Start → discover IP**：在明確核准的時窗執行 start；固定 VM/disk/account/labels、STOP≤3600 與費用 gates 不變。已 RUNNING 的 VM 不可再次 start 或重設期限。後續 bootstrap-files 重新讀取相同 VM/磁碟與 reserved-address 狀態，僅接受目前 RUNNING 的 ephemeral IPv4。
3. **Prepare private files**：bootstrap-files 讀取私有 tokenFile，僅接受獨立 synthetic 的 32–256 字元英數、底線、連字號 token，可有一個結尾換行；不生成或旋轉 production secret。token 必須是非 symlink、受限 regular file；POSIX mode 禁止 group/other 存取，Windows 由主控先確認 D 目錄 ACL。outputDirectory 必須尚不存在，parent 受限且不經 symlink。輸出 Caddyfile、caddy.env、synthetic.env 皆 0600、目錄 0700。stdout 僅回傳路徑、新 healthUrl 與未驗證狀態，**不回傳 token/env 內容**。
4. **Configure Caddy + token**：以後述 strict known-host SSH 安全傳輸三個檔案至同一 VM 的受限新目錄。主控先核對 VM immutable ID、current IP、production publisher inactive/MainPID=0，以及本時窗有權修改的 staging Caddy。先停止 synthetic，保存原 Caddyfile、staging env/drop-in 與檔案權限至私有 recovery 目錄。不得對 Azure 或 production Caddy 套用。可將下列 shell 區塊存成受限的 setup script，以私有目錄作唯一參數，人工核准後執行；本次未執行。

```sh
#!/bin/sh
set -eu
umask 077
# 執行前已核對同一 VM、時窗、備份與 production inactive；不要 set -x。
bundle=$1
test "$(id -u)" -eq 0
test -f "$bundle/Caddyfile" && test -f "$bundle/caddy.env" && test -f "$bundle/synthetic.env"
systemctl stop hsr-worker-synthetic.service
test "$(systemctl show hsr-worker-synthetic.service --property=ActiveState --value)" = inactive
test "$(systemctl show hsr-worker-synthetic.service --property=MainPID --value)" = 0
# 驗證新檔後才安裝；只傳 hostname env，不傳 token 至 caddy argv 或 log。
set -a
. "$bundle/caddy.env"
set +a
caddy validate --config "$bundle/Caddyfile" --adapter caddyfile >/dev/null 2>&1
install -m 0600 "$bundle/synthetic.env" /etc/hsr-worker-synthetic.env
install -m 0600 "$bundle/caddy.env" /etc/hsr-worker-staging-caddy.env
install -m 0644 "$bundle/Caddyfile" /etc/caddy/Caddyfile
install -d -m 0755 /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/hsr-worker-staging-caddy.env\n' \
  > /etc/systemd/system/caddy.service.d/hsr-staging.conf
systemctl daemon-reload
# 正常 Caddy service 讀取新的 hostname EnvironmentFile；不使用 --environ。
systemctl restart caddy
# 已安裝 synthetic unit 從 /etc/hsr-worker-synthetic.env 讀 token；不啟動 publisher。
systemctl start hsr-worker-synthetic.service
```

   Caddyfile 只代理 `127.0.0.1:8788`，hostname 使用本次 IP 的 `gcp-staging.<ipv4>.sslip.io`，不改 DNS、不保留 static IP、不建立 firewall/NAT/LB。這段修改 VM 服務只供主控在核准時窗執行；檔案準備指令本身沒有 SSH/服務重啟/雲端 mutation。任一步失敗就走外層 finally stop，保留備份，不能回到 production 啟動路徑。
5. **Update Preview origin**：把產生的新 healthUrl 複製到私有 config 的 healthUrl/approvedHealthUrl；主控在核准的 exact Preview project/environment 更新 CURRENCY_WAR_WORKER_URL 為新 HTTPS origin（依既有整合 `/jobs` 路徑契約），CURRENCY_WAR_WORKER_TOKEN 配對相同 synthetic token。使用受限 secret file/stdin 或官方 secret UI，不把 token 放 CLI argv、URL、`echo`、CI logs 或本工具 stdout。重新部署 Preview 讓環境變更生效，核對實際 deployment/project，更新私有 PREPARED deployment binding；**不改 Production**。不能用前一個 Preview deployment 的成功取代新 origin 證據。
6. **Verify → bounded tests → finally stop**：先 verify 新 HTTPS，再從實際 Preview 驗證 health、unauthorised rejection、synthetic create/poll；禁止 live publishing、不重跑廣泛 synthetic 驗收。主控回報工作可需約 15.5 秒，9 秒總觀察窗不足；採 4 秒 poll cadence 並保留獨立的有界總期限（例如 120 秒，且小於本次 VM 剩餘 runtime），不能把 cadence 當 deadline 或無限重送 create。這項回報不是本工具自行完成的 live 證據。所有退出路徑停止本次服務/owner，外層 finally scoped stop VM；不延長目前已 RUNNING 的核准時窗。

## SSH known-host、IAP 與登入畫面

登入只在既有 GCP VM 進行，由主控人工操作官方認證頁與 MFA。不得搬 Azure/本機 profile、cookies、device ID、session 或正式環境檔。不呼叫 `vm:login`：既有腳本 stop/rollback 會重啟 worker，不符合此範圍。

1. 確認 VM ID、OS Login 使用者及有時限 SSH key。沒有有效 key 就停止；工具不建立或上傳 key。從受信任 Google Console/serial console 取得該 VM 的 ED25519 host key 與 SHA256 fingerprint，不能只信 ssh-keyscan 或首次連線提示。
2. 在受限 D 目錄建立專用 known_hosts，僅一行：`gcp-<immutable-instance-ID> ssh-ed25519 <public-host-key-base64>`，獨立記錄核准 fingerprint。不得使用 accept-new、StrictHostKeyChecking=no 或自動覆寫舊 key。
3. private config 加入下列 ssh 區段。`ssh-plan` 先核對檔案、alias、key 格式與 fingerprint 才產生 argument array；不連線、不呼叫 provider。

```json
{
  "ssh": {
    "host": "127.0.0.1",
    "port": 22022,
    "localViewerPort": 61080,
    "user": "REPLACE_WITH_VERIFIED_OS_LOGIN_USER",
    "identityFile": "D:/<private>/id_ed25519",
    "knownHostsPath": "D:/<private>/known_hosts",
    "hostKeyAlias": "gcp-REPLACE_WITH_EXISTING_NUMERIC_ID",
    "expectedFingerprint": "SHA256:REPLACE_WITH_INDEPENDENTLY_VERIFIED_FINGERPRINT"
  }
}
```

4. 另開有界 IAP TCP22 tunnel，只綁 `127.0.0.1:22022`。官方命令為 `gcloud compute start-iap-tunnel hsr-worker-standby 22 --local-host-port=127.0.0.1:22022 --zone=us-central1-a --project=hsr-currency-war-worker --account=<exact-approved-account>`；Windows 使用上述 bundled Python/SDK。不開公開 VNC/CDP/worker port、不新增 ingress/Caddy route/DNS。
5. 執行 `node scripts/infrastructure/gcp-login-readonly.mjs ssh-plan <private-config>`，審查計畫後，將解析出的 args array 交給 OpenSSH（PowerShell `& ssh @sshArgs`），不可拼接 shell command。計畫使用 `-F NUL`（Linux `/dev/null`）忽略 inherited SSH config，強制 strict host check、獨立 known_hosts、同 VM alias、指定 key、禁止 agent forwarding；只將本機 loopback viewer port 連至 VM `127.0.0.1:6080`。`-N` 只做 tunnel；shell/SCP 亦須沿用相同 pin/key/安全選項，再明確指定命令，不能移除 known-host 檢查。

OpenSSH 自己仍會解析 `-o UserKnownHostsFile`，因此 key/known_hosts 路徑拒絕空白、百分號、引號及變數展開字元，Windows 分隔符轉成 `/`。請選 D 槽不含這些字元的受限路徑，不能因使用 argument array 就省略此防護。

VM 需先有受控的 Xvfb/x11vnc/noVNC 與非 root hsr-worker 使用者；缺少時列為 prerequisite，勿改用 root Chrome 或 no-sandbox。主控在核准時段，以獨立有時限程序啟動 Xvfb `:99 -nolisten tcp`、x11vnc `-localhost -rfbport 5900 -rfbauth <private-0600-password-file>`、websockify `--web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900`。密碼用 VM 互動式 x11vnc -storepasswd 產生，不放命令列/URL/Git/聊天。記錄精確 PID/owner 並在 finally 關閉，不清掉未知程序。所有圖形服務只綁 loopback，經 IAP/SSH 存取。

這個 headed Chrome 在 VM 的 Xvfb 顯示；使用者透過 SSH 轉發後的本機 noVNC 頁面操作，無須使用者裝置安裝 X server。純 X11 forwarding 僅在主控另行確認裝置具備 X server 時才可選用，不能作為本程序的既定前提。

## 唯讀登入防護

VM private config 加入 login。parent 預先建立為該非 root 使用者擁有的 0700 目錄；profile 名稱須是 `gcp-readonly-profile-<unique-suffix>`，整個目錄尚不存在。

```json
{
  "login": {
    "profileDir": "/var/lib/hsr-transfer-worker-staging/login/gcp-readonly-profile-UNIQUE",
    "maxSeconds": 900,
    "authRequests": [],
    "assetOrigins": ["https://webstatic.hoyoverse.com"]
  }
}
```

authRequests 預設空白，不猜登入 API。主控從人工官方登入流程查核必要 routes，才加入 `{origin,path,methods}`。path 精確，methods 僅 GET/POST/OPTIONS；支援官方 auth hosts account.hoyoverse.com、account.hoyolab.com、sg-public-api.hoyoverse.com。新增 host 須另審程式，不能放寬任意網域。query/headers/body 不輸出，不自動蒐集 credentials；勿從第三方流量或策略操作猜 API。

獨立 static allowlist 僅接受設定內的官方來源（支援 webstatic.hoyoverse.com、webstatic-sea.hoyoverse.com、upload-os-bbs.hoyolab.com），限 GET/HEAD、script/style/image/font/media 及靜態副檔名，不是 fetch/XHR bypass。event document 與 src/publisher.mjs 的精確頁面一致。未列明功能可能被擋，須由主控查核需求，不能開放未知 API。

```sh
# 在已核對 host key 的 GCP shell，以專用非 root 使用者執行。
DISPLAY=:99 node scripts/infrastructure/gcp-login-readonly.mjs login /private/staging.json --authorise-readonly-login
```

先用四項 GCE metadata 唯讀欄位核對 instance ID/name/zone/project，再確認正式及 synthetic service 都 inactive/MainPID=0，無手動 writer。工具不 stop/start worker，拒絕 inherited CURRENCY_WAR_*。

profile 以 exclusive mkdir 及 0600 owner marker 取得，既有目錄一律拒絕，不採用舊 profile、不刪 Chrome locks、不殺其他 owner。context 啟用 Chrome sandbox，停用 service workers/擴充功能及下載；所有頁面/popup 在導航前套用 default-deny HTTP routing，WebSockets 全擋。僅精確認證例外可做認證寫入；登入本身仍會改變帳號 session。

CLI 固定使用 `/var/lib/hsr-transfer-worker-staging/login` parent，並先 exclusive 取得共用 `.readonly-session-lock`；不同新 profile 也不能並行登入。掃描會拒絕其他唯讀登入及既有 Chrome/Chromium；啟動後只容許本程序建立的 browser descendants。退出確認後才解除兩種 ownership；不自動採用 stale lock，模糊失敗時保留供主控檢查。

防護必須在建立受控頁面前安裝，不能直接沿用 persistent context 啟動時的空白頁。HTTP 只取得單一回應，所有 3xx 一律拒絕，避免 route.continue 的 redirect 繞過策略 allowlist。若官方認證需要跳轉，由主控確認精確官方目的頁，再人工導航；不能為此自動跟隨未知 redirect。

所有策略 API 預設拒絕，包括 GET/POST/PUT/DELETE。唯一資料 API 是 repo 既有 `POST /event/rpgcurrencywar/game/user/lineup`，固定字串 payload `{game:hkrpg,page:1,limit:1,lineup_type:Tourn,order:CreatedTime}` 及同 URL OPTIONS。不能以 auth/static 規則開放 create/edit/delete 或未知策略 API。工具不匯入 publisher，也不提供任意 request/create/edit 介面。

主控人工登入/MFA、回 event page，輸入 ready 後連續做兩次既有唯讀請求。官方 cookie/device identity 留在瀏覽器；Node 只收到布林結果。沒有 cookies/storageState/HAR/trace/截圖/回應內容匯出；第二次失敗就失敗，不重試登入或發布。

完成、失敗、SIGINT/SIGTERM 或 maxSeconds 到期會 close 本工具 context；close 確認後才釋放 owner marker。啟動/close 不明則保留 marker、不稱 cleanup 成功。profile 作為敏感資料只留此 VM，不自動交給 publisher；下一次工作必須新 profile。另停止圖形程序/IAP/SSH，最後 scoped stop VM 並讀回 TERMINATED。不取消 provider STOP、不啟動正式 worker。

本機測試不是 GCP 真實 login/MFA、官方認證資源完整相容性或兩次 live authenticated API 證據；仍待主控實際操作。

## 純恢復計畫與 production state 分界

restore-plan 是純程序順序檢查器：只讀本機 private config，不讀 archive/state/key、不呼叫 provider、不寫檔、不 restore、不啟動 publisher。輸入是 operator-supplied-unverified，最後僅到 procedure-review-required；永遠 cloudMutations=false、productionStateVerified=false。人工填 true 不是驗證收據。

```json
{
  "restorePlan": { "mode": "synthetic-staging-dry-run", "direction": "staging-restore", "events": [] }
}
```

```powershell
node scripts/infrastructure/gcp-standby.mjs restore-plan D:/<private>/restore-plan.json
```

mode/direction 僅接受 synthetic-staging-dry-run/staging-restore，或 production-procedure/cutover、production-procedure/rollback。不可將 synthetic 演練改名為 rollback。固定順序：

| Event type | 必要人工檢核欄位 | 下一階段 |
| --- | --- | --- |
| quiescence-reviewed | submissionsDisabled=true、queued/running/ambiguous=0、sourceStopped/destinationStopped=true、profileOwners=0 | awaiting-archive |
| archive-reviewed | kind=synthetic 或 production（匹配 mode）、completeThreeFileSet/integrityChecked/latestAuthoritative=true | awaiting-isolated-restore |
| isolated-restore-reviewed | newDirectory/exactBytesCompared/mappingsJobsQuotaPolicySecurityCompared=true、credentialsCopied=false | procedure-review-required |

每項 event 用 type 指定名稱。錯序、活躍 jobs/writers、部分 state、過期權威來源、credentials 搬移或任何 start-publisher 指令都拒絕。synthetic 與 production 格式可能相同；mode/kind 只是宣告，不能由 schema 證明來源。合成事件成功只證明順序檢查。

真正 offline archive integrity/restore 使用既有 reviewed worker-state-backup.mjs verify|restore，由管理者在核准受限主機個別執行；它驗證 checksum、解密/GCM、manifest、三檔 hash/schema，restore 使用 exclusive 新目錄。planner booleans 不能當成 assertQuiescent 或已驗證 archive。這次不執行舊 restore drill，不接觸 production key/state。

主控如後續需要測試正式加密備份，可先在受限 Windows D 槽離線解密／驗證至全新隔離路徑，再沿同一 known-host pin 的 SSH 安全傳輸完整三檔至新的非啟動目錄。傳輸前後 publisher 全部停止，重比 bytes/hash、權限及完整 state，不傳 recovery key/profile/cookies。這仍是接觸真實 production state 的受控 restore，不是 pure synthetic dry run；不能啟動 synthetic/正式服務讀取該路徑。本次僅備妥程序，不執行解密或傳輸。

## 實際 restore / rollback 人工程序

1. 合成 staging：只用已確認 synthetic fixtures/archives、獨立 state directory/token，正式 publisher 停止。不可將 production archive 解密到 synthetic service 會讀的路徑。任何 restore 先停止 writer、保留原 state，還原到新的非啟動目錄，不自動安裝/啟動。
2. 正式準備：遵循 [Azure→GCP cutover](azure-to-gcp-cutover.md)，另需 Production GO。停止新提交、凍結管理寫入，排空 queued/running，人工 reconciliation ambiguous upstream 結果。systemctl stop 不等於排空；不重送不確定 create。
3. 一致快照：兩端 publisher/手動 writer/profile owner 全停止，取得最新權威來源的 transfers.json、jobs.json、jobs.json.security.json 全套加密 archive/manifest。不只搬 mappings，不補空 quota/security。驗證 ciphertext/解密/各檔 byte length/hash，再在 exclusive 新目錄 restore。
4. 完整比較：job results/status、source→Global mappings、quota events/blockedUntil、提交 policy、security limits/revocations/sessions 及三檔 exact bytes。保存目標舊 state，不 overwrite。維護前 policy/environment/paired token 依真正 production runbook 審核；不沿用 synthetic 預設。profile 不在 archive；GCP 新登入，Azure 原 profile 或另行重登，從不跨機搬 cookies。
5. rollback：GCP 曾做正式工作後，最新 GCP production state 才是回 Azure 的來源；不可啟動 Azure 舊 queue 或用 cutover 前 archive 覆蓋新結果。Azure credit/服務失效時停止並回報不可行。planner 標示 latest-gcp-production-state 不代表讀過它。
6. 待審交付：記錄 SHA、archive/manifest、時間、兩端 service/PID/profile owner、路徑/權限與差異。本工具不安裝正式 state、不改 Vercel URL/token/DNS、不開公開提交、不 live transfer、不刪資源。另獲 Production GO 且確認單一 publisher，才由正式 runbook 續行。

## 驗證邊界

獨立 D worktree；Box 在本次工具清單不可用，使用 Windows 本機 fallback，沒有傳私有資料至第三方。只執行受影響的兩個 Node test files、語法與 diff 檢查，不觸發 CI 或廣泛 synthetic/restart/systemd/restore 驗收。provider/metadata/browser session 邊界用受控資料；通過不代表 GCP/production 操作完成。獨立驗證需最終 exact commit 的 fresh checkout、clean dependencies，記錄 SHA、Node/npm/OS、命令、exit code/test counts，不能冒用開發 worktree 收據。

精確 browser guard 檢查以 `HSR_READONLY_BROWSER_GUARD_TEST=1 node --test test/gcp-standby.test.mjs test/gcp-login-readonly.test.mjs` 啟用。使用 D 槽全新 profile、真實 sandbox Chrome、拒絕所有 CONNECT 的 loopback proxy，確認策略 fetch 與 WebSocket 未抵達 proxy；不連真實上游，不重跑既有合成驗收。首輪確實抓到使用 persistent 初始頁時 WebSocket 防護未覆蓋，修正成先裝 routes 再建頁後通過。HTTP redirect 的獨立回歸亦先失敗，再以單跳 fetch/3xx 拒絕修正。
