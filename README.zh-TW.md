# 崩壞：星穹鐵道「貨幣戰爭」攻略轉移工具

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md)

此儲存庫包含攻略轉移核心，以及一個由管理員管理的本機發布連接器，用於將「貨幣戰爭」攻略從中國服複製到全球服。

目前已驗證：

- 中國服及全球服的匿名讀取；
- 跨伺服器遊戲資料 ID 相容性；
- 以允許清單控制的資料轉換；
- 透過全球服官方網頁介面進行已驗證身分的建立／編輯操作；
- 不會匯出 Cookie、以程式控制瀏覽器工作階段的發布器；以及
- 發布後與中國服來源進行玩法資料驗證。

測試攻略的玩法資料與中國服來源完全一致。本機發布器已完成並通過單元測試；如需實際發布，管理員須登入其專用 Chrome 設定檔。

證據、根本原因分析及剩餘風險請參閱 [docs/feasibility-spike.md](docs/feasibility-spike.md)。

## 執行方式

需要 Node.js 20 或更新版本。

```powershell
npm run local:start
npm run local:stop
npm run dev
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

`npm run dev` 會在 `http://127.0.0.1:4173` 啟動本機網站。網站支援以中國服 URL／ID 精確查找、以攻略名稱及作者搜尋、角色多選 AND 篩選、候選攻略選擇及提交轉移，並提供淺色與深色模式。介面文字及角色名稱支援繁體中文、簡體中文及英文；來源攻略文字會保持不變。

`npm run local:start` 會使用記憶體內的隨機權杖，同時在 localhost 啟動網站及已驗證身分的 worker。`npm run local:stop` 會停止這兩個背景程序。需要變更已儲存的 HoYoLAB 工作階段或發布帳號時，請先執行 `npm run connector:login`。

在 Vercel 上，將 `CURRENCY_WAR_WORKER_URL` 及 `CURRENCY_WAR_WORKER_TOKEN` 設定為伺服器端環境變數，便可將提交按鈕連接至獨立的已驗證發布 worker。請在管理員電腦或持續運行的 VM 上，以相同權杖執行 `npm run worker`。網站會建立工作，透過 Vercel API 輪詢進度，再回傳全球服攻略碼；瀏覽器不會接觸 worker 權杖或 HoYoLAB 工作階段。同一篇中國服攻略的重複進行中請求會共用一項工作；已完成的重複請求則會執行既有的建立／更新／不變比較流程。

若未設定這些變數，搜尋及候選選擇仍可正常使用；提交轉移時會清楚顯示服務尚未連接。完整的本機及正式環境設定請參閱 `.env.example` 與 [docs/admin-connector.md](docs/admin-connector.md)。

`probe` 只會讀取及轉換資料，不會寫入。`diff:live` 會重新擷取兩邊已發布的攻略，使用相同轉換器將其標準化；若任何玩法欄位不同，便以非零狀態結束。

`search` 可接受中國服攻略 URL／ID 進行精確查找，也可按照攻略名稱、作者顯示名稱及多個角色 ID，在有限範圍內搜尋中國服推薦清單。篩選採用 AND 邏輯；每個已選角色都必須出現在候選攻略內。使用 `--list-roles` 可取得目前可見的中國服角色清單及 ID。搜尋結果只包含可安全顯示的候選資料，不會包含作者帳號識別資料。

相同功能亦以 Vercel Functions 的 `GET /api/roles` 及 `POST /api/search` 提供。請參閱 [docs/search-api.md](docs/search-api.md) 了解請求及回應格式。

`connector:login` 會開啟專用 Chrome 設定檔。管理員可以隨時在該視窗登入、登出或更換發布帳號，然後關閉視窗。`transfer` 會使用該設定檔的工作階段，執行完整的建立／更新／驗證流程。程式不會讀取或匯出瀏覽器 Cookie、本機儲存空間或密碼。

`mapping:adopt` 用於登記在連接器建立前已經建立的全球服攻略。下次轉移時，系統會先驗證該攻略，並在需要時原地更新，而不會建立重複攻略。

預設情況下，瀏覽器設定檔及來源至全球服的對照資料會儲存在儲存庫之外：

```text
~/.hsr-currency-war-transfer/browser-profile
~/.hsr-currency-war-transfer/transfers.json
```

可使用 `CURRENCY_WAR_PROFILE_DIR` 及 `CURRENCY_WAR_STATE_PATH`，或 `--profile-dir` 及 `--state` 命令選項覆寫這些位置。

## 轉移規則

- 讀取中國服標題已選的兩個羈絆，將其穩定特性 ID 對應至全球服 `zh-tw` 名稱，然後重建前綴，例如 `【6战技点4命运圣杯】` → `【6戰技點4命運聖杯】`。
- 保留其餘中文標題及營運概念原文。
- 只有在標題不超過 60 個字元時，才加入 `｜作者名稱`。
- 只有在營運概念不超過 800 個字元時，才加入 `來源：作者名稱`。
- 忽略全球服無法使用的 ID，並在 `ignored` 中回傳所有略過項目。
- 若已對應的全球服攻略仍與來源相同，回傳其現有攻略碼。
- 若來源已變更，原地編輯已對應的攻略。
- 若不存在有效對照，建立新攻略。
- 回傳成功前，重新擷取並比較已發布的資料。
- 除玩法欄位外，亦驗證完整重建後的標題前綴。
- 依序執行本機發布工作，避免重複請求造成競爭情況。

部署及帳號操作詳情請參閱 [docs/admin-connector.md](docs/admin-connector.md)。

## 第一方端點

中國服基礎網址：

`https://act-api-takumi.miyoushe.com/event/rpgcurrencywar`

全球服基礎網址：

`https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar`

讀取操作：

- `GET /game/config?game=hkrpg`
- `POST /game/lineup/index`
- `GET /game/lineup/detail?id={id}&game=hkrpg`

需要全球服身分驗證的寫入操作：

- `POST /game/lineup/create_lineup_tourn`
- `POST /game/lineup/edit`

以上為第一方網頁應用程式端點，並非有正式文件的公開 API，可能隨時變更。
