import { generateTotpSecret } from "../src/totp.mjs";

const secret = generateTotpSecret();
const grouped = secret.match(/.{1,4}/g).join(" ");

console.log("Google Authenticator manual setup");
console.log("Account: Currency War Admin");
console.log(`Setup key: ${grouped}`);
console.log("Type: Time based");
console.log("");
console.log("Store the unspaced setup key as CURRENCY_WAR_ADMIN_TOTP_SECRET.");
console.log("Never commit it or paste it into browser JavaScript.");
