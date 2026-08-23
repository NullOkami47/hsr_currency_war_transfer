import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("../scripts/vm-hoyolab-login.sh", import.meta.url),
);
const metadataHelperPath = fileURLToPath(
  new URL("../scripts/caddy-file-metadata.sh", import.meta.url),
);
const execFileAsync = promisify(execFile);

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

test("VM login uses captured Caddy mode, owner and group for every restore", async () => {
  const [script, helper] = await Promise.all([
    readFile(scriptPath, "utf8"),
    readFile(metadataHelperPath, "utf8"),
  ]);

  assert.match(script, /caddy-file-metadata\.sh/);
  assert.match(script, /capture_file_metadata "\$CADDYFILE"/);
  assert.match(
    script,
    /install_file_with_metadata \\\s+"\$RUNTIME_DIR\/Caddyfile\.new" \\\s+"\$CADDYFILE"/,
  );
  assert.match(script, /restore_file_metadata/);
  assert.doesNotMatch(script, /install -m 0644 .*Caddyfile\.backup/);
  assert.doesNotMatch(script, /install -m 0644 .*"\$CADDYFILE"/);
  assert.match(helper, /stat -c '%a %u %g'/);
  assert.match(helper, /install_file_with_metadata\(\)/);
  assert.match(helper, /install -m "\$mode" -o "\$owner" -g "\$group"/);
});

test("Caddy metadata helper preserves live and restored file metadata", {
  skip: process.platform === "win32" ? "POSIX ownership is not available on Windows" : false,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "caddy-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const mode of [0o600, 0o640]) {
    const original = join(directory, `Caddyfile-${mode.toString(8)}`);
    const backup = `${original}.backup`;
    const replacement = `${original}.new`;
    const metadata = `${original}.metadata`;
    await writeFile(original, "original\n", { mode });
    await chmod(original, mode);
    const originalStat = await stat(original);

    await execFileAsync("sh", [metadataHelperPath, "capture", original, metadata]);
    await writeFile(backup, "original\n", { mode: 0o600 });
    await writeFile(replacement, "temporary\n", { mode: 0o600 });
    await execFileAsync("sh", [
      metadataHelperPath,
      "install",
      replacement,
      original,
      metadata,
    ]);

    const liveStat = await stat(original);
    assert.equal(liveStat.mode & 0o777, mode);
    assert.equal(liveStat.uid, originalStat.uid);
    assert.equal(liveStat.gid, originalStat.gid);
    assert.equal(await readFile(original, "utf8"), "temporary\n");

    await execFileAsync("sh", [metadataHelperPath, "restore", backup, original, metadata]);
    const restoredStat = await stat(original);
    assert.equal(restoredStat.mode & 0o777, mode);
    assert.equal(restoredStat.uid, originalStat.uid);
    assert.equal(restoredStat.gid, originalStat.gid);
    assert.equal(await readFile(original, "utf8"), "original\n");
  }
});
