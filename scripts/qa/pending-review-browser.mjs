// npm ci && node scripts/qa/pending-review-browser.mjs
// Optional: SCREENSHOT_DIR, BROWSER_EXECUTABLE, BROWSER_CHANNEL (default: chrome).
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const origin = "https://pending-review.test";
const publicDir = new URL("../../public/", import.meta.url);
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const source = "0123456789abcdef01234567";
const candidate = {
  id: source, title: "Synthetic browser QA strategy", author: { nickname: "QA fixture" },
  roles: [], sourceUrl: `${origin}/fixture-source`,
};
const shareCode = "##synthetic-only-browser-qa##";
const globalUrl = "https://act.hoyolab.com/sr/event/currency-wars/index.html?gt__lineup_id=abcdefnwfabcdefnwfabcdef";
const scenarios = [
  { id: "qa-session", results: [{ status: "failed", error: { code: "publishing_session_error" } }] },
  { id: "qa-review", results: [{ status: "queued" }, { status: "failed", error: { code: "publication_pending_review" } }] },
  { id: "qa-retry", results: [{ status: "unchanged", shareCode, globalUrl }] },
];
const copy = {
  "zh-Hant": {
    failure: /失敗|無法完成/,
    created: /已(?:成功)?建立|建立完成/,
    pending: /審核|待公開|尚未公開|等待公開/,
    later: /稍後|晚些|過一段時間|之後/,
    retry: /手動.{0,6}重試|(?:再|重新).{0,5}(?:提交|送出|轉移|重試)|返回.{0,8}重試/,
  },
  "zh-Hans": {
    failure: /失败|无法完成/,
    created: /已(?:成功)?(?:创建|建立)|(?:创建|建立)完成/,
    pending: /审核|待公开|尚未公开|等待公开/,
    later: /稍后|晚些|过一段时间|之后/,
    retry: /手动.{0,6}重试|(?:再|重新).{0,5}(?:提交|发送|转移|重试)|返回.{0,8}重试/,
  },
  en: {
    failure: /fail(?:ed|ure)|could not complete|unable to complete/i,
    created: /\bcreated\b|creation (?:complete|successful)/i,
    pending: /review|moderation|(?:awaiting|pending) publication|not (?:yet )?public/i,
    later: /\blater\b|after (?:a while|some time)/i,
    retry: /manually|resubmit|(?:submit|try)[^.]*\bagain\b|please retry/i,
  },
};

const screenshotDir = process.env.SCREENSHOT_DIR;
async function capture(page, name) {
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
}

async function checkCopy(locator, label, ...patterns) {
  await locator.waitFor();
  const text = await locator.innerText();
  for (const pattern of patterns) assert.match(text, pattern, label);
}

async function runCase(browser, viewport, locale, messages) {
  const label = `${viewport.width}-${locale}`;
  const context = await browser.newContext({ viewport, serviceWorkers: "block", reducedMotion: "reduce" });
  const errors = [];
  const calls = [];
  const pollCounts = new Map();
  const firstPollGates = scenarios.map(() => {
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    return { ready, release };
  });
  let posts = 0;
  let allowedPosts = 0;
  context.on("page", (p) => p.on("pageerror", (error) => errors.push(error.message)));

  // Fulfil only from fixtures or the checkout; never forward a request.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ json: body, status });
    try {
      assert.equal(url.origin, origin, "External request blocked");
      if (method === "GET" && path === "/api/roles") {
        calls.push("roles");
        await json({ roles: [], bonds: [] });
      } else if (method === "POST" && path === "/api/search") {
        calls.push("search");
        assert.equal(request.postDataJSON().source, source);
        await json({ candidates: [candidate], pageInfo: { scannedStrategies: 1 } });
      } else if (method === "POST" && path === "/api/transfers") {
        const index = posts++;
        assert.ok(index < allowedPosts, "Transfer POST without a user click");
        assert.deepEqual(request.postDataJSON(), { source });
        calls.push(`post:${scenarios[index].id}`);
        await json({ status: "queued", jobId: scenarios[index].id }, 202);
      } else if (method === "GET" && path === "/api/transfers") {
        const id = url.searchParams.get("jobId");
        const index = scenarios.findIndex((entry) => entry.id === id);
        const count = pollCounts.get(id) ?? 0;
        calls.push(`poll:${id}`);
        assert.ok(index >= 0 && index < posts && scenarios[index].results[count], `Unexpected poll for ${id}`);
        pollCounts.set(id, count + 1);
        if (count === 0) await firstPollGates[index].ready;
        await json({ jobId: id, ...scenarios[index].results[count] });
      } else {
        const file = path === "/" ? "index.html" : path === "/history" ? "history.html" : path.slice(1);
        const contentType = mime[extname(file)];
        assert.ok(method === "GET" && contentType && /^[\w/-]+\.[\w]+$/.test(file), "Unexpected route");
        await route.fulfill({ body: await readFile(new URL(file, publicDir)), contentType });
      }
    } catch (error) {
      errors.push(`${method} ${url}: ${error.message}`);
      await route.abort();
    }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const submit = page.locator("#transfer-submit");
  const status = page.locator("#transfer-status");
  const dialog = page.locator("#transfer-dialog");
  const shareWrap = page.locator("#share-code-wrap");
  const share = page.locator("#share-code");
  async function noShare() {
    assert.ok(await shareWrap.isHidden(), "A share code is visible before success");
    assert.equal(await share.inputValue(), "", "A share code was filled before success");
  }
  async function send(index) {
    assert.equal(posts, index, "Unexpected transfer POST before clicking submit");
    allowedPosts++;
    await submit.click();
    await status.getByText(scenarios[index].id, { exact: false }).waitFor();
    assert.equal(posts, index + 1);
    assert.ok(await submit.isDisabled(), "Submit should be disabled while the job is queued");
    firstPollGates[index].release();
  }

  try {
    await page.clock.install();
    await page.goto(origin);
    await page.locator("#locale-select").selectOption(locale);
    assert.equal(await page.locator("html").getAttribute("lang"), locale);
    await page.locator("#source-input").fill(source);
    await page.locator("#search-button").click();
    await page.getByRole("heading", { name: candidate.title, exact: true }).click();
    assert.ok(await page.getByRole("radio", { name: candidate.title }).isChecked());

    await send(0);
    await checkCopy(status.locator(".status-panel--error"), "Generic session failure", messages.failure);
    assert.ok(await dialog.isHidden(), "Generic session failure opened the review dialog");
    await noShare();

    await send(1);
    const modal = page.locator("dialog#transfer-dialog:modal");
    await modal.waitFor();
    const close = modal.locator("#transfer-dialog-close");
    await checkCopy(modal.locator("#transfer-dialog-title"), "Review dialog title", messages.created);
    await checkCopy(modal.locator("#transfer-dialog-body"), "Review dialog body",
      messages.pending, messages.later, messages.retry);
    await page.waitForFunction(() => document.activeElement?.id === "transfer-dialog-close");
    await noShare();
    await capture(page, `${label}-dialog`);
    await page.clock.runFor(5_000);
    assert.equal(posts, 2, "The open dialog triggered an automatic retry");
    await close.click();
    await modal.waitFor({ state: "hidden" });
    assert.ok(await dialog.isHidden(), "The closed dialog is still visible");
    await page.waitForFunction(() => document.activeElement?.id === "transfer-submit");
    await noShare();

    const history = await context.newPage();
    await history.goto(new URL(await page.locator('a[href="/history"]').first().getAttribute("href"), origin).href);
    await history.locator("#locale-select").selectOption(locale);
    const record = history.locator(".history-record").filter({ hasText: candidate.title })
      .filter({ has: history.locator(".status-badge").filter({ hasText: messages.pending }) });
    await checkCopy(record.locator(".status-badge"), "History pending badge", messages.pending);
    await checkCopy(record.getByText(messages.created), "History pending note",
      messages.pending, messages.later, messages.retry);
    assert.equal(await record.locator(".history-record__code").count(), 0);
    await capture(history, `${label}-history`);
    await history.close();

    // Give any scheduled retry time to run before permitting the next user click.
    await page.clock.fastForward(30_000);
    await page.clock.runFor(100);
    assert.equal(posts, 2, "The pending review triggered an automatic retry");
    await send(2);
    await shareWrap.waitFor();
    assert.equal(await share.inputValue(), shareCode);
    assert.ok(await dialog.isHidden(), "Manual retry reopened the review dialog");
    assert.deepEqual(calls, ["roles", "search", "post:qa-session", "poll:qa-session",
      "post:qa-review", "poll:qa-review", "poll:qa-review", "post:qa-retry", "poll:qa-retry"]);
    assert.deepEqual(errors, []);
    console.log(`PASS ${label}`);
  } catch (error) {
    await capture(page, `${label}-failure`).catch(() => {});
    throw new Error(`${label}: ${error.message}${errors.length ? `\n${errors.join("\n")}` : ""}`, { cause: error });
  } finally {
    for (const gate of firstPollGates) gate.release();
    await context.close();
  }
}

if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch(process.env.BROWSER_EXECUTABLE
  ? { executablePath: process.env.BROWSER_EXECUTABLE }
  : { channel: process.env.BROWSER_CHANNEL || "chrome" });
try {
  console.log(`Node ${process.version}; Chromium ${browser.version()}`);
  for (const [width, height] of [[375, 812], [768, 1024], [1280, 900]]) {
    for (const [locale, messages] of Object.entries(copy)) {
      await runCase(browser, { width, height }, locale, messages);
    }
  }
  console.log("Pending review browser regression: 9/9 passed");
} finally {
  await browser.close();
}
