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

test("keeps the role catalogue inside the viewport with an internally scrollable grid", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const popover = css.match(/\.role-picker__popover\s*{([\s\S]*?)\n}/)?.[1] ?? "";
  const roleGrid = css.match(/\.role-grid\s*{([\s\S]*?)\n}/)?.[1] ?? "";

  assert.match(popover, /--role-popover-available-height/);
  assert.match(popover, /overflow:\s*hidden;/);
  assert.match(css, /\.role-picker__popover\[data-placement="top"\]/);
  assert.match(roleGrid, /min-height:\s*0;/);
  assert.match(roleGrid, /overflow-y:\s*auto;/);
});

test("uses a heart for likes and a star for saves", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const showcase = await readFile(
    new URL("../public/showcase.html", import.meta.url),
    "utf8",
  );
  const heartPath = "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78a5.5 5.5 0 0 0 0-7.78Z";
  const starPath = "m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z";

  assert.match(
    app,
    /engagementStat\(t\("likes"\), engagement\.likes, ENGAGEMENT_ICON_PATHS\.heart\)/,
  );
  assert.match(
    app,
    /engagementStat\(t\("saves"\), engagement\.saves, ENGAGEMENT_ICON_PATHS\.star\)/,
  );
  assert.ok(showcase.includes(`<path d="${heartPath}"/></svg>按讚`));
  assert.ok(showcase.includes(`<path d="${starPath}"/></svg>收藏`));
});

test("showcases the completed Global strategy action and blacklist policy", async () => {
  const showcase = await readFile(
    new URL("../public/showcase.html", import.meta.url),
    "utf8",
  );

  assert.match(showcase, /開啟已完成的全球服攻略/);
  assert.match(showcase, /gt__lineup_id=/);
  assert.match(showcase, /拒絕來源封鎖清單內的攻略/);
  assert.doesNotMatch(showcase, /allow-list/);
});

test("keeps the revised hero and footer content present across locales", async () => {
  const [html, app, css, devServer] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dev-server.mjs", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(html, /data-i18n="trustAnonymous"/);
  assert.doesNotMatch(html, /data-i18n="trustWorker"/);
  assert.doesNotMatch(html, /搜尋不需登入|管理員 worker 發布/);

  assert.match(app, /filter strategies by title, author and characters/);
  assert.match(app, /initialTitle: "Strategies will appear here"/);
  assert.match(app, /resultsEyebrow: "Strategy list"/);

  assert.match(html, /id="disclaimer-title"/);
  assert.match(app, /disclaimerTitle: "免責聲明"/);
  assert.match(app, /disclaimerTitle: "免责声明"/);
  assert.match(app, /disclaimerTitle: "Disclaimer"/);
  assert.match(
    html,
    /href="https:\/\/github\.com\/NullOkami47\/hsr_currency_war_transfer"/,
  );

  assert.match(css, /@keyframes hero-reveal/);
  assert.match(css, /--duration-route:\s*3200ms/);
  assert.match(css, /--duration-orbit:\s*18000ms/);
  assert.match(css, /@keyframes orbit-outer/);
  assert.match(css, /@keyframes orbit-inner/);
  assert.match(css, /@keyframes star-pulse/);
  assert.match(css, /@keyframes route-sweep/);
  assert.match(css, /\.hero__diagram::before/);
  assert.match(css, /\.route-line i::after/);
  assert.match(css, /\.hero__diagram \{[\s\S]*?position: relative;[\s\S]*?width: 100%;[\s\S]*?opacity: 1;/);
  assert.match(html, /class="hero__diagram"/);
  assert.match(html, /class="orbit orbit--outer"/);
  assert.match(html, /class="orbit orbit--inner"/);
  assert.match(html, /class="route-line"><span>CN<\/span><i><\/i><span>GL<\/span>/);
  assert.doesNotMatch(html, /<video|astral-express|hero__scene|hero__region/);
  assert.doesNotMatch(css, /hero__video|astral-express|colour-space|colour-route-glow/);
  assert.doesNotMatch(app, /heroVideo|syncHeroMotion/);
  assert.doesNotMatch(devServer, /astral-express-route|video\/webm|video\/mp4/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
