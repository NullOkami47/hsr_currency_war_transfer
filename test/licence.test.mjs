import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("repository publishes the owner-selected MIT licence", async () => {
  const [licence, packageJson, root, english, simplified, traditional] =
    await Promise.all([
      readFile(new URL("../LICENSE", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8")
        .then(JSON.parse),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../README.en.md", import.meta.url), "utf8"),
      readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8"),
      readFile(new URL("../README.zh-TW.md", import.meta.url), "utf8"),
    ]);

  assert.match(licence, /^MIT License\s/);
  assert.match(licence, /Copyright \(c\) 2026 NullOkami47/);
  assert.match(licence, /Permission is hereby granted, free of charge/);
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "MIT");
  assert.match(root, /<strong>繁體中文<\/strong>/);
  assert.match(root, /## 📜 授權條款\s+[\s\S]*\[MIT 授權條款\]\(LICENSE\)/);
  assert.match(english, /## Licence\s+[\s\S]*\[MIT License\]\(LICENSE\)/);
  assert.match(simplified, /## 许可证\s+[\s\S]*\[MIT 许可证\]\(LICENSE\)/);
  assert.match(traditional, /## 授權條款\s+[\s\S]*\[MIT 授權條款\]\(LICENSE\)/);
});
