import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BrowserSessionPublisher } from "../src/publisher.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const profileDir = resolve(
  option("--profile-dir") ??
    process.env.CURRENCY_WAR_PROFILE_DIR ??
    join(homedir(), ".hsr-currency-war-transfer", "browser-profile"),
);
const publisher = new BrowserSessionPublisher({ profileDir });

console.log(`Opening the dedicated admin browser profile: ${profileDir}`);
console.log(
  "Sign in, sign out, or switch the HoYoLAB account, then close the browser window.",
);

await publisher.openForLogin();
