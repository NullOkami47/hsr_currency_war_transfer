<div align="center">

# 崩壞：星穹鐵道「貨幣戰爭」攻略轉移工具

🌌 **搜尋中國服攻略，安全轉移至全球服**

<p align="center">
  <a href="./README.en.md">English</a> |
  <strong>繁體中文</strong> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/NullOkami47/hsr_currency_war_transfer?color=brightgreen" alt="MIT 授權條款"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20 或更新版本">
  <a href="https://hsrcurrencywartransfervercel.vercel.app/"><img src="https://img.shields.io/badge/Vercel-%E7%B7%9A%E4%B8%8A%E4%BD%BF%E7%94%A8-000000?logo=vercel" alt="Vercel 線上版本"></a>
</p>

<p align="center">
  <a href="https://hsrcurrencywartransfervercel.vercel.app/"><strong>立即使用</strong></a> •
  <a href="#-功能特色">功能特色</a> •
  <a href="#-快速開始">快速開始</a> •
  <a href="#-部署與管理">部署與管理</a> •
  <a href="#-文件">文件</a>
</p>

</div>

## 📝 專案介紹

本專案提供攻略轉移核心與由管理員管理的本機發布連接器，用於將《崩壞：星穹鐵道》「貨幣戰爭」攻略從中國服轉移至全球服。

使用者可以用中國服攻略 URL／ID 精確查找，或按攻略名稱、作者、角色及羈絆篩選候選攻略。確認內容後，系統會交由管理員的發布 worker 建立或更新全球服版本，並回傳攻略碼與官方連結。

> [!IMPORTANT]
> 這是非官方工具。來源攻略文字會保留原文；全球服無法對應的項目會被略過，並在結果中清楚列出。

---

## 🌐 線上使用

<div align="center">

### [開啟「貨幣戰爭」攻略轉移工具](https://hsrcurrencywartransfervercel.vercel.app/)

`https://hsrcurrencywartransfervercel.vercel.app/`

</div>

搜尋與候選攻略選擇不需要登入。攻略發布由獨立的管理員 worker 執行；若服務尚未連接，網站仍可搜尋及選擇攻略，提交時則會顯示服務不可用狀態。

---

## ✨ 功能特色

| 功能 | 說明 |
| --- | --- |
| 🔎 多種搜尋方式 | 支援中國服 URL／ID 精確查找，以及攻略名稱、作者、角色與羈絆篩選 |
| 🔗 跨服資料轉換 | 以允許清單轉換中國服資料，並處理跨區遊戲資料 ID |
| 🛡️ 安全發布流程 | 透過全球服官方網頁介面建立或編輯，不匯出 Cookie、密碼或瀏覽器儲存資料 |
| ✅ 發布後驗證 | 重新擷取全球服攻略，標準化後比對玩法欄位與完整標題前綴 |
| ♻️ 建立或原地更新 | 已對應的攻略會在需要時更新，避免重複建立 |
| 🌓 多語言介面 | 支援繁體中文、簡體中文與英文，並提供淺色及深色模式 |
| 🕘 本機提交紀錄 | 在瀏覽器保留最多 50 筆完成紀錄，方便再次取得攻略碼與官方連結 |
| ⚙️ 管理員控制台 | 提供公開提交開關、黑名單、限流、配額、佇列及紀錄保留設定 |

### 已驗證範圍

- ✅ 中國服及全球服匿名讀取
- ✅ 跨伺服器遊戲資料 ID 相容性
- ✅ 以允許清單控制的資料轉換
- ✅ 透過全球服官方網頁介面建立及編輯攻略
- ✅ 不匯出 Cookie 的瀏覽器工作階段發布器
- ✅ 發布後與中國服來源進行玩法資料驗證

測試攻略的玩法資料與中國服來源完全一致。本機發布器已完成並通過單元測試；實際發布前，管理員仍須登入專用 Chrome 設定檔。驗證證據、根本原因分析及剩餘風險請參閱[可行性研究](docs/feasibility-spike.md)。

---

## 🚀 快速開始

### 環境需求

| 元件 | 需求 |
| --- | --- |
| Node.js | 20 或更新版本 |
| 瀏覽器 | Chrome（僅管理員登入及發布流程需要） |
| 作業系統 | 本機網站與搜尋工具可在 Node.js 支援的平台執行 |

### 啟動本機網站

```powershell
git clone https://github.com/NullOkami47/hsr_currency_war_transfer.git
cd hsr_currency_war_transfer
npm install
npm run dev
```

完成後開啟 `http://127.0.0.1:4173`。

### 啟動完整本機服務

```powershell
# 首次使用或需要更換發布帳號時登入
npm run connector:login

# 同時啟動網站與已驗證身分的 worker
npm run local:start

# 停止兩個背景程序
npm run local:stop
```

<details>
<summary><strong>查看所有常用指令</strong></summary>

```powershell
npm test
npm run probe -- 6a587503f4749840a14a360d
npm run search -- 6a587503f4749840a14a360d
npm run search -- --author 田宮良子
npm run search -- --keyword 姬子 --roles 1510,1001
npm run search -- --list-roles 姬子
npm run diff:live -- 6a587503f4749840a14a360d 6a6c461e6217fd436611cdc7
npm run connector:login
npm run worker
npm run mapping:adopt -- 6a587503f4749840a14a360d 6a6c461e6217fd436611cdc7
npm run transfer -- 6a587503f4749840a14a360d
```

- `probe`：只讀取及轉換資料，不會寫入。
- `diff:live`：重新擷取兩邊攻略並比較玩法資料；如有差異會以非零狀態結束。
- `mapping:adopt`：登記在連接器建立前已存在的全球服攻略，供後續原地驗證與更新。
- `transfer`：使用管理員專用 Chrome 設定檔執行完整的建立／更新／驗證流程。

</details>

預設情況下，瀏覽器設定檔及來源至全球服的對照資料會儲存在儲存庫之外：

```text
~/.hsr-currency-war-transfer/browser-profile
~/.hsr-currency-war-transfer/transfers.json
```

可使用 `CURRENCY_WAR_PROFILE_DIR`、`CURRENCY_WAR_STATE_PATH`，或對應的 `--profile-dir`、`--state` 命令選項覆寫位置。

---

## 🚢 部署與管理

在 Vercel 上設定以下伺服器端環境變數，便可把公開網站的提交功能連接至獨立的已驗證發布 worker，並啟用 `/admin` 管理頁：

| 環境變數 | 用途 |
| --- | --- |
| `CURRENCY_WAR_WORKER_URL` | 外部發布 worker 的網址 |
| `CURRENCY_WAR_WORKER_TOKEN` | Vercel API 與 worker 之間的驗證權杖 |
| `CURRENCY_WAR_ADMIN_TOKEN` | 管理員控制台的獨立驗證設定 |

請在管理員電腦或持續運作的 VM 上，使用相同的 worker 權杖執行：

```powershell
npm run worker
```

網站會建立工作、透過 Vercel API 輪詢進度，最後回傳全球服攻略碼與官方攻略連結。瀏覽器不會接觸 worker 權杖或 HoYoLAB 工作階段。同一篇中國服攻略的進行中請求會共用一項工作；已完成的重複請求則會執行建立／更新／不變比較流程。

> [!TIP]
> 未設定上述變數時，搜尋與候選選擇仍可正常使用，只有攻略提交功能會停用。

完整設定請參閱 [`.env.example`](.env.example)、[管理員發布連接器](docs/admin-connector.md)及[管理員登入與 2FA 指南](docs/admin-login.zh-TW.md)。

---

## 🔄 轉移規則

<details>
<summary><strong>查看完整轉移與驗證規則</strong></summary>

- 讀取中國服標題已選的兩個羈絆，將穩定特性 ID 對應至全球服 `zh-tw` 名稱，再重建前綴，例如 `【6战技点4命运圣杯】` → `【6戰技點4命運聖杯】`。
- 保留其餘中文標題及營運概念原文。
- 僅在標題不超過 60 個字元時加入 `｜作者名稱`。
- 僅在營運概念不超過 800 個字元時加入 `來源：作者名稱`。
- 忽略全球服無法使用的 ID，並在 `ignored` 中回傳所有略過項目。
- 若已對應的全球服攻略仍與來源相同，回傳現有攻略碼。
- 若來源已變更，原地編輯已對應的攻略。
- 若不存在有效對照，建立新攻略。
- 回傳成功前重新擷取並比較已發布資料。
- 同時驗證玩法欄位與完整重建後的標題前綴。
- 依序執行本機發布工作，避免重複請求造成競爭情況。

</details>

---

## 📚 文件

| 文件 | 內容 |
| --- | --- |
| [可行性研究](docs/feasibility-spike.md) | 驗證證據、根本原因分析與剩餘風險 |
| [管理員發布連接器](docs/admin-connector.md) | 本機及正式環境部署、帳號操作與安全邊界 |
| [管理員登入與 2FA](docs/admin-login.zh-TW.md) | 密碼設定、Google Authenticator、輪替及復原 |
| [搜尋與轉移 API](docs/search-api.md) | Vercel Functions 的請求與回應格式 |
| [VM HoYoLAB 登入](docs/vm-hoyolab-login.md) | VM 裝置身分、登入步驟與故障排除 |
| [安全政策](SECURITY.md) | 漏洞回報與安全注意事項 |

---

## 🔌 第一方端點

<details>
<summary><strong>查看中國服及全球服端點</strong></summary>

**中國服基礎網址**

`https://act-api-takumi.miyoushe.com/event/rpgcurrencywar`

**全球服基礎網址**

`https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar`

**讀取操作**

- `GET /game/config?game=hkrpg`
- `POST /game/lineup/index`
- `GET /game/lineup/detail?id={id}&game=hkrpg`

**需要全球服身分驗證的寫入操作**

- `POST /game/lineup/create_lineup_tourn`
- `POST /game/lineup/edit`

> [!WARNING]
> 以上為第一方網頁應用程式端點，並非有正式文件的公開 API，可能隨時變更。

</details>

---

## 📜 授權條款

本專案採用 [MIT 授權條款](LICENSE)。

---

<div align="center">

### 💫 感謝使用「貨幣戰爭」攻略轉移工具

**[線上使用](https://hsrcurrencywartransfervercel.vercel.app/)** • **[回報問題](https://github.com/NullOkami47/hsr_currency_war_transfer/issues)** • **[查看原始碼](https://github.com/NullOkami47/hsr_currency_war_transfer)**

<sub>為開拓者而製作，與 HoYoverse／米哈遊沒有官方關聯。</sub>

</div>
