<div align="center">

# 崩坏：星穹铁道「货币战争」攻略转移工具

🌌 **搜索中国服攻略，安全转移至全球服**

<p align="center">
  <a href="./README.en.md">English</a> |
  <a href="./README.md">繁體中文</a> |
  <strong>简体中文</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/NullOkami47/hsr_currency_war_transfer?color=brightgreen" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20 或更新版本">
  <a href="https://hsrcurrencywartransfervercel.vercel.app/"><img src="https://img.shields.io/badge/Vercel-%E5%9C%A8%E7%BA%BF%E4%BD%BF%E7%94%A8-000000?logo=vercel" alt="Vercel 在线版本"></a>
</p>

<p align="center">
  <a href="https://hsrcurrencywartransfervercel.vercel.app/"><strong>立即使用</strong></a> •
  <a href="#-功能特色">功能特色</a> •
  <a href="#-快速开始">快速开始</a> •
  <a href="#-部署与管理">部署与管理</a> •
  <a href="#-文档">文档</a>
</p>

</div>

## 📝 项目介绍

本项目提供攻略转移核心与由管理员管理的本地发布连接器，用于将《崩坏：星穹铁道》「货币战争」攻略从中国服转移至全球服。

用户可以通过中国服攻略 URL／ID 精确查找，或按攻略名称、作者、角色及羁绊筛选候选攻略。确认内容后，系统会交由管理员的发布 worker 创建或更新全球服版本，并返回攻略码与官方链接。

> [!IMPORTANT]
> 这是非官方工具。来源攻略文本会保留原文；全球服无法对应的项目会被跳过，并在结果中明确列出。

---

## 🌐 在线使用

<div align="center">

### [打开「货币战争」攻略转移工具](https://hsrcurrencywartransfervercel.vercel.app/)

`https://hsrcurrencywartransfervercel.vercel.app/`

</div>

搜索与候选攻略选择无需登录。攻略发布由独立的管理员 worker 执行；如果服务尚未连接，网站仍可搜索及选择攻略，提交时则会显示服务不可用状态。

---

## ✨ 功能特色

| 功能 | 说明 |
| --- | --- |
| 🔎 多种搜索方式 | 支持中国服 URL／ID 精确查找，以及攻略名称、作者、角色与羁绊筛选 |
| 🔗 跨服数据转换 | 通过允许列表转换中国服数据，并处理跨区游戏数据 ID |
| 🛡️ 安全发布流程 | 通过全球服官方网页界面创建或编辑，不导出 Cookie、密码或浏览器存储数据 |
| ✅ 发布后验证 | 重新获取全球服攻略，标准化后比较玩法字段与完整标题前缀 |
| ♻️ 创建或原地更新 | 已映射的攻略会在需要时更新，避免重复创建 |
| 🌓 多语言界面 | 支持繁体中文、简体中文与英文，并提供浅色及深色模式 |
| 🕘 本地提交记录 | 在浏览器保留最多 50 条完成记录，方便再次获取攻略码与官方链接 |
| ⚙️ 管理员控制台 | 提供公开提交开关、黑名单、限流、配额、队列及记录保留设置 |

### 已验证范围

- ✅ 中国服及全球服匿名读取
- ✅ 跨服务器游戏数据 ID 兼容性
- ✅ 由允许列表控制的数据转换
- ✅ 通过全球服官方网页界面创建及编辑攻略
- ✅ 不导出 Cookie 的浏览器会话发布器
- ✅ 发布后与中国服来源进行玩法数据验证

测试攻略的玩法数据与中国服来源完全一致。本地发布器已完成并通过单元测试；实际发布前，管理员仍须登录专用 Chrome 配置文件。验证证据、根本原因分析及剩余风险请参阅[可行性研究](docs/feasibility-spike.md)。

---

## 🚀 快速开始

### 环境要求

| 组件 | 要求 |
| --- | --- |
| Node.js | 20 或更新版本 |
| 浏览器 | Chrome（仅管理员登录及发布流程需要） |
| 操作系统 | 本地网站与搜索工具可在 Node.js 支持的平台运行 |

### 启动本地网站

```powershell
git clone https://github.com/NullOkami47/hsr_currency_war_transfer.git
cd hsr_currency_war_transfer
npm install
npm run dev
```

完成后打开 `http://127.0.0.1:4173`。

### 启动完整本地服务

```powershell
# 首次使用或需要更换发布账号时登录
npm run connector:login

# 同时启动网站与已验证身份的 worker
npm run local:start

# 停止两个后台进程
npm run local:stop
```

<details>
<summary><strong>查看所有常用命令</strong></summary>

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

- `probe`：只读取及转换数据，不会写入。
- `diff:live`：重新获取两边攻略并比较玩法数据；如有差异会以非零状态结束。
- `mapping:adopt`：登记连接器创建前已存在的全球服攻略，供后续原地验证与更新。
- `transfer`：使用管理员专用 Chrome 配置文件执行完整的创建／更新／验证流程。

</details>

默认情况下，浏览器配置文件及来源至全球服的映射数据会存储在仓库之外：

```text
~/.hsr-currency-war-transfer/browser-profile
~/.hsr-currency-war-transfer/transfers.json
```

可使用 `CURRENCY_WAR_PROFILE_DIR`、`CURRENCY_WAR_STATE_PATH`，或对应的 `--profile-dir`、`--state` 命令选项覆盖位置。

---

## 🚢 部署与管理

在 Vercel 上设置以下服务器端环境变量，即可将公开网站的提交功能连接至独立的已验证发布 worker，并启用 `/admin` 管理页面：

| 环境变量 | 用途 |
| --- | --- |
| `CURRENCY_WAR_WORKER_URL` | 外部发布 worker 的网址 |
| `CURRENCY_WAR_WORKER_TOKEN` | Vercel API 与 worker 之间的验证令牌 |
| `CURRENCY_WAR_ADMIN_TOKEN` | 管理员控制台的独立验证设置 |

请在管理员电脑或持续运行的 VM 上，使用相同的 worker 令牌执行：

```powershell
npm run worker
```

网站会创建任务、通过 Vercel API 轮询进度，最后返回全球服攻略码与官方攻略链接。浏览器不会接触 worker 令牌或 HoYoLAB 会话。同一篇中国服攻略的进行中请求会共享一项任务；已完成的重复请求则会执行创建／更新／不变比较流程。

> [!TIP]
> 未设置上述变量时，搜索与候选选择仍可正常使用，只有攻略提交功能会停用。

完整设置请参阅 [`.env.example`](.env.example)、[管理员发布连接器](docs/admin-connector.md)及[管理员登录与 2FA 指南](docs/admin-login.zh-CN.md)。

---

## 🔄 转移规则

<details>
<summary><strong>查看完整转移与验证规则</strong></summary>

- 读取中国服标题已选的两个羁绊，将稳定特性 ID 映射至全球服 `zh-tw` 名称，再重建前缀，例如 `【6战技点4命运圣杯】` → `【6戰技點4命運聖杯】`。
- 保留其余中文标题及运营思路原文。
- 仅在标题不超过 60 个字符时加入 `｜作者名称`。
- 仅在运营思路不超过 800 个字符时加入 `来源：作者名称`。
- 忽略全球服无法使用的 ID，并在 `ignored` 中返回所有跳过项目。
- 如果已映射的全球服攻略仍与来源相同，返回现有攻略码。
- 如果来源已更改，原地编辑已映射的攻略。
- 如果不存在有效映射，创建新攻略。
- 返回成功前重新获取并比较已发布数据。
- 同时验证玩法字段与完整重建后的标题前缀。
- 依次执行本地发布任务，避免重复请求造成竞争状态。

</details>

---

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [可行性研究](docs/feasibility-spike.md) | 验证证据、根本原因分析与剩余风险 |
| [管理员发布连接器](docs/admin-connector.md) | 本地及生产环境部署、账号操作与安全边界 |
| [管理员登录与 2FA](docs/admin-login.zh-CN.md) | 密码设置、Google Authenticator、轮换及恢复 |
| [搜索与转移 API](docs/search-api.md) | Vercel Functions 的请求与响应格式 |
| [VM HoYoLAB 登录](docs/vm-hoyolab-login.md) | VM 设备身份、登录步骤与故障排除 |
| [安全政策](SECURITY.md) | 漏洞报告与安全注意事项 |

---

## 🔌 第一方端点

<details>
<summary><strong>查看中国服及全球服端点</strong></summary>

**中国服基础网址**

`https://act-api-takumi.miyoushe.com/event/rpgcurrencywar`

**全球服基础网址**

`https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar`

**读取操作**

- `GET /game/config?game=hkrpg`
- `POST /game/lineup/index`
- `GET /game/lineup/detail?id={id}&game=hkrpg`

**需要全球服身份验证的写入操作**

- `POST /game/lineup/create_lineup_tourn`
- `POST /game/lineup/edit`

> [!WARNING]
> 以上为第一方网页应用程序端点，并非有正式文档的公开 API，可能随时更改。

</details>

---

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

---

<div align="center">

### 💫 感谢使用「货币战争」攻略转移工具

**[在线使用](https://hsrcurrencywartransfervercel.vercel.app/)** • **[报告问题](https://github.com/NullOkami47/hsr_currency_war_transfer/issues)** • **[查看源代码](https://github.com/NullOkami47/hsr_currency_war_transfer)**

<sub>为开拓者而制作，与 HoYoverse／米哈游没有官方关联。</sub>

### 🔗 友链

感谢 [Linux Do](https://linux.do/)

</div>
