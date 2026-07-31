import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("maps role costs to the agreed portrait colours in both themes", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const lightTheme = css.match(/:root\s*{([\s\S]*?)\n}/)?.[1] ?? "";
  const darkTheme = css.match(/html\[data-theme="dark"\]\s*{([\s\S]*?)\n}/)?.[1] ?? "";

  assert.match(lightTheme, /--colour-cost-2:\s*#4f9179;/);
  assert.match(lightTheme, /--colour-cost-3:\s*#5f73a8;/);
  assert.match(lightTheme, /--colour-cost-5:\s*#b58a3a;/);
  assert.match(darkTheme, /--colour-cost-2:\s*#38725f;/);
  assert.match(darkTheme, /--colour-cost-3:\s*#485d91;/);
  assert.match(darkTheme, /--colour-cost-5:\s*#8a692d;/);
});
