# Oracle Ubuntu ARM64 staging：準備與合成驗證

這是 staging 操作稿；目前沒有建立 VM、安裝套件或執行 ARM 瀏覽器。根據實際 Oracle
建立嘗試與資源核查結果，`ap-singapore-1` AD1 的 A1 Flex 回報容量不足：所選設定為
Ubuntu 24.04 Minimal aarch64、1 OCPU／6 GB、預設 46.6 GB boot volume、無 public IP、
SSH key 登入與 Oracle 自選 fault domain，介面顯示 Always Free；**沒有成功建立 VM，
狀態為 `ORACLE_BLOCKED`**。`ap-singapore-1`／root compartment 的資源核查中，Instances、
VCN、Block Volumes 與 Boot Volumes 均顯示 `No items to display`；無須清理。此結果不代表
ARM 可啟動或帳務最終結論。

以下僅用於日後可取得的全新、獨立的
Ubuntu 24.04 arm64 staging VM；不建立服務、不開放防火牆、不登入 HoYoLAB、不發布或切換流量。
由負責 Oracle UI 的人先確認免費資格、容量與費用。任何命令失敗即停止並保留錯誤，不使用 root
啟動瀏覽器，也不新增停用 sandbox 的參數來繞過失敗。

以下 Node 24.18.0 是固定的 Node.js LTS 版本，[官方下載](https://nodejs.org/en/download)；
Playwright 使用 repo lockfile 的 `playwright-core 1.62.1` 及其官方 CLI 安裝 Chromium 和依賴
（[官方說明](https://playwright.dev/docs/browsers)）。官方網站目前列出 Ubuntu 24.04 arm64
為支援的系統，這不代表本機器、鎖定版本或其瀏覽器已實際驗證。

## 1. VM 檢查與專用帳號

使用 VM 管理員的互動 shell，執行以下命令；不要在現有 Azure 主機執行。

```bash
set -eu
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 24.04
test "$(uname -m)" = aarch64
! getent passwd hsr-worker
test ! -e /var/lib/hsr-transfer-worker
test ! -e /opt/hsr-transfer
test ! -e /opt/node-v24.18.0
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils util-linux
sudo useradd --system --user-group --home-dir /var/lib/hsr-transfer-worker --shell /usr/sbin/nologin hsr-worker
sudo install -d -m 0700 -o hsr-worker -g hsr-worker /var/lib/hsr-transfer-worker
sudo install -d -m 0755 -o root -g root /opt/hsr-transfer
```

失敗後應先檢查現況；以上存在性檢查刻意拒絕覆蓋既有帳號和目錄。
不授予該帳號 sudo 或 SSH 登入權限；來源目錄由 root 持有，供此帳號唯讀。

## 2. 安裝官方 Node 發行檔

下列獨立子 shell 將下載暫存在管理員的臨時目錄，從 nodejs.org 的 HTTPS 發行目錄取得
校驗表並核對 arm64 tarball，才將內容解壓到 root 管理的 `/opt/node-v24.18.0`。
這是同一 HTTPS 來源的 SHA-256 完整性檢查，並非獨立簽章驗證；如需供應鏈簽章驗證，
另依 [Node 官方驗證指南](https://github.com/nodejs/node#verifying-binaries) 執行。

```bash
(
  set -eu
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  cd "$work"
  base=https://nodejs.org/dist/v24.18.0
  file=node-v24.18.0-linux-arm64.tar.xz
  curl --fail --location --proto '=https' --tlsv1.2 -O "$base/$file"
  curl --fail --location --proto '=https' --tlsv1.2 -O "$base/SHASUMS256.txt"
  grep "  $file\$" SHASUMS256.txt | sha256sum -c -
  sudo mkdir /opt/node-v24.18.0
  sudo tar -xJf "$file" --strip-components=1 -C /opt/node-v24.18.0
  /opt/node-v24.18.0/bin/node --version
  PATH=/opt/node-v24.18.0/bin:$PATH /opt/node-v24.18.0/bin/npm --version
)
```

## 3. 經審閱的來源及依賴

從**精確的已審閱 commit** 建立來源封存，並記錄其完整 SHA；該 commit 必須包含本操作稿、
兩個 `scripts/infrastructure/oracle-synthetic-*.mjs` 及 `test/oracle-synthetic.test.mjs`。
基準 `e6676b2` 不含這些檔案，因此不能作為含這些檔案的封存來源；請使用日後確實包含它們
且已經審閱的 commit。
僅透過已核准管道將封存傳至 VM；不得包含 `.env`、憑證、browser profile、cookies、
正式狀態、`node_modules` 或 Git 認證。記錄完整 commit SHA 與封存 SHA-256，獨立核對後才解壓。
以下假設封存在 `/tmp/hsr-staging-reviewed.tar`；將 `REPLACE_WITH_REVIEWED_SHA256` 換成
已透過可信管道核對的 64 位雜湊。封存必須為已審閱且路徑安全的 tar。

```bash
set -eu
printf '%s  %s\n' REPLACE_WITH_REVIEWED_SHA256 /tmp/hsr-staging-reviewed.tar | sha256sum -c -
sudo tar --no-same-owner --no-same-permissions -xf /tmp/hsr-staging-reviewed.tar -C /opt/hsr-transfer
sudo env -i HOME=/root PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  bash -c 'set -eu; cd /opt/hsr-transfer; npm ci --ignore-scripts; node node_modules/playwright-core/cli.js --version'
sudo chmod -R go-w /opt/hsr-transfer
```

以上安裝不執行 npm lifecycle scripts；來源和依賴由 root 持有，避免以 root 執行
`hsr-worker` 可改寫的 CLI。仍必須先審閱封存、lockfile 與依賴：此做法不取代供應鏈審核。
預期 CLI 顯示 `Version 1.62.1`。以下 root 命令執行**該 lockfile 安裝的**官方 CLI，
以 apt 安裝 Chromium 系統依賴；接著以專用非 root 帳號下載該版本對應的 Chromium：

```bash
cd /opt/hsr-transfer
sudo /opt/node-v24.18.0/bin/node node_modules/playwright-core/cli.js install-deps chromium
sudo -u hsr-worker env -i HOME=/var/lib/hsr-transfer-worker PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  PLAYWRIGHT_BROWSERS_PATH=/var/lib/hsr-transfer-worker/pw-browsers \
  /opt/node-v24.18.0/bin/node node_modules/playwright-core/cli.js install chromium
```

此階段會連線 Node、npm、Ubuntu 套件庫及 Playwright 官方下載來源，不連線 HoYoLAB。
請先核實 VM 的外連政策與檔案所有權；安裝是 staging root 操作，不是服務部署。

## 4. 合成測試：不得使用正式資料

第一項在全新 network namespace 執行瀏覽器，並降權為 `hsr-worker`。可信的管理員 shell
在 `unshare` 前取得自己的 namespace，透過清空的環境交給腳本；腳本要求標記有效、與自身
namespace 不同，且沒有非 loopback 網路介面。非 root 未必能讀 `/proc/1/ns/net`，因此
不依賴該路徑。此標記仰賴下方啟動命令的正確執行，不是對惡意操作者的獨立證明；不得手動
偽造或覆寫。若 `unshare`、隔離或 Chromium 啟動失敗，即停止，不得改用一般網路。腳本明確
設定 `chromiumSandbox: true`，不以 Playwright 預設值停用 sandbox。腳本建立並刪除暫存
profile，檢查真實 Chromium 啟動、頁面、合成 cookie 在關閉／重啟後保留，並輸出 Playwright、
瀏覽器版本與 executable。隔離也涵蓋 persistent context 可能在攔截器設立前還原頁面的情況。

```bash
cd /opt/hsr-transfer
sudo sh -c 'set -eu
  parent_netns=$(readlink /proc/self/ns/net)
  exec unshare --net -- runuser -u hsr-worker -- env -i \
    HOME=/var/lib/hsr-transfer-worker PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
    PLAYWRIGHT_BROWSERS_PATH=/var/lib/hsr-transfer-worker/pw-browsers \
    CURRENCY_WAR_SYNTHETIC_PARENT_NETNS="$parent_netns" \
    /opt/node-v24.18.0/bin/node scripts/infrastructure/oracle-synthetic-browser.mjs'
sudo -u hsr-worker env -i HOME=/var/lib/hsr-transfer-worker PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  /opt/node-v24.18.0/bin/node scripts/infrastructure/oracle-synthetic-http.mjs
sudo -u hsr-worker env -i HOME=/var/lib/hsr-transfer-worker PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  /opt/node-v24.18.0/bin/node --test test/browser-config.test.mjs test/oracle-synthetic.test.mjs
```

HTTP 測試只監聽 loopback 的臨時埠，使用假 token、假 transfer 和暫存 JSON，檢查 health、
未授權拒絕、工作完成與狀態重讀；沒有啟動 VM 服務或正式 worker，也沒有真正發布。另有
`test/security-worker.test.mjs` 的程序重啟測試：它只重啟使用暫存資料與 loopback 的本機
合成子程序，不是 VM service 或雲端部署證據。瀏覽器設定測試以
mock launcher 驗證 Azure 預設 `chrome` 與 executable 優先權；`oracle-synthetic.test.mjs` 以 mock
驗證 sandbox 選項、隔離檢查及清理。這些 mock 測試都不是 ARM 瀏覽器啟動證據。

若 browser smoke 成功，其輸出的 `executablePath` 可供**日後經核准**的 staging worker 設定
`CURRENCY_WAR_BROWSER_EXECUTABLE_PATH`；同時維持相同 `PLAYWRIGHT_BROWSERS_PATH` 與
專用帳號，且重新安裝版本後重新檢查。不要將此值套用 Azure：原本未設定時仍使用
`channel: "chrome"`。記錄 VM 映像、architecture、完整來源 SHA、封存 hash、Node/npm、
Playwright、Chromium、命令與各 exit code。此測試不證明登入、MFA、正式發布、Production
狀態轉移或切換可行；後續需依既有[遷移手冊](free-worker-migration.md)另行驗收。
