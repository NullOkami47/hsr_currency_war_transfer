import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("../scripts/vm-hoyolab-login.sh", import.meta.url),
);

test("VM login script uses a temporary HTTPS path and local-only VNC ports", async () => {
  const script = await readFile(scriptPath, "utf8");

  assert.match(script, /LOGIN_PATH=.*openssl rand/);
  assert.match(script, /handle_path \/\$LOGIN_PATH\/\*/);
  assert.match(script, /127\.0\.0\.1:\$NOVNC_PORT/);
  assert.match(script, /-localhost -forever -shared/);
  assert.match(script, /systemctl stop "\$WORKER_SERVICE"/);
  assert.match(script, /systemctl start "\$WORKER_SERVICE"/);
  assert.match(script, /restore_caddy/);
  assert.doesNotMatch(script, /az network nsg|ufw allow|0\.0\.0\.0:\$NOVNC_PORT/i);
});

test("VM login status does not reveal the VNC password", async () => {
  const script = await readFile(scriptPath, "utf8");
  const statusBody = script.slice(
    script.indexOf("show_status()"),
    script.indexOf("stop_login()"),
  );

  assert.match(statusBody, /intentionally not shown again/);
  assert.doesNotMatch(statusBody, /cat .*vnc\.pass|VNC_PASSWORD=/);
});
