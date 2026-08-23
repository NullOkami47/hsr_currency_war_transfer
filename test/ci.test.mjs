import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CI verifies supported Node versions on Linux and Windows", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /pull_request:\s*\n\s+branches: \[main\]/);
  assert.match(workflow, /push:\s*\n\s+branches: \[main\]/);
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /node-version: \[20, 22\]/);
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm audit --audit-level=high/);
  assert.match(workflow, /runner\.os == 'Linux'/);
});
