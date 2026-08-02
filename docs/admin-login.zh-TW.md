# 管理員頁面登入、密碼與兩步驗證設定

[English](admin-login.md) | [简体中文](admin-login.zh-CN.md) | **繁體中文**

本指南說明如何開啟 `/admin`、設定或更換管理員密碼，以及使用 Google
Authenticator 啟用 TOTP 兩步驗證（2FA）。實際密碼、密碼雜湊、TOTP
設定金鑰及工作者權杖都屬於機密資料，不得寫入 Git、README、Issue、聊天訊息或前端程式碼。

## 登入管理員頁面

1. 開啟正式網站網址，並在結尾加上 `/admin`，例如
   `https://<你的網域>/admin`。
2. 輸入管理員密碼。
3. 若頁面顯示「驗證器代碼」欄位，輸入 Google Authenticator 當前顯示的
   6 位數代碼。
4. 按「登入」。使用完畢後，請按頁面上的「登出」，共用電腦尤其如此。

成功登入後，工作階段最長維持 8 小時。登入 Cookie 為 HTTP-only、
SameSite=Strict，瀏覽器本機儲存空間不會保存密碼、TOTP 代碼或工作者權杖。

## 設定或更換管理員密碼

正式環境建議只在 Vercel 儲存 PBKDF2-SHA256 密碼雜湊，而不是儲存明文密碼。
請使用密碼管理器產生至少 16 個隨機字元，或使用至少 20 個字元的獨特密碼片語；
不要重用 Vercel、GitHub、電郵或 HoYoLAB 密碼。

### 1. 在本機產生密碼雜湊

在 PowerShell 進入專案目錄後執行以下指令。輸入內容不會顯示在畫面上；最後一行
輸出的 `pbkdf2_sha256$...` 才是要貼到 Vercel 的值，而不是原始密碼。

```powershell
$securePassword = Read-Host "輸入新的管理員密碼" -AsSecureString
$plainPassword = [System.Net.NetworkCredential]::new("", $securePassword).Password
$env:CURRENCY_WAR_PASSWORD_TO_HASH = $plainPassword

try {
@'
const { randomBytes, pbkdf2Sync } = require("node:crypto");
const salt = randomBytes(16);
const hash = pbkdf2Sync(
  process.env.CURRENCY_WAR_PASSWORD_TO_HASH,
  salt,
  600000,
  32,
  "sha256",
);
console.log([
  "pbkdf2_sha256",
  "600000",
  salt.toString("base64url"),
  hash.toString("base64url"),
].join("$"));
'@ | node
} finally {
  Remove-Item Env:CURRENCY_WAR_PASSWORD_TO_HASH -ErrorAction SilentlyContinue
  $plainPassword = $null
  $securePassword = $null
}
```

每次執行都會產生不同的 salt，所以相同密碼也會得到不同雜湊，這是正常現象。

### 2. 將雜湊儲存在 Vercel

1. 開啟 Vercel 專案的 **Settings → Environment Variables**。
2. 新增或更新 `CURRENCY_WAR_ADMIN_PASSWORD_HASH`，值為上一步完整輸出的
   `pbkdf2_sha256$...`。
3. 將它標記為 Sensitive（如介面提供此選項），至少套用至 **Production**。
   只有在 Preview 或 Development 也需要管理頁時，才將同一變數加入那些環境。
4. 若已改用密碼雜湊，請移除不再需要的 `CURRENCY_WAR_ADMIN_TOKEN`，避免舊權杖仍可登入。
5. 重新部署 Production。Vercel 環境變數變更不會套用至先前的部署。
6. 使用新的密碼登入 `/admin`；請勿將 `pbkdf2_sha256$...` 雜湊貼進密碼欄位。

環境範圍及部署行為的最新資料請參閱 Vercel
[環境變數官方文件](https://vercel.com/docs/environment-variables)。

換新雜湊並完成重新部署後，舊密碼與使用舊憑證簽發的管理員工作階段將失效。

> `CURRENCY_WAR_ADMIN_TOKEN` 仍可作為相容方式或本機測試憑證，但正式環境的值必須
> 至少 32 個字元。不要把它與 `CURRENCY_WAR_WORKER_TOKEN` 設成相同值。

## 啟用 Google Authenticator 兩步驗證

此功能使用 RFC 6238 TOTP：每次建立新的管理員工作階段時，除密碼外還需要一組
6 位數、隨時間變更的代碼。

### 1. 產生獨立的 TOTP 設定金鑰

在專案目錄執行：

```powershell
npm run admin:totp:generate
```

指令會顯示帳戶名稱、分組後的設定金鑰及類型。此金鑰等同第二因素的主密鑰；
不要提交至 Git，也不要傳給線上 QR code 產生器。

### 2. 加入 Google Authenticator

1. 在 Google Authenticator 按「＋」。
2. 選擇「輸入設定金鑰」。
3. 帳戶名稱輸入 `Currency War Admin`。
4. 輸入剛才產生的設定金鑰。
5. 金鑰類型選擇「依時間產生」。

如需復原能力，可將設定金鑰另存於可信任密碼管理器的加密安全筆記。任何取得此金鑰
的人都能產生有效代碼，因此不要以普通文字檔、截圖或電郵保存。

### 3. 將 TOTP 金鑰儲存在 Vercel

1. 在 Vercel **Settings → Environment Variables** 新增或更新
   `CURRENCY_WAR_ADMIN_TOTP_SECRET`。
2. 值使用不含空格的完整設定金鑰。
3. 將它標記為 Sensitive，並套用至與管理頁相同的環境；正式網站至少選
   **Production**。
4. 重新部署 Production。
5. 開啟 `/admin`，確認頁面要求密碼及 6 位數驗證器代碼，並實際登入一次。

啟用或輪替 TOTP 金鑰會令舊管理員工作階段失效。成功使用過的同一組代碼，不能在
同一個執行中的 API instance 立即建立第二個工作階段。

## 更換手機、遺失手機或重設 2FA

- **仍保留設定金鑰：** 在新手機的 Google Authenticator 以同一金鑰重新加入帳戶。
- **金鑰已遺失，但仍可管理 Vercel：** 在可信任電腦重新執行
  `npm run admin:totp:generate`，先在新手機加入新金鑰，再更新
  `CURRENCY_WAR_ADMIN_TOTP_SECRET` 並重新部署。
- **無法管理 Vercel：** 系統沒有繞過 2FA 的後門；需要由獲授權的 Vercel 專案擁有者
  協助輪替環境變數。

如要停用 2FA，可刪除 `CURRENCY_WAR_ADMIN_TOTP_SECRET` 後重新部署，但不建議在
公開正式環境這樣做。

## 常見問題

### 密碼及代碼正確，但仍無法登入

1. 確認手機日期、時間及時區使用自動同步。
2. 等待下一組代碼後再試一次，避免在 30 秒週期即將結束時提交。
3. 確認 Authenticator 項目類型是「依時間產生」，並輸入目前的 6 位數代碼。
4. 確認 Vercel 的變數名稱與套用環境正確，而且更新後已建立新部署。
5. 連續失敗後，同一用戶端在單一 API instance 內可能暫時受限；預設為 10 分鐘內
   最多 5 次失敗。請先停止重試，稍後再以全新的代碼登入。

登入失敗會刻意回傳相同訊息，不會指出是密碼還是 2FA 錯誤。若 TOTP 設定金鑰格式
無效，管理員登入會安全地停止服務，而不是退回成只驗證密碼。

### 登入後可設定甚麼？

管理員頁面可查看發布紀錄及工作狀態，並調整公開提交開關、來源攻略封鎖清單（blacklist）、
每 IP 限流、發布帳戶每日配額、等待中工作上限及紀錄保留政策。首次啟用前，請先
設定合適政策，再開啟公開提交。

## 安全檢查清單

- 密碼、密碼雜湊、TOTP 金鑰及工作者權杖均只存於受控環境，不提交至 Git。
- 密碼、`CURRENCY_WAR_ADMIN_TOKEN`、`CURRENCY_WAR_WORKER_TOKEN` 與 TOTP
  金鑰不得互相重用。
- 正式環境保持 2FA 開啟，並為 Vercel 與 GitHub 帳戶本身啟用多因素驗證。
- 每次更換密碼或 TOTP 金鑰後重新部署，並以新憑證實際測試一次。
- 若懷疑任何憑證外洩，立即輪替相應環境變數，不要只修改文件或前端畫面。

完整的 worker、HoYoLAB 發布帳戶及安全政策設定請參閱
[管理員發布連接器](admin-connector.md)。
