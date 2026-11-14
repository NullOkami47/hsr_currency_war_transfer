import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

import {
  getSearchErrorPresentation,
  retainKnownRoleIds,
} from "../public/search-error.js";

function sliceFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Expected to find ${signature}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const ch = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && (inSingle || inDouble || inTemplate)) {
      escaped = true;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === "`") {
      inTemplate = !inTemplate;
      continue;
    }
    if (inSingle || inDouble || inTemplate) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unterminated function ${signature}`);
}

function createFakeElement(tagName = "div", id = "") {
  const attributes = new Map();
  const element = {
    tagName: tagName.toUpperCase(),
    id,
    hidden: false,
    disabled: false,
    textContent: "",
    placeholder: "",
    href: "",
    className: "",
    dataset: {},
    children: [],
    style: {
      removeProperty() {},
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    querySelectorAll() {
      return [];
    },
  };
  return element;
}

function createMockDomEnv() {
  const elements = {
    "role-popover": createFakeElement("div", "role-popover"),
    "role-trigger": createFakeElement("button", "role-trigger"),
    "role-filter": createFakeElement("input", "role-filter"),
    "bond-popover": createFakeElement("div", "bond-popover"),
    "bond-trigger": createFakeElement("button", "bond-trigger"),
    "bond-filter": createFakeElement("input", "bond-filter"),
    "scan-more-container": createFakeElement("div", "scan-more-container"),
    "scan-more-button": createFakeElement("button", "scan-more-button"),
    "results-header": createFakeElement("div", "results-header"),
    "result-count": createFakeElement("p", "result-count"),
    "search-status": createFakeElement("div", "search-status"),
    "candidate-list": createFakeElement("div", "candidate-list"),
    "global-archive-link": createFakeElement("a", "global-archive-link"),
    "view-global-strategy": createFakeElement("a", "view-global-strategy"),
  };
  elements["role-popover"].hidden = true;
  elements["bond-popover"].hidden = true;

  const document = {
    documentElement: { lang: "zh-Hant" },
    title: "",
    createElement(tagName) {
      return createFakeElement(tagName);
    },
    querySelectorAll(selector) {
      if (selector !== "[data-i18n]") return [];
      const found = [];
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.dataset?.i18n) found.push(node);
        for (const child of node.children ?? []) walk(child);
      };
      for (const el of Object.values(elements)) walk(el);
      return found;
    },
  };

  return { elements, document };
}

test("filter search inputs allow mobile typing while opening pickers does not auto-focus", async () => {
  const [indexHtml, showcaseHtml, appSource] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/showcase.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(indexHtml, /<input[^>]+id="role-filter"[^>]*>/);
  assert.match(indexHtml, /<input[^>]+id="bond-filter"[^>]*>/);
  assert.doesNotMatch(
    indexHtml.match(/<input[^>]+id="role-filter"[^>]*>/)?.[0] ?? "",
    /inputmode="none"/,
  );
  assert.doesNotMatch(
    indexHtml.match(/<input[^>]+id="bond-filter"[^>]*>/)?.[0] ?? "",
    /inputmode="none"/,
  );
  assert.doesNotMatch(showcaseHtml, /inputmode="none"/);

  const { elements } = createMockDomEnv();
  let focusCalls = 0;
  elements["role-filter"].focus = () => {
    focusCalls += 1;
  };
  elements["bond-filter"].focus = () => {
    focusCalls += 1;
  };

  const pickerCode = [
    sliceFunction(appSource, "function openRolePicker()"),
    sliceFunction(appSource, "function closeRolePicker()"),
    sliceFunction(appSource, "function openBondPicker()"),
    sliceFunction(appSource, "function closeBondPicker()"),
  ].join("\n\n");

  const context = vm.createContext({
    elements,
    constrainRolePopoverToViewport() {},
    constrainBondPopoverToViewport() {},
  });
  vm.runInContext(
    `${pickerCode}\nopenRolePicker();\nopenBondPicker();`,
    context,
  );

  assert.equal(focusCalls, 0);
  assert.equal(elements["role-popover"].hidden, true);
  assert.equal(elements["role-trigger"].getAttribute("aria-expanded"), "false");
  assert.equal(elements["bond-popover"].hidden, false);
  assert.equal(elements["bond-trigger"].getAttribute("aria-expanded"), "true");
});

test("scan-more button updates translations and surfaces errors without wiping loaded results", async () => {
  const appSource = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );

  const code = [
    sliceFunction(appSource, "function applyTranslations()"),
    sliceFunction(appSource, "function setScanMoreBusy(busy)"),
    sliceFunction(appSource, "function updateScanMoreButton()"),
    sliceFunction(appSource, "async function buildSearchError(status, data)"),
    sliceFunction(appSource, "function renderSearchStatus()"),
    sliceFunction(appSource, "function renderResults()"),
    sliceFunction(appSource, "async function performScanMore()"),
  ].join("\n\n");

  const strings = {
    "zh-Hant": { scanMore: "掃描更多攻略", scanningMore: "正在掃描…" },
    en: { scanMore: "Scan more strategies", scanningMore: "Scanning more…" },
  };
  const { elements, document } = createMockDomEnv();
  const requests = [];
  const nextResponses = [
    {
      ok: false,
      status: 502,
      body: { error: { code: "china_service_error" } },
    },
    {
      ok: true,
      status: 200,
      body: {
        candidates: [
          { id: "c1", title: "Existing" },
          { id: "c2", title: "New" },
        ],
        pageInfo: {
          scannedStrategies: 20,
          hasMore: false,
          truncated: true,
          partial: false,
          nextPage: 5,
          nextPageToken: null,
        },
      },
    },
  ];

  const controller = new AbortController();
  const state = {
    locale: "zh-Hant",
    theme: "light",
    mode: "details",
    searchBusy: false,
    scanMoreBusy: false,
    scanMoreError: null,
    searchController: controller,
    searchQuery: { keyword: "", authorKeyword: "", roleIds: [], bondIds: ["300302"] },
    searchResult: {
      pageInfo: { scannedStrategies: 20, hasMore: true, partial: false, truncated: false },
    },
    candidates: [{ id: "c1", title: "Existing" }],
    scannedStrategies: 20,
    nextPageToken: "tok-2",
    nextPage: 3,
    hasMore: true,
  };

  const context = vm.createContext({
    state,
    elements,
    document,
    getSearchErrorPresentation,
    retainKnownRoleIds,
    t(key, params = {}) {
      const localeTable = strings[state.locale] ?? strings["zh-Hant"];
      if (localeTable[key]) return localeTable[key];
      if (key === "scanned") return `scanned:${params.count}`;
      if (key === "resultCount") return `count:${params.count}`;
      return `${state.locale}:${key}`;
    },
    applyTheme() {},
    updateRoleTrigger() {},
    updateBondTrigger() {},
    renderBondGrid() {},
    renderRoleGrid() {},
    setSearchBusy() {},
    renderTray() {},
    loadRoles: async () => false,
    candidateCard(candidate, index) {
      return createFakeElement("article", `${index}-${candidate.id}`);
    },
    statusPanel(variant, title, body) {
      return { variant, title, body, className: `status--${variant}` };
    },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const next = nextResponses.shift();
      return {
        ok: next.ok,
        status: next.status,
        json: async () => next.body,
      };
    },
  });

  vm.runInContext(code, context);
  vm.runInContext("renderResults(); setScanMoreBusy(false);", context);
  assert.equal(elements["scan-more-button"].children[0].dataset.i18n, "scanMore");

  state.locale = "en";
  vm.runInContext("applyTranslations();", context);
  assert.equal(elements["scan-more-button"].children[0].textContent, "Scan more strategies");

  // 1st Scan More click returns 502 -> keep c1 card & scan-more button, surface error panel
  await vm.runInContext("performScanMore()", context);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    keyword: "",
    authorKeyword: "",
    roleIds: [],
    bondIds: ["300302"],
    maxPages: 2,
    pageSize: 10,
    maxStrategies: 20,
    startPage: 3,
    nextPageToken: "tok-2",
  });
  assert.equal(elements["candidate-list"].children.length, 1);
  assert.equal(elements["scan-more-container"].hidden, false);
  assert.equal(state.scanMoreBusy, false);
  const errorPanelsAfterFailure = elements["search-status"].children.filter(
    (node) => node.variant === "error",
  );
  assert.equal(errorPanelsAfterFailure.length, 1);
  assert.equal(errorPanelsAfterFailure[0].title, "en:searchErrorTitle");

  // 2nd Scan More click succeeds -> clears error panel, deduplicates c1, appends c2, hides button
  await vm.runInContext("performScanMore()", context);
  assert.equal(elements["candidate-list"].children.length, 2);
  assert.equal(state.scannedStrategies, 40);
  assert.equal(state.searchResult.pageInfo.truncated, true);
  assert.equal(elements["scan-more-container"].hidden, true);
  assert.equal(
    elements["search-status"].children.filter((node) => node.variant === "error").length,
    0,
  );
  assert.equal(
    elements["search-status"].children.some((node) => node.textContent === "scanned:40"),
    true,
  );
});
