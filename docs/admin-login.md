# Admin login, password and two-factor authentication

**English** | [简体中文](admin-login.zh-CN.md) | [繁體中文](admin-login.zh-TW.md)

This guide explains how to open `/admin`, set or change the administrator
password, and enable TOTP two-factor authentication (2FA) with Google
Authenticator. Real passwords, password hashes, TOTP setup keys and worker
tokens are secrets. Never put them in Git, a README, an issue, a chat message or
client-side code.

## Sign in to the admin page

1. Open the production website URL and append `/admin`, for example
   `https://<your-domain>/admin`.
2. Enter the administrator password.
3. If the page shows an **Authenticator code** field, enter the current
   six-digit code from Google Authenticator.
4. Select **Sign in**. When finished, select **Sign out**, especially on a
   shared computer.

A successful session lasts for up to eight hours. The session cookie is
HTTP-only and SameSite=Strict. Browser local storage never stores the password,
TOTP code or worker token.

## Set or change the administrator password

In production, store a PBKDF2-SHA256 password hash in Vercel instead of the
plain-text password. Use a password manager to generate at least 16 random
characters, or use a unique passphrase of at least 20 characters. Do not reuse
your Vercel, GitHub, email or HoYoLAB password.

### 1. Generate the password hash locally

Open PowerShell in the project directory and run the following commands. The
password is hidden while you type it. The final `pbkdf2_sha256$...` line is the
value to put in Vercel; it is not the password you will enter on the admin page.

```powershell
$securePassword = Read-Host "Enter the new administrator password" -AsSecureString
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

Each run generates a different salt, so the same password produces a different
hash. This is expected.

### 2. Store the hash in Vercel

1. Open the Vercel project's **Settings → Environment Variables** page.
2. Add or update `CURRENCY_WAR_ADMIN_PASSWORD_HASH` with the complete
   `pbkdf2_sha256$...` output from the previous step.
3. Mark it as Sensitive if that option is available, and apply it to at least
   **Production**. Add it to Preview or Development only if those environments
   also need an admin page.
4. If you have switched to a password hash, remove the unused
   `CURRENCY_WAR_ADMIN_TOKEN` so that an old token cannot still sign in.
5. Redeploy Production. Vercel environment-variable changes do not apply to
   previous deployments.
6. Sign in to `/admin` with the new password. Do not paste the
   `pbkdf2_sha256$...` hash into the password field.

See Vercel's [environment-variable documentation](https://vercel.com/docs/environment-variables)
for its current environment and deployment behaviour.

After the new hash is deployed, the old password and administrator sessions
signed with the old credential no longer work.

> `CURRENCY_WAR_ADMIN_TOKEN` remains available as a compatibility credential
> or for local testing, but a production value must contain at least 32
> characters. Never make it the same as `CURRENCY_WAR_WORKER_TOKEN`.

## Enable Google Authenticator 2FA

This feature uses RFC 6238 TOTP. Every new administrator session requires both
the password and a time-based six-digit code.

### 1. Generate an independent TOTP setup key

Run this command in the project directory:

```powershell
npm run admin:totp:generate
```

The command prints an account name, a grouped setup key and the key type. Treat
the setup key like the master secret for the second factor. Never commit it to
Git or send it to an online QR-code generator.

### 2. Add it to Google Authenticator

1. Select **+** in Google Authenticator.
2. Select **Enter a setup key**.
3. Enter `Currency War Admin` as the account name.
4. Enter the setup key generated in the previous step.
5. Select **Time based** as the key type.

For recovery, you may keep the setup key in an encrypted secure note in a
trusted password manager. Anyone who obtains it can generate valid codes, so do
not keep it in a plain-text file, screenshot or email.

### 3. Store the TOTP key in Vercel

1. In Vercel **Settings → Environment Variables**, add or update
   `CURRENCY_WAR_ADMIN_TOTP_SECRET`.
2. Use the complete setup key without spaces as its value.
3. Mark it as Sensitive and apply it to the same environments as the admin
   page; select at least **Production** for the production website.
4. Redeploy Production.
5. Open `/admin`, confirm that it requests both the password and a six-digit
   Authenticator code, and complete one real sign-in.

Enabling or rotating the TOTP key invalidates old administrator sessions. A
successfully used code cannot immediately create a second session in the same
running API instance.

## Replace a phone, recover access or reset 2FA

- **You still have the setup key:** add the account to Google Authenticator on
  the new phone using the same key.
- **The key is lost, but you can manage Vercel:** run
  `npm run admin:totp:generate` on a trusted computer, enrol the new key on the
  new phone, update `CURRENCY_WAR_ADMIN_TOTP_SECRET`, and redeploy.
- **You cannot manage Vercel:** there is no 2FA bypass. An authorised owner of
  the Vercel project must rotate the environment variable.

You can disable 2FA by deleting `CURRENCY_WAR_ADMIN_TOTP_SECRET` and
redeploying, but this is not recommended for a public production environment.

## Troubleshooting

### The password and code appear correct, but sign-in fails

1. Ensure that the phone's date, time and time zone use automatic synchronisation.
2. Wait for the next code before trying again, especially if the 30-second
   period is nearly over.
3. Confirm that the Authenticator entry is **Time based**, then enter its current
   six-digit code.
4. Confirm that the Vercel variable names and target environments are correct,
   and that a new deployment was created after the update.
5. Repeated failures can temporarily limit the same client within a single API
   instance. The default is five failed attempts in ten minutes. Stop retrying
   and try again later with a fresh code.

Sign-in failures deliberately return the same message, so they do not reveal
whether the password or 2FA code was wrong. An invalid TOTP setup-key format
fails closed instead of falling back to password-only authentication.

### What can I configure after signing in?

The admin page shows publishing records and job states. It also controls the
public-submission switch, source strategy blacklist, per-IP rate limit,
publishing-account daily quota, pending queue capacity and record-retention
policy. Set suitable policies before enabling public submissions for the first
time.

## Security checklist

- Keep the password, password hash, TOTP key and worker token only in controlled
  environments; never commit them to Git.
- Never reuse values between the password, `CURRENCY_WAR_ADMIN_TOKEN`,
  `CURRENCY_WAR_WORKER_TOKEN` and the TOTP key.
- Keep 2FA enabled in production, and enable multi-factor authentication for
  the Vercel and GitHub accounts themselves.
- After changing the password or TOTP key, redeploy and complete one real test
  sign-in with the new credentials.
- If any credential may have leaked, rotate the relevant environment variable
  immediately. Changing documentation or the front-end is not sufficient.

For the complete worker, HoYoLAB publishing-account and safety-policy setup,
see the [admin publishing connector](admin-connector.md).
