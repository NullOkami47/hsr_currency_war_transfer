# 管理员页面登录、密码与两步验证设置

[English](admin-login.md) | **简体中文** | [繁體中文](admin-login.zh-TW.md)

本指南说明如何打开 `/admin`、设置或更改管理员密码，以及使用 Google
Authenticator 启用 TOTP 两步验证（2FA）。实际密码、密码哈希、TOTP
设置密钥及 worker 令牌都属于机密信息，不得写入 Git、README、Issue、聊天消息或前端代码。

## 登录管理员页面

1. 打开生产网站网址，并在末尾加上 `/admin`，例如
   `https://<你的域名>/admin`。
2. 输入管理员密码。
3. 如果页面显示“验证器代码”字段，输入 Google Authenticator 当前显示的
   6 位数字代码。
4. 点击“登录”。使用完毕后请点击“退出登录”，共用电脑尤其如此。

登录成功后，会话最长保持 8 小时。登录 Cookie 使用 HTTP-only 和
SameSite=Strict；浏览器本地存储不会保存密码、TOTP 代码或 worker 令牌。

## 设置或更改管理员密码

生产环境建议只在 Vercel 中存储 PBKDF2-SHA256 密码哈希，而不是明文密码。
请使用密码管理器生成至少 16 个随机字符，或使用至少 20 个字符的独特密码短语；
不要重复使用 Vercel、GitHub、邮箱或 HoYoLAB 密码。

### 1. 在本地生成密码哈希

在 PowerShell 中进入项目目录，然后执行以下命令。输入内容不会显示在屏幕上；最后一行
输出的 `pbkdf2_sha256$...` 才是需要粘贴到 Vercel 的值，而不是原始密码。

```powershell
$securePassword = Read-Host "输入新的管理员密码" -AsSecureString
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

每次执行都会产生不同的 salt，因此相同密码也会得到不同哈希，这是正常现象。

### 2. 将哈希存储到 Vercel

1. 打开 Vercel 项目的 **Settings → Environment Variables**。
2. 新增或更新 `CURRENCY_WAR_ADMIN_PASSWORD_HASH`，值为上一步完整输出的
   `pbkdf2_sha256$...`。
3. 如果界面提供 Sensitive 选项，请将其启用，并至少应用到 **Production**。
   只有 Preview 或 Development 也需要管理员页面时，才将同一变量加入这些环境。
4. 如果已经改用密码哈希，请移除不再需要的 `CURRENCY_WAR_ADMIN_TOKEN`，
   避免旧令牌仍然可以登录。
5. 重新部署 Production。Vercel 环境变量更改不会应用到之前的部署。
6. 使用新密码登录 `/admin`；不要把 `pbkdf2_sha256$...` 哈希粘贴到密码字段。

关于环境范围及部署行为，请参阅 Vercel 的
[环境变量官方文档](https://vercel.com/docs/environment-variables)。

新哈希完成部署后，旧密码及使用旧凭据签发的管理员会话将失效。

> `CURRENCY_WAR_ADMIN_TOKEN` 仍可作为兼容方式或本地测试凭据，但生产环境的值必须
> 至少有 32 个字符。不要把它与 `CURRENCY_WAR_WORKER_TOKEN` 设置成相同值。

## 启用 Google Authenticator 两步验证

此功能使用 RFC 6238 TOTP：每次建立新的管理员会话时，除了密码外还需要一组
随时间变化的 6 位数字代码。

### 1. 生成独立的 TOTP 设置密钥

在项目目录执行：

```powershell
npm run admin:totp:generate
```

命令会显示账户名称、分组后的设置密钥及类型。此密钥相当于第二因素的主密钥；
不要提交到 Git，也不要发送给在线二维码生成器。

### 2. 加入 Google Authenticator

1. 在 Google Authenticator 中点击“＋”。
2. 选择“输入设置密钥”。
3. 账户名称输入 `Currency War Admin`。
4. 输入刚才生成的设置密钥。
5. 密钥类型选择“基于时间”。

如需恢复能力，可将设置密钥保存在可信密码管理器的加密安全笔记中。任何获得此密钥
的人都能生成有效代码，因此不要用普通文本文件、截图或邮件保存。

### 3. 将 TOTP 密钥存储到 Vercel

1. 在 Vercel **Settings → Environment Variables** 中新增或更新
   `CURRENCY_WAR_ADMIN_TOTP_SECRET`。
2. 值使用不含空格的完整设置密钥。
3. 将它标记为 Sensitive，并应用到与管理员页面相同的环境；生产网站至少选择
   **Production**。
4. 重新部署 Production。
5. 打开 `/admin`，确认页面同时要求密码和 6 位数字验证器代码，并实际登录一次。

启用或轮换 TOTP 密钥会使旧管理员会话失效。成功使用过的同一组代码不能在同一个
运行中的 API instance 内立即建立第二个会话。

## 更换手机、丢失手机或重置 2FA

- **仍保留设置密钥：** 在新手机的 Google Authenticator 中用同一密钥重新添加账户。
- **密钥已丢失，但仍可管理 Vercel：** 在可信电脑重新执行
  `npm run admin:totp:generate`，先在新手机添加新密钥，再更新
  `CURRENCY_WAR_ADMIN_TOTP_SECRET` 并重新部署。
- **无法管理 Vercel：** 系统没有绕过 2FA 的后门；需要由获授权的 Vercel 项目所有者
  协助轮换环境变量。

如要停用 2FA，可以删除 `CURRENCY_WAR_ADMIN_TOTP_SECRET` 后重新部署，但不建议在
公开生产环境中这样做。

## 常见问题

### 密码和代码正确，但仍然无法登录

1. 确认手机日期、时间及时区使用自动同步。
2. 等待下一组代码后再尝试，避免在 30 秒周期即将结束时提交。
3. 确认 Authenticator 条目类型是“基于时间”，并输入当前的 6 位数字代码。
4. 确认 Vercel 变量名称及应用环境正确，并且更新后已经创建新部署。
5. 连续失败后，同一客户端在单个 API instance 内可能暂时受限；默认是 10 分钟内
   最多 5 次失败。请停止重试，稍后再使用全新的代码登录。

登录失败会刻意返回相同消息，不会指出是密码还是 2FA 错误。如果 TOTP 设置密钥格式
无效，管理员登录会安全地停止服务，而不是退回为只验证密码。

### 登录后可以设置什么？

管理员页面可以查看发布记录及任务状态，并调整公开提交开关、来源攻略封锁列表（blacklist）、
每 IP 限流、发布账户每日配额、等待中任务上限及记录保留策略。首次启用前，请先
设置合适策略，再开启公开提交。

## 安全检查清单

- 密码、密码哈希、TOTP 密钥及 worker 令牌只存储在受控环境中，不提交到 Git。
- 密码、`CURRENCY_WAR_ADMIN_TOKEN`、`CURRENCY_WAR_WORKER_TOKEN` 与 TOTP
  密钥不得互相重复使用。
- 生产环境保持 2FA 开启，并为 Vercel 与 GitHub 账户本身启用多因素验证。
- 每次更改密码或 TOTP 密钥后重新部署，并用新凭据实际测试一次。
- 如果怀疑任何凭据泄漏，立即轮换相应环境变量；只修改文档或前端页面并不足够。

完整的 worker、HoYoLAB 发布账户及安全策略设置请参阅
[管理员发布连接器](admin-connector.md)。
