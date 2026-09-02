<div align="center">

# HSR Currency War Transfer

🌌 **Find China strategies and transfer them safely to Global**

<p align="center">
  <strong>English</strong> |
  <a href="./README.md">繁體中文</a> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/NullOkami47/hsr_currency_war_transfer?color=brightgreen" alt="MIT Licence"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20 or later">
  <a href="https://hsrcurrencywartransfervercel.vercel.app/"><img src="https://img.shields.io/badge/Vercel-Open%20App-000000?logo=vercel" alt="Vercel deployment"></a>
</p>

<p align="center">
  <a href="https://hsrcurrencywartransfervercel.vercel.app/"><strong>Open App</strong></a> •
  <a href="#-key-features">Key Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-deployment-and-administration">Deployment</a> •
  <a href="#-documentation">Documentation</a>
</p>

</div>

## 📝 Project Description

This project provides the transfer core and a local, administrator-managed publishing connector for moving *Honkai: Star Rail* Currency War strategies from the China service to the Global service.

Users can look up an exact China strategy URL or ID, or filter candidates by title, author, characters and Bonds. Once a strategy is confirmed, an administrator publishing worker creates or updates its Global version and returns the strategy code and official link.

> [!IMPORTANT]
> This is an unofficial tool. Source strategy text remains unchanged. Items unavailable on Global are skipped and clearly reported in the result.

---

## 🌐 Online Access

<div align="center">

### [Open Currency War Strategy Transfer](https://hsrcurrencywartransfervercel.vercel.app/)

`https://hsrcurrencywartransfervercel.vercel.app/`

</div>

Search and candidate selection do not require sign-in. Publishing is handled by a separate administrator worker. If that service is not connected, search and selection remain available while submission displays a clear unavailable state.

---

## ✨ Key Features

| Feature | Description |
| --- | --- |
| 🔎 Flexible search | Exact China URL/ID lookup plus title, author, character and Bond filters |
| 🔗 Cross-region conversion | Allow-listed China payload conversion with cross-region game-data ID handling |
| 🛡️ Secure publishing | Creates or edits through the official Global web UI without exporting cookies, passwords or browser storage |
| ✅ Post-publish verification | Re-fetches and normalises the Global strategy, then compares gameplay fields and the complete title prefix |
| ♻️ Create or update in place | Updates mapped strategies when needed instead of creating duplicates |
| 🌓 Multilingual interface | Traditional Chinese, Simplified Chinese and English with light and dark themes |
| 🕘 Local submission history | Keeps up to 50 completed records in the browser for later access to codes and official links |
| ⚙️ Administrator console | Controls public submission, blacklist, rate limits, quotas, queue capacity and record retention |

### Verified Scope

- ✅ Anonymous reads from the China and Global services
- ✅ Cross-region game-data ID compatibility
- ✅ Allow-listed payload transformation
- ✅ Authenticated create and edit through the official Global web UI
- ✅ Browser-session publisher that does not export cookies
- ✅ Post-publish gameplay verification against the China source

The test strategy's gameplay payload exactly matches the China source. The local publisher is implemented and unit-tested; live publishing still requires the administrator to sign in to its dedicated Chrome profile. See the [feasibility study](docs/feasibility-spike.md) for evidence, root-cause analysis and remaining risks.

---

## 🚀 Quick Start

### Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 20 or later |
| Browser | Chrome, required only for administrator sign-in and publishing |
| Operating system | Any platform supported by Node.js for the local site and search tools |

### Start the Local Website

```powershell
git clone https://github.com/NullOkami47/hsr_currency_war_transfer.git
cd hsr_currency_war_transfer
npm install
npm run dev
```

Then open `http://127.0.0.1:4173`.

### Start the Complete Local Service

```powershell
# Sign in when setting up or changing the publishing account
npm run connector:login

# Start both the website and authenticated worker
npm run local:start

# Stop both background processes
npm run local:stop
```

<details>
<summary><strong>View all common commands</strong></summary>

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

- `probe`: reads and transforms data without writing.
- `diff:live`: re-fetches both strategies and compares gameplay data, exiting non-zero on any difference.
- `mapping:adopt`: registers a pre-existing Global strategy for later in-place verification and updates.
- `transfer`: runs the complete create, update and verify flow through the administrator's dedicated Chrome profile.

</details>

The browser profile and source-to-Global mapping are stored outside the repository by default:

```text
~/.hsr-currency-war-transfer/browser-profile
~/.hsr-currency-war-transfer/transfers.json
```

Override these locations with `CURRENCY_WAR_PROFILE_DIR`, `CURRENCY_WAR_STATE_PATH`, or the matching `--profile-dir` and `--state` command options.

---

## 🚢 Deployment and Administration

Configure these server-side environment variables on Vercel to connect public submissions to the separate authenticated publishing worker and enable the `/admin` console:

| Environment variable | Purpose |
| --- | --- |
| `CURRENCY_WAR_WORKER_URL` | URL of the external publishing worker |
| `CURRENCY_WAR_WORKER_TOKEN` | Authentication token shared by the Vercel API and worker |
| `CURRENCY_WAR_ADMIN_TOKEN` | Independent administrator-console authentication setting |

Run the worker with the same token on the administrator machine or a persistent VM:

```powershell
npm run worker
```

The website creates a job, polls it through the Vercel API, and returns the Global strategy code and official link. The browser never receives the worker token or HoYoLAB session. Active duplicate requests for one China strategy share a job; completed duplicates run the existing create, update or unchanged comparison.

> [!TIP]
> Without these variables, search and candidate selection continue to work; only strategy submission is disabled.

See [`.env.example`](.env.example), the [administrator publishing connector](docs/admin-connector.md), and the [administrator login and 2FA guide](docs/admin-login.md) for complete configuration.

---

## 🔄 Transfer Rules

<details>
<summary><strong>View the complete transfer and verification rules</strong></summary>

- Read the two Bonds selected in the China title, map their stable trait IDs to Global `zh-tw` names, and rebuild the prefix, for example `【6战技点4命运圣杯】` → `【6戰技點4命運聖杯】`.
- Preserve the remaining Chinese title and operation text.
- Add `｜作者名稱` only when the title remains within 60 characters.
- Add `來源：作者名稱` only when the operation text remains within 800 characters.
- Ignore IDs unavailable on Global and return every omission in `ignored`.
- Return the existing code when the mapped Global strategy still matches.
- Edit the mapped strategy in place when its source changes.
- Create a new strategy when no valid mapping exists.
- Re-fetch and compare published data before returning success.
- Verify gameplay fields and the complete rebuilt title prefix.
- Serialise local publishing jobs to prevent races between duplicate requests.

</details>

---

## 📚 Documentation

| Document | Contents |
| --- | --- |
| [Feasibility study](docs/feasibility-spike.md) | Verification evidence, root-cause analysis and remaining risks |
| [Administrator publishing connector](docs/admin-connector.md) | Local and production deployment, account operations and security boundaries |
| [Administrator login and 2FA](docs/admin-login.md) | Password setup, Google Authenticator, rotation and recovery |
| [Search and transfer API](docs/search-api.md) | Vercel Functions request and response contracts |
| [VM HoYoLAB login](docs/vm-hoyolab-login.md) | VM device identity, sign-in procedure and troubleshooting |
| [Security policy](SECURITY.md) | Vulnerability reporting and security guidance |

---

## 🔌 First-Party Endpoints

<details>
<summary><strong>View China and Global endpoints</strong></summary>

**China base URL**

`https://act-api-takumi.miyoushe.com/event/rpgcurrencywar`

**Global base URL**

`https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar`

**Read operations**

- `GET /game/config?game=hkrpg`
- `POST /game/lineup/index`
- `GET /game/lineup/detail?id={id}&game=hkrpg`

**Authenticated Global write operations**

- `POST /game/lineup/create_lineup_tourn`
- `POST /game/lineup/edit`

> [!WARNING]
> These are first-party web application endpoints, not a documented public API. They may change without notice.

</details>

---

## Licence

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">

### 💫 Thank You for Using Currency War Strategy Transfer

**[Open App](https://hsrcurrencywartransfervercel.vercel.app/)** • **[Report an Issue](https://github.com/NullOkami47/hsr_currency_war_transfer/issues)** • **[Source Code](https://github.com/NullOkami47/hsr_currency_war_transfer)**

<sub>Made for Trailblazers. Not affiliated with HoYoverse or miHoYo.</sub>

### 🔗 Friendly Link

Thanks to [Linux Do](https://linux.do/)

</div>
