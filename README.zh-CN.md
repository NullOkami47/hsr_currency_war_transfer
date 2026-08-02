# 崩坏：星穹铁道「货币战争」攻略转移工具

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文**

此仓库包含攻略转移核心，以及一个由管理员管理的本地发布连接器，用于将「货币战争」攻略从中国服复制到全球服。

目前已验证：

- 中国服及全球服的匿名读取；
- 跨服务器游戏数据 ID 兼容性；
- 以允许列表控制的数据转换；
- 通过全球服官方网页界面进行已验证身份的创建／编辑操作；
- 不会导出 Cookie、以程序控制浏览器会话的发布器；以及
- 发布后与中国服来源进行玩法数据验证。

测试攻略的玩法数据与中国服来源完全一致。本地发布器已完成并通过单元测试；如需实际发布，管理员须登录其专用 Chrome 配置文件。

证据、根本原因分析及剩余风险请参阅 [docs/feasibility-spike.md](docs/feasibility-spike.md)。

## 运行方式

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

`npm run dev` 会在 `http://127.0.0.1:4173` 启动本地网站。网站支持以中国服 URL／ID 精确查找、以攻略名称及作者搜索、角色多选 AND 筛选、候选攻略选择及提交转移，并提供浅色与深色模式。界面文字及角色名称支持繁体中文、简体中文及英文；来源攻略文字会保持不变。

`npm run local:start` 会使用内存中的随机令牌，同时在 localhost 启动网站及已验证身份的 worker。`npm run local:stop` 会停止这两个后台进程。需要更改已保存的 HoYoLAB 会话或发布账号时，请先运行 `npm run connector:login`。

在 Vercel 上，将 `CURRENCY_WAR_WORKER_URL`、`CURRENCY_WAR_WORKER_TOKEN` 及独立的 `CURRENCY_WAR_ADMIN_TOKEN` 设置为服务器端环境变量，即可将提交按钮连接至独立的已验证发布 worker，并启用 `/admin` 管理页。请在管理员电脑或持续运行的 VM 上，以相同 worker 令牌运行 `npm run worker`。网站会创建任务，通过 Vercel API 轮询进度，再返回全球服攻略码；浏览器不会接触 worker 令牌或 HoYoLAB 会话。同一篇中国服攻略的重复进行中请求会共用一项任务；已完成的重复请求则会执行现有的创建／更新／不变比较流程。

如果没有设置这些变量，搜索及候选选择仍可正常使用；提交转移时会清楚显示服务尚未连接。完整的本地及生产环境设置请参阅 `.env.example` 与 [docs/admin-connector.md](docs/admin-connector.md)。

管理员登录 `/admin` 后，可以查看发布记录及状态，并调整公开提交开关、来源攻略 allow-list、每 IP 限流、发布账号每日配额、等待中任务上限及记录保留策略。公开提交默认关闭，allow-list 默认开启且为空；管理员必须明确设置策略后才会接受公开转移。此处的“每账号”是指每个 worker 所使用的单一全球服发布账号。

`probe` 只会读取及转换数据，不会写入。`diff:live` 会重新获取两边已发布的攻略，使用相同转换器将其标准化；如果任何玩法字段不同，便以非零状态结束。

`search` 可接受中国服攻略 URL／ID 进行精确查找，也可按照攻略名称、作者显示名称及多个角色 ID，在有限范围内搜索中国服推荐列表。筛选采用 AND 逻辑；每个已选角色都必须出现在候选攻略内。使用 `--list-roles` 可获取当前可见的中国服角色列表及 ID。搜索结果只包含可安全显示的候选数据，不会包含作者账号识别数据。

相同功能也以 Vercel Functions 的 `GET /api/roles` 及 `POST /api/search` 提供。请参阅 [docs/search-api.md](docs/search-api.md) 了解请求及响应格式。

`connector:login` 会打开专用 Chrome 配置文件。管理员可以随时在该窗口登录、退出或更换发布账号，然后关闭窗口。`transfer` 会使用该配置文件的会话，执行完整的创建／更新／验证流程。程序不会读取或导出浏览器 Cookie、本地存储空间或密码。

`mapping:adopt` 用于登记在连接器建立前已经创建的全球服攻略。下次转移时，系统会先验证该攻略，并在需要时原地更新，而不会创建重复攻略。

默认情况下，浏览器配置文件及来源至全球服的映射数据会保存在仓库之外：

```text
~/.hsr-currency-war-transfer/browser-profile
~/.hsr-currency-war-transfer/transfers.json
```

可使用 `CURRENCY_WAR_PROFILE_DIR` 及 `CURRENCY_WAR_STATE_PATH`，或 `--profile-dir` 及 `--state` 命令选项覆盖这些位置。

## 转移规则

- 读取中国服标题已选的两个羁绊，将其稳定特性 ID 映射至全球服 `zh-tw` 名称，然后重建前缀，例如 `【6战技点4命运圣杯】` → `【6戰技點4命運聖杯】`。
- 保留其余中文标题及运营思路原文。
- 只有在标题不超过 60 个字符时，才加入 `｜作者名称`。
- 只有在运营思路不超过 800 个字符时，才加入 `来源：作者名称`。
- 忽略全球服无法使用的 ID，并在 `ignored` 中返回所有跳过项目。
- 如果已映射的全球服攻略仍与来源相同，返回其现有攻略码。
- 如果来源已更改，原地编辑已映射的攻略。
- 如果不存在有效映射，创建新攻略。
- 返回成功前，重新获取并比较已发布的数据。
- 除玩法字段外，也验证完整重建后的标题前缀。
- 依次执行本地发布任务，避免重复请求造成竞态条件。

部署及账号操作详情请参阅 [docs/admin-connector.md](docs/admin-connector.md)。

## 第一方端点

中国服基础网址：

`https://act-api-takumi.miyoushe.com/event/rpgcurrencywar`

全球服基础网址：

`https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar`

读取操作：

- `GET /game/config?game=hkrpg`
- `POST /game/lineup/index`
- `GET /game/lineup/detail?id={id}&game=hkrpg`

需要全球服身份验证的写入操作：

- `POST /game/lineup/create_lineup_tourn`
- `POST /game/lineup/edit`

以上为第一方网页应用程序端点，并非有正式文档的公开 API，可能随时更改。
