import {
  SUBMISSION_HISTORY_KEY,
  clearSubmissionHistory,
  loadSubmissionHistory,
} from "./history.js?v=1";

const messages = {
  "zh-Hant": {
    appName: "貨幣戰爭攻略轉移",
    pageTitle: "本機提交紀錄｜貨幣戰爭攻略轉移",
    localeLabel: "介面語言",
    backToSearch: "返回攻略搜尋",
    historyEyebrow: "此裝置",
    historyHeading: "本機提交紀錄",
    historyPrivacy: "只保存在這個瀏覽器，不會同步至其他裝置。",
    historySummary: "成功完成的提交會依時間由新至舊排列。",
    historyClear: "清除紀錄",
    historyClearConfirm: "確定要清除這個瀏覽器內的所有提交紀錄嗎？",
    historyEmptyTitle: "尚未有本機提交紀錄",
    historyEmptyBody: "完成攻略轉移後，全球服攻略碼與連結會保存在這裡。",
    historyCompletedAt: "完成於 {date}",
    historySourceId: "中國服來源 ID：{id}",
    historyOpenGlobal: "開啟全球服攻略",
    historyStatusCreated: "已建立",
    historyStatusUpdated: "已更新",
    historyStatusUnchanged: "內容未變",
    historyStatusPartial: "部分完成",
    copy: "複製攻略碼",
    copied: "已複製",
    themeToDark: "切換至深色模式",
    themeToLight: "切換至淺色模式",
    adminConsole: "管理員控制台",
    footer: "紀錄只存在目前的瀏覽器；清除瀏覽資料也會移除這些紀錄。",
  },
  "zh-Hans": {
    appName: "货币战争攻略转移",
    pageTitle: "本地提交记录｜货币战争攻略转移",
    localeLabel: "界面语言",
    backToSearch: "返回攻略搜索",
    historyEyebrow: "此设备",
    historyHeading: "本地提交记录",
    historyPrivacy: "只保存在这个浏览器，不会同步到其他设备。",
    historySummary: "成功完成的提交会按时间由新到旧排列。",
    historyClear: "清除记录",
    historyClearConfirm: "确定要清除这个浏览器内的所有提交记录吗？",
    historyEmptyTitle: "尚无本地提交记录",
    historyEmptyBody: "完成攻略转移后，全球服攻略码和链接会保存在这里。",
    historyCompletedAt: "完成于 {date}",
    historySourceId: "中国服来源 ID：{id}",
    historyOpenGlobal: "打开全球服攻略",
    historyStatusCreated: "已创建",
    historyStatusUpdated: "已更新",
    historyStatusUnchanged: "内容未变",
    historyStatusPartial: "部分完成",
    copy: "复制攻略码",
    copied: "已复制",
    themeToDark: "切换到深色模式",
    themeToLight: "切换到浅色模式",
    adminConsole: "管理员控制台",
    footer: "记录只存在当前浏览器；清除浏览数据也会移除这些记录。",
  },
  en: {
    appName: "Currency War Strategy Transfer",
    pageTitle: "Local submission history | Currency War Strategy Transfer",
    localeLabel: "Interface language",
    backToSearch: "Back to strategy search",
    historyEyebrow: "This device",
    historyHeading: "Local submission history",
    historyPrivacy: "Stored only in this browser and not synchronised to other devices.",
    historySummary: "Completed submissions are listed newest first.",
    historyClear: "Clear history",
    historyClearConfirm: "Clear all submission history stored in this browser?",
    historyEmptyTitle: "No local submission history yet",
    historyEmptyBody: "After a transfer completes, its Global code and link will be saved here.",
    historyCompletedAt: "Completed {date}",
    historySourceId: "China source ID: {id}",
    historyOpenGlobal: "Open Global strategy",
    historyStatusCreated: "Created",
    historyStatusUpdated: "Updated",
    historyStatusUnchanged: "Unchanged",
    historyStatusPartial: "Partially completed",
    copy: "Copy strategy code",
    copied: "Copied",
    themeToDark: "Switch to dark mode",
    themeToLight: "Switch to light mode",
    adminConsole: "Administrator console",
    footer: "History exists only in this browser; clearing browsing data also removes it.",
  },
};

const state = {
  locale: navigator.language.toLowerCase().startsWith("zh-cn")
    ? "zh-Hans"
    : navigator.language.toLowerCase().startsWith("en")
      ? "en"
      : "zh-Hant",
  theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
};

const elements = {
  locale: document.getElementById("locale-select"),
  theme: document.getElementById("theme-toggle"),
  clear: document.getElementById("history-clear"),
  list: document.getElementById("history-list"),
};

function t(key, variables = {}) {
  let value = messages[state.locale][key] ?? messages["zh-Hant"][key] ?? key;
  for (const [name, replacement] of Object.entries(variables)) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
}

function applyTheme(theme, { persist = false } = {}) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "dark" ? "#111714" : "#eee8da",
  );
  elements.theme.setAttribute(
    "aria-label",
    t(theme === "dark" ? "themeToLight" : "themeToDark"),
  );
  if (persist) {
    try {
      localStorage.setItem("currency-war-theme", theme);
    } catch {
      // The visual theme still changes when local storage is unavailable.
    }
  }
}

function statusPanel(title, body) {
  const panel = document.createElement("div");
  panel.className = "status-panel status-panel--empty";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = '<path d="M5 4h14v16H5zM8 8h8m-8 4h8m-8 4h5" stroke-width="1.8" stroke-linecap="round"/>';
  const content = document.createElement("div");
  const heading = document.createElement("p");
  heading.className = "status-panel__title";
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.className = "status-panel__body";
  copy.textContent = body;
  content.append(heading, copy);
  panel.append(icon, content);
  return panel;
}

function historyStatus(status) {
  const keys = {
    created: "historyStatusCreated",
    updated: "historyStatusUpdated",
    unchanged: "historyStatusUnchanged",
    partial: "historyStatusPartial",
  };
  return t(keys[status] ?? "historyStatusCreated");
}

function globalStrategyUrlForLocale(url) {
  const strategyUrl = new URL(url);
  strategyUrl.searchParams.set(
    "lang",
    state.locale === "zh-Hant" ? "zh-tw" : state.locale === "zh-Hans" ? "zh-cn" : "en-us",
  );
  return strategyUrl.toString();
}

function renderHistory() {
  const entries = loadSubmissionHistory();
  elements.clear.hidden = entries.length === 0;
  elements.list.replaceChildren();
  if (entries.length === 0) {
    elements.list.append(statusPanel(t("historyEmptyTitle"), t("historyEmptyBody")));
    return;
  }

  const dateLocale = state.locale === "zh-Hant"
    ? "zh-Hant-TW"
    : state.locale === "zh-Hans"
      ? "zh-CN"
      : "en-GB";
  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = "history-record";
    const content = document.createElement("div");
    content.className = "history-record__content";
    const headingRow = document.createElement("div");
    headingRow.className = "history-record__heading";
    const heading = document.createElement("h2");
    heading.textContent = entry.sourceTitle || entry.sourceId;
    const status = document.createElement("span");
    status.className = "status-badge";
    status.textContent = historyStatus(entry.status);
    headingRow.append(heading, status);
    const completed = new Intl.DateTimeFormat(dateLocale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(entry.completedAt));
    const metadata = document.createElement("p");
    metadata.className = "history-record__meta";
    metadata.textContent = `${t("historyCompletedAt", { date: completed })} · ${t("historySourceId", { id: entry.sourceId })}`;
    const code = document.createElement("code");
    code.className = "history-record__code";
    code.textContent = entry.shareCode;
    content.append(headingRow, metadata, code);

    const actions = document.createElement("div");
    actions.className = "history-record__actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "button button--secondary";
    copy.textContent = t("copy");
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(entry.shareCode);
      copy.textContent = t("copied");
      setTimeout(() => { copy.textContent = t("copy"); }, 1200);
    });
    const link = document.createElement("a");
    link.className = "button button--secondary";
    link.href = globalStrategyUrlForLocale(entry.globalUrl);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = t("historyOpenGlobal");
    actions.append(copy, link);
    article.append(content, actions);
    elements.list.append(article);
  }
}

function applyTranslations() {
  document.documentElement.lang = state.locale;
  document.title = t("pageTitle");
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  applyTheme(state.theme);
  renderHistory();
}

elements.locale.value = state.locale;
elements.locale.addEventListener("change", (event) => {
  state.locale = event.target.value;
  applyTranslations();
});
elements.theme.addEventListener("click", () => {
  applyTheme(state.theme === "dark" ? "light" : "dark", { persist: true });
});
elements.clear.addEventListener("click", () => {
  if (!window.confirm(t("historyClearConfirm"))) return;
  clearSubmissionHistory();
  renderHistory();
});
window.addEventListener("storage", (event) => {
  if (event.key === SUBMISSION_HISTORY_KEY) renderHistory();
});

applyTranslations();
