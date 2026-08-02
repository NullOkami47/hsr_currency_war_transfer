import {
  getSearchErrorPresentation,
  retainKnownRoleIds,
} from "./search-error.js?v=1";

const messages = {
  "zh-Hant": {
    appName: "貨幣戰爭攻略轉移",
    localeLabel: "介面語言",
    heroEyebrow: "Currency War Strategy Compendium / 跨服轉移",
    heroTitle: "從中國服找到攻略，帶到全球服。",
    heroCopy: "貼上分享連結，或用名稱與角色篩選候選攻略。確認陣容後，再交由管理員帳號建立全球服版本。",
    trustAnonymous: "搜尋不需登入",
    trustWorker: "管理員 worker 發布",
    searchEyebrow: "搜尋條件",
    searchHeading: "尋找中國服攻略",
    modeDirect: "URL／ID",
    modeDetails: "名稱與角色",
    sourceLabel: "中國服攻略 URL／ID",
    sourcePlaceholder: "貼上米遊社連結或 24 位攻略 ID",
    sourceHint: "分享連結中的其他追蹤參數不會影響查找。",
    sourceRequired: "請貼上中國服攻略 URL 或輸入攻略 ID。",
    keywordLabel: "攻略名稱關鍵字",
    keywordPlaceholder: "例如：姬子、戰技點",
    rolesLabel: "角色（可多選）",
    rolesLoading: "正在讀取角色⋯",
    rolesChoose: "選擇角色",
    rolesSelected: "已選擇 {count} 名角色",
    rolesFailed: "角色清單讀取失敗，請重新整理頁面。",
    rolesNone: "沒有符合的角色。",
    roleFilterPlaceholder: "輸入角色名稱",
    detailsRequired: "請輸入名稱關鍵字或選擇至少一名角色。",
    clear: "清除",
    search: "搜尋攻略",
    searching: "正在搜尋",
    initialTitle: "候選攻略會出現在這裡",
    initialBody: "使用 URL／ID 精確查找，或以名稱和角色組合搜尋。",
    resultsEyebrow: "候選清單",
    resultsTitle: "選擇要轉移的攻略",
    resultCount: "{count} 筆",
    scanned: "已掃描 {count} 筆中國服攻略。",
    truncatedTitle: "搜尋範圍仍有更多攻略",
    truncatedBody: "目前顯示限定頁數內的結果；可收窄關鍵字或角色條件。",
    partialSearchTitle: "只顯示已取得的部分結果",
    partialSearchBody: "第 {page} 頁重試後仍無法讀取；已保留先前成功讀取的結果，請稍後再試。",
    noResultsTitle: "找不到符合條件的攻略",
    noResultsBody: "請縮短關鍵字、減少所選角色，或改用攻略 URL／ID。",
    searchErrorTitle: "暫時無法讀取中國服攻略",
    searchErrorBody: "請稍後重試；已填寫的搜尋條件不會消失。",
    author: "作者：{name}",
    front: "前台",
    back: "後台",
    viewSource: "查看來源",
    expand: "展開營運概念",
    collapse: "收起營運概念",
    selected: "已選擇",
    selectedStrategy: "已選攻略",
    transferCopy: "提交後由管理員 worker 建立或更新全球服版本，完成後回傳攻略碼。",
    submit: "提交轉移",
    submitting: "正在提交",
    cancel: "取消",
    transferUnavailableTitle: "轉移服務尚未連線",
    transferUnavailableBody: "搜尋及選擇功能可正常使用；管理員需先設定外部 worker 才能建立全球服攻略。",
    queuedTitle: "攻略已加入轉移佇列",
    queuedBody: "工作編號：{id}",
    completeTitle: "全球服攻略已準備好",
    partialTitle: "已發布殘缺版本",
    ignoredBody: "有 {count} 個項目無法轉移，已自動略過。",
    shareCode: "全球服攻略碼",
    copy: "複製",
    copied: "已複製",
    descriptionEmpty: "作者沒有填寫營運概念。",
    footer: "非官方工具。攻略文字保持中國服原文；無法對應的項目會被略過並在結果中列出。",
    chinaArchive: "開啟中國服攻略站",
  },
  "zh-Hans": {
    appName: "货币战争攻略转移", localeLabel: "界面语言", heroEyebrow: "Currency War Archive / 跨服转移", heroTitle: "从中国服找到攻略，带到全球服。", heroCopy: "粘贴分享链接，或用名称与角色筛选候选攻略。确认阵容后，再交由管理员账号建立全球服版本。", trustAnonymous: "搜索无需登录", trustWorker: "管理员 worker 发布", searchEyebrow: "搜索条件", searchHeading: "寻找中国服攻略", modeDirect: "URL／ID", modeDetails: "名称与角色", sourceLabel: "中国服攻略 URL／ID", sourcePlaceholder: "粘贴米游社链接或 24 位攻略 ID", sourceHint: "分享链接中的其他跟踪参数不会影响查找。", sourceRequired: "请粘贴中国服攻略 URL 或输入攻略 ID。", keywordLabel: "攻略名称关键词", keywordPlaceholder: "例如：姬子、战技点", rolesLabel: "角色（可多选）", rolesLoading: "正在读取角色…", rolesChoose: "选择角色", rolesSelected: "已选择 {count} 名角色", rolesFailed: "角色列表读取失败，请刷新页面。", rolesNone: "没有符合的角色。", roleFilterPlaceholder: "输入角色名称", detailsRequired: "请输入名称关键词或选择至少一名角色。", clear: "清除", search: "搜索攻略", searching: "正在搜索", initialTitle: "候选攻略会出现在这里", initialBody: "使用 URL／ID 精确查找，或以名称和角色组合搜索。", resultsEyebrow: "候选列表", resultsTitle: "选择要转移的攻略", resultCount: "{count} 条", scanned: "已扫描 {count} 条中国服攻略。", truncatedTitle: "搜索范围内仍有更多攻略", truncatedBody: "目前显示限定页数内的结果；可收窄关键词或角色条件。", noResultsTitle: "找不到符合条件的攻略", noResultsBody: "请缩短关键词、减少所选角色，或改用攻略 URL／ID。", searchErrorTitle: "暂时无法读取中国服攻略", searchErrorBody: "请稍后重试；已填写的搜索条件不会消失。", author: "作者：{name}", front: "前台", back: "后台", viewSource: "查看来源", expand: "展开运营思路", collapse: "收起运营思路", selected: "已选择", selectedStrategy: "已选攻略", transferCopy: "提交后由管理员 worker 建立或更新全球服版本，完成后返回攻略码。", submit: "提交转移", submitting: "正在提交", cancel: "取消", transferUnavailableTitle: "转移服务尚未连接", transferUnavailableBody: "搜索及选择功能可正常使用；管理员需先设置外部 worker 才能建立全球服攻略。", queuedTitle: "攻略已加入转移队列", queuedBody: "工作编号：{id}", completeTitle: "全球服攻略已准备好", partialTitle: "已发布残缺版本", ignoredBody: "有 {count} 个项目无法转移，已自动忽略。", shareCode: "全球服攻略码", copy: "复制", copied: "已复制", descriptionEmpty: "作者没有填写运营思路。", footer: "非官方工具。攻略文字保持中国服原文；无法对应的项目会被忽略并在结果中列出。", chinaArchive: "打开中国服攻略站",
  },
  en: {
    appName: "Currency War Strategy Transfer", localeLabel: "Interface language", heroEyebrow: "Currency War Archive / Region transfer", heroTitle: "Find a China strategy. Bring it to Global.", heroCopy: "Paste a shared link, or filter candidates by name and characters. Confirm the lineup, then let the administrator account create the Global version.", trustAnonymous: "No sign-in for search", trustWorker: "Published by the admin worker", searchEyebrow: "Search criteria", searchHeading: "Find a China strategy", modeDirect: "URL / ID", modeDetails: "Name & characters", sourceLabel: "China strategy URL / ID", sourcePlaceholder: "Paste a Miyoushe link or 24-character strategy ID", sourceHint: "Tracking parameters in shared links do not affect lookup.", sourceRequired: "Paste a China strategy URL or enter its ID.", keywordLabel: "Strategy title keyword", keywordPlaceholder: "For example: Himeko or Skill Points", rolesLabel: "Characters (multiple selection)", rolesLoading: "Loading characters…", rolesChoose: "Choose characters", rolesSelected: "{count} characters selected", rolesFailed: "The character list could not be loaded. Refresh the page to try again.", rolesNone: "No matching characters.", roleFilterPlaceholder: "Filter character names", detailsRequired: "Enter a title keyword or select at least one character.", clear: "Clear", search: "Search strategies", searching: "Searching", initialTitle: "Candidate strategies will appear here", initialBody: "Look up an exact URL / ID, or combine a title keyword with character filters.", resultsEyebrow: "Candidate list", resultsTitle: "Choose a strategy to transfer", resultCount: "{count} results", scanned: "Scanned {count} China strategies.", truncatedTitle: "More strategies remain outside this search window", truncatedBody: "These results cover a limited number of pages. Narrow the title or character filters for a more precise list.", noResultsTitle: "No matching strategies", noResultsBody: "Try a shorter keyword, fewer selected characters, or an exact strategy URL / ID.", searchErrorTitle: "China strategies cannot be read just now", searchErrorBody: "Try again shortly. Your search criteria have been kept.", author: "Author: {name}", front: "Front", back: "Back", viewSource: "View source", expand: "Expand operating notes", collapse: "Collapse operating notes", selected: "Selected", selectedStrategy: "Selected strategy", transferCopy: "The administrator worker will create or update the Global version and return its strategy code.", submit: "Submit transfer", submitting: "Submitting", cancel: "Clear", transferUnavailableTitle: "Transfer service is not connected", transferUnavailableBody: "Search and selection work normally. The administrator must connect the external worker before Global strategies can be created.", queuedTitle: "Strategy added to the transfer queue", queuedBody: "Job ID: {id}", completeTitle: "Your Global strategy is ready", partialTitle: "Partial version published", ignoredBody: "{count} items could not be transferred and were skipped automatically.", shareCode: "Global strategy code", copy: "Copy", copied: "Copied", descriptionEmpty: "The author did not provide operating notes.", footer: "Unofficial tool. Strategy text remains in its original China version; unavailable items are skipped and reported.", chinaArchive: "Open the China strategy archive",
  },
};

Object.assign(messages["zh-Hant"], {
  searchInputErrorTitle: "請修正搜尋條件",
  searchInvalidSource: "請貼上有效的中國服攻略 URL 或 24 字元攻略 ID。也可以直接貼上包含米遊社連結的分享文字。",
  searchInvalidCriteria: "請輸入攻略名稱、作者名稱，或至少選擇一名角色。",
  searchStaleRoles: "角色資料已更新；失效的角色條件已移除。請重新選擇角色後再搜尋。",
  searchInvalidPagination: "搜尋頁數設定無效，請重新整理頁面後再試。",
  searchInvalidRoles: "角色條件格式無效，請重新選擇角色。",
  searchInvalidGeneric: "請檢查搜尋條件後再試。",
  globalArchive: "開啟全球服攻略站",
  modeDetails: "名稱、作者與角色",
  authorLabel: "作者名稱",
  authorPlaceholder: "輸入作者顯示名稱",
  detailsRequired: "請輸入攻略名稱、作者名稱，或至少選擇一名角色。",
  heroCopy: "貼上分享連結，或用攻略名稱、作者與角色篩選候選攻略。確認陣容後，再交由管理員帳號建立全球服版本。",
  initialBody: "使用 URL／ID 精確查找，或以攻略名稱、作者與角色組合搜尋。",
  noResultsBody: "請嘗試縮短攻略或作者關鍵字、減少所選角色，或改用精確 URL／ID。",
  themeToDark: "切換至深色模式",
  themeToLight: "切換至淺色模式",
  queuedBody: "工作編號：{id}。管理員 worker 正在建立或核對攻略，請保持此頁開啟。",
  transferFailedTitle: "攻略轉移失敗",
  transferFailedBody: "管理員 worker 無法完成這次轉移。請稍後重試；若問題持續，請管理員檢查登入狀態。",
  transferTimeoutTitle: "轉移仍在處理中",
  transferTimeoutBody: "等待時間較長，請稍後使用同一攻略再次提交以取得最新結果。",
  ignoredItems: "未能轉移：{items}",
  preparingTitle: "正在準備全球服攻略",
  preparingBody: "正在整理攻略內容並連接管理員 worker。",
  roleFilterTagsLabel: "角色分類",
  rolesAll: "全部角色",
  roleCost: "{cost} 費角色",
  expertConsultant: "專家顧問",
  likes: "按讚",
  saves: "收藏",
});
Object.assign(messages["zh-Hans"], {
  searchInputErrorTitle: "请修正搜索条件",
  searchInvalidSource: "请粘贴有效的中国服攻略 URL 或 24 字符攻略 ID。也可以直接粘贴包含米游社链接的分享文字。",
  searchInvalidCriteria: "请输入攻略名称、作者名称，或至少选择一名角色。",
  searchStaleRoles: "角色数据已更新；失效的角色条件已移除。请重新选择角色后再搜索。",
  searchInvalidPagination: "搜索页数设置无效，请刷新页面后重试。",
  searchInvalidRoles: "角色条件格式无效，请重新选择角色。",
  searchInvalidGeneric: "请检查搜索条件后重试。",
  heroEyebrow: "Currency War Strategy Compendium / 跨服转移",
  globalArchive: "打开全球服攻略站",
  modeDetails: "名称、作者与角色",
  authorLabel: "作者名称",
  authorPlaceholder: "输入作者显示名称",
  detailsRequired: "请输入攻略名称、作者名称，或至少选择一名角色。",
  heroCopy: "粘贴分享链接，或用攻略名称、作者与角色筛选候选攻略。确认阵容后，再交由管理员账号建立全球服版本。",
  initialBody: "使用 URL／ID 精确查找，或以攻略名称、作者与角色组合搜索。",
  noResultsBody: "请尝试缩短攻略或作者关键词、减少所选角色，或改用精确 URL／ID。",
  themeToDark: "切换至深色模式",
  themeToLight: "切换至浅色模式",
  queuedBody: "工作编号：{id}。管理员 worker 正在建立或核对攻略，请保持此页面开启。",
  transferFailedTitle: "攻略转移失败",
  transferFailedBody: "管理员 worker 无法完成本次转移。请稍后重试；若问题持续，请管理员检查登录状态。",
  transferTimeoutTitle: "转移仍在处理中",
  transferTimeoutBody: "等待时间较长，请稍后使用同一攻略再次提交以取得最新结果。",
  ignoredItems: "未能转移：{items}",
  preparingTitle: "正在准备全球服攻略",
  preparingBody: "正在整理攻略内容并连接管理员 worker。",
  roleFilterTagsLabel: "角色分类",
  rolesAll: "全部角色",
  roleCost: "{cost} 费角色",
  expertConsultant: "专家顾问",
  likes: "点赞",
  saves: "收藏",
  partialSearchTitle: "仅显示已取得的部分结果",
  partialSearchBody: "第 {page} 页重试后仍无法读取；已保留此前成功读取的结果，请稍后重试。",
});
Object.assign(messages.en, {
  searchInputErrorTitle: "Check the search criteria",
  searchInvalidSource: "Paste a valid China strategy URL or 24-character strategy ID. Shared text containing a Miyoushe link is also accepted.",
  searchInvalidCriteria: "Enter a strategy title, author name, or select at least one character.",
  searchStaleRoles: "The character data changed and outdated criteria were removed. Select the characters again, then search.",
  searchInvalidPagination: "The search page settings are invalid. Refresh the page, then try again.",
  searchInvalidRoles: "The character criteria are invalid. Select the characters again.",
  searchInvalidGeneric: "Check the search criteria, then try again.",
  heroEyebrow: "Currency War Strategy Compendium / Region transfer",
  chinaArchive: "Open the China Strategy Compendium",
  globalArchive: "Open the Global Strategy Compendium",
  modeDetails: "Title, author & characters",
  authorLabel: "Author name",
  authorPlaceholder: "Enter the author's display name",
  detailsRequired: "Enter a strategy title, author name, or select at least one character.",
  heroCopy: "Paste a shared link, or filter candidates by title, author and characters. Confirm the lineup, then let the administrator account create the Global version.",
  initialBody: "Look up an exact URL / ID, or combine strategy title, author and character filters.",
  noResultsBody: "Try a shorter title or author keyword, fewer selected characters, or an exact strategy URL / ID.",
  themeToDark: "Switch to dark mode",
  themeToLight: "Switch to light mode",
  queuedBody: "Job ID: {id}. The administrator worker is creating or checking the strategy; keep this page open.",
  transferFailedTitle: "Strategy transfer failed",
  transferFailedBody: "The administrator worker could not complete this transfer. Try again later; if it persists, the administrator should check the sign-in session.",
  transferTimeoutTitle: "The transfer is still processing",
  transferTimeoutBody: "This is taking longer than expected. Submit the same strategy again later to retrieve its latest result.",
  ignoredItems: "Not transferred: {items}",
  preparingTitle: "Preparing the Global strategy",
  preparingBody: "Organising the strategy content and contacting the administrator worker.",
  roleFilterTagsLabel: "Character categories",
  rolesAll: "All characters",
  roleCost: "Cost {cost} characters",
  expertConsultant: "Expert Consultant",
  likes: "Likes",
  saves: "Saves",
  partialSearchTitle: "Only the retrieved results are shown",
  partialSearchBody: "Page {page} could not be read after retrying. Results from the successfully read pages have been kept; try again later.",
});

Object.assign(messages["zh-Hant"], {
  adminConsole: "管理員控制台",
  expired: "已過期",
  expiredCandidate: "此攻略已過期，無法轉移。",
  transferPolicyTitle: "管理員安全政策已阻止提交",
  transferPolicyBody: "此攻略目前不符合公開提交、來源清單、限流、每日配額或佇列容量設定。",
});
Object.assign(messages["zh-Hans"], {
  adminConsole: "管理员控制台",
  expired: "已过期",
  expiredCandidate: "此攻略已过期，无法转移。",
  transferPolicyTitle: "管理员安全策略已阻止提交",
  transferPolicyBody: "此攻略目前不符合公开提交、来源列表、限流、每日配额或队列容量设置。",
});
Object.assign(messages.en, {
  adminConsole: "Administrator console",
  expired: "Expired",
  expiredCandidate: "This strategy has expired and cannot be transferred.",
  transferPolicyTitle: "The administrator safety policy blocked this request",
  transferPolicyBody: "This strategy does not currently meet the public submission, source list, rate, daily quota or queue capacity policy.",
});

const state = {
  locale: navigator.language.toLowerCase().startsWith("zh-cn") ? "zh-Hans" : navigator.language.toLowerCase().startsWith("en") ? "en" : "zh-Hant",
  mode: "direct",
  roles: [],
  rolesById: new Map(),
  selectedRoleIds: new Set(),
  candidates: [],
  selectedCandidate: null,
  searchResult: null,
  searchBusy: false,
  theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  roleLoadFailed: false,
  roleCategoryFilter: "all",
  searchController: null,
  transferController: null,
};

const elements = Object.fromEntries([
  "locale-select", "theme-toggle", "global-archive-link", "search-form", "source-input", "source-field", "source-error", "keyword-input", "author-input", "details-error", "role-trigger", "role-trigger-label", "role-popover", "role-filter", "role-clear", "role-filters", "role-grid", "role-status", "search-button", "search-status", "results-header", "result-count", "candidate-list", "transfer-tray", "tray-title", "tray-roster", "transfer-status", "selection-clear", "transfer-submit", "share-code-wrap", "share-code", "copy-code",
].map((id) => [id, document.getElementById(id)]));

function t(key, variables = {}) {
  let value = messages[state.locale][key] ?? messages["zh-Hant"][key] ?? key;
  for (const [name, replacement] of Object.entries(variables)) value = value.replace(`{${name}}`, String(replacement));
  return value;
}

function applyTranslations() {
  document.documentElement.lang = state.locale;
  document.title = t("appName");
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = t(node.dataset.i18nPlaceholder);
  const globalLanguage = state.locale === "zh-Hant" ? "zh-tw" : state.locale === "zh-Hans" ? "zh-cn" : "en-us";
  elements["global-archive-link"].href = `https://act.hoyolab.com/sr/event/currency-wars/index.html?lang=${globalLanguage}#/lineup/home?tab=recommend`;
  applyTheme(state.theme);
  updateRoleTrigger();
  setSearchBusy(state.searchBusy);
  renderResults();
  renderTray();
}

function applyTheme(theme, { persist = false } = {}) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#111714" : "#eee8da");
  const label = t(theme === "dark" ? "themeToLight" : "themeToDark");
  elements["theme-toggle"].setAttribute("aria-label", label);
  elements["theme-toggle"].setAttribute("title", label);
  elements["theme-toggle"].setAttribute("aria-pressed", String(theme === "dark"));
  if (persist) {
    try {
      localStorage.setItem("currency-war-theme", theme);
    } catch {
      // Theme switching remains functional when storage is unavailable.
    }
  }
}

function roleName(role) {
  const key = state.locale === "zh-Hans" ? "zhHans" : state.locale === "en" ? "en" : "zhHant";
  return String(role.names?.[key] ?? role.name ?? "");
}

function roleAliases(role) {
  return [...new Set([role.name, ...Object.values(role.names ?? {})])]
    .filter(Boolean)
    .join(" ");
}

function roleCosts(role) {
  return [...new Set((role.costs ?? []).map(String))].filter((cost) => /^[1-5]$/.test(cost));
}

function roleMatchesCategory(role) {
  if (state.roleCategoryFilter === "all") return true;
  if (state.roleCategoryFilter === "expert") return Boolean(role.isExpert);
  return roleCosts(role).includes(state.roleCategoryFilter.replace("cost-", ""));
}

function localisedRole(role) {
  const catalogueRole = state.rolesById?.get(String(role.id));
  return catalogueRole
    ? {
        ...role,
        ...catalogueRole,
        id: role.id,
        displayCost: role.displayCost ?? catalogueRole.displayCost,
        position: role.position,
        star: role.star,
      }
    : role;
}

function setMode(mode, focus = false) {
  state.mode = mode;
  for (const tab of document.querySelectorAll("[data-mode]")) {
    const active = tab.dataset.mode === mode;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  document.getElementById("panel-direct").hidden = mode !== "direct";
  document.getElementById("panel-details").hidden = mode !== "details";
  closeRolePicker();
  clearValidation();
}

function clearValidation() {
  elements["source-error"].hidden = true;
  elements["details-error"].hidden = true;
  elements["source-field"].classList.remove("field--error");
}

function updateRoleTrigger() {
  const count = state.selectedRoleIds.size;
  elements["role-trigger-label"].textContent = state.roleLoadFailed ? t("rolesFailed") : count ? t("rolesSelected", { count }) : state.roles.length ? t("rolesChoose") : t("rolesLoading");
  elements["role-trigger"].disabled = state.roleLoadFailed || state.roles.length === 0;
}

function openRolePicker() {
  elements["role-popover"].hidden = false;
  elements["role-trigger"].setAttribute("aria-expanded", "true");
  constrainRolePopoverToViewport();
  elements["role-filter"].focus();
}

function closeRolePicker() {
  elements["role-popover"].hidden = true;
  elements["role-trigger"].setAttribute("aria-expanded", "false");
  delete elements["role-popover"].dataset.placement;
  elements["role-popover"].style.removeProperty("--role-popover-available-height");
}

function constrainRolePopoverToViewport() {
  const popover = elements["role-popover"];
  if (popover.hidden) return;
  delete popover.dataset.placement;
  popover.style.removeProperty("--role-popover-available-height");
  const pickerRect = popover.parentElement.getBoundingClientRect();
  const triggerRect = elements["role-trigger"].getBoundingClientRect();
  const initialRect = popover.getBoundingClientRect();
  const styles = getComputedStyle(popover);
  const visualViewport = window.visualViewport;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportBottom = visualViewport
    ? visualViewport.offsetTop + visualViewport.height
    : window.innerHeight;
  const viewportGap = Number.parseFloat(styles.paddingBottom) || 0;
  const surfaceGap = Math.max(0, initialRect.top - triggerRect.bottom);
  const availableBelow = Math.max(
    0,
    viewportBottom - triggerRect.bottom - surfaceGap - viewportGap,
  );
  const availableAbove = Math.max(
    0,
    pickerRect.top - viewportTop - surfaceGap - viewportGap,
  );
  const maxHeightToken = styles.getPropertyValue("--role-popover-max-height").trim();
  const maxHeightValue = Number.parseFloat(maxHeightToken);
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const preferredHeight = maxHeightToken.endsWith("rem")
    ? maxHeightValue * rootFontSize
    : maxHeightValue;
  const placeAbove = availableBelow < preferredHeight && availableAbove > availableBelow;
  if (placeAbove) popover.dataset.placement = "top";
  const availableHeight = placeAbove ? availableAbove : availableBelow;
  popover.style.setProperty("--role-popover-available-height", `${availableHeight}px`);
}

function portrait(role, size = "normal", costOverride = "") {
  const displayName = roleName(role);
  const wrapper = document.createElement("span");
  wrapper.className = "portrait";
  const displayCost = String(costOverride || role.displayCost || roleCosts(role)[0] || "");
  if (/^[1-5]$/.test(displayCost)) {
    wrapper.classList.add(`portrait--cost-${displayCost}`);
  }
  wrapper.title = displayName;
  const fallback = document.createElement("span");
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = displayName.slice(0, 1);
  wrapper.append(fallback);
  const icon = role.icon || role.bigIcon;
  if (icon) {
    const image = new Image(36, 36);
    image.alt = size === "small" ? "" : displayName;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => wrapper.classList.add("portrait--loaded"), { once: true });
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = icon;
    wrapper.append(image);
  }
  if (size === "small") wrapper.classList.add("portrait--small");
  return wrapper;
}

function roleFilterIcon(kind) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("aria-hidden", "true");
  if (kind === "all") {
    icon.innerHTML = '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>';
  } else if (kind === "cost") {
    icon.innerHTML = '<path d="M7 4h10l4 8-4 8H7l-4-8 4-8Z"/><path d="M8.5 9.5h7m-7 3h7m-7 3h5"/>';
  } else {
    icon.innerHTML = '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 3v4m8-4v4M7 11h4v4H7zm7 0h3m-3 4h3"/>';
  }
  return icon;
}

function renderRoleFilters() {
  const filters = [
    { id: "all", label: t("rolesAll"), icon: "all", compact: true },
    ...[1, 2, 3, 4, 5].map((cost) => ({
      id: `cost-${cost}`,
      label: t("roleCost", { cost }),
      icon: "cost",
      text: String(cost),
    })),
    { id: "expert", label: t("expertConsultant"), icon: "expert", text: t("expertConsultant") },
  ];
  elements["role-filters"].setAttribute("aria-label", t("roleFilterTagsLabel"));
  elements["role-filters"].replaceChildren();
  for (const filter of filters) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `role-filter-tag${filter.compact ? " role-filter-tag--compact" : ""}`;
    button.setAttribute("aria-pressed", String(state.roleCategoryFilter === filter.id));
    button.setAttribute("aria-label", filter.label);
    button.append(roleFilterIcon(filter.icon));
    if (filter.text) {
      const text = document.createElement("span");
      text.textContent = filter.text;
      button.append(text);
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.roleCategoryFilter = filter.id;
      renderRoleGrid();
    });
    elements["role-filters"].append(button);
  }
}

function renderRoleGrid() {
  const query = elements["role-filter"].value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  const visible = state.roles.filter((role) =>
    roleMatchesCategory(role) &&
    roleAliases(role).normalize("NFKC").toLocaleLowerCase("zh-CN").includes(query));
  renderRoleFilters();
  elements["role-grid"].replaceChildren();
  for (const role of visible) {
    const label = document.createElement("label");
    label.className = "role-chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = role.id;
    input.checked = state.selectedRoleIds.has(role.id);
    input.addEventListener("change", () => {
      if (input.checked) state.selectedRoleIds.add(role.id); else state.selectedRoleIds.delete(role.id);
      updateRoleTrigger();
    });
    const name = document.createElement("span");
    name.className = "role-chip__name";
    name.textContent = roleName(role);
    const categoryCost = state.roleCategoryFilter.startsWith("cost-")
      ? state.roleCategoryFilter.replace("cost-", "")
      : "";
    label.append(input, portrait(role, "small", categoryCost), name);
    elements["role-grid"].append(label);
  }
  elements["role-status"].textContent = visible.length ? "" : t("rolesNone");
  elements["role-status"].hidden = visible.length > 0;
}

async function loadRoles() {
  try {
    const response = await fetch("/api/roles?schema=4");
    if (!response.ok) throw new Error("roles");
    const data = await response.json();
    state.roles = data.roles ?? [];
    state.rolesById = new Map(state.roles.flatMap((role) =>
      [...new Set([role.id, ...(role.matchIds ?? [])])].map((id) => [String(id), role])));
    state.roleLoadFailed = false;
    renderRoleGrid();
    updateRoleTrigger();
    return true;
  } catch {
    state.roleLoadFailed = true;
    elements["role-status"].textContent = t("rolesFailed");
    elements["role-status"].hidden = false;
    updateRoleTrigger();
    return false;
  }
}

function statusPanel(variant, title, body) {
  const panel = document.createElement("div");
  panel.className = `status-panel${variant ? ` status-panel--${variant}` : ""}`;
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "icon"); icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("fill", "none"); icon.setAttribute("stroke", "currentColor"); icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = '<circle cx="12" cy="12" r="9" stroke-width="1.8"/><path d="M12 8v4m0 4h.01" stroke-width="1.8" stroke-linecap="round"/>';
  const content = document.createElement("div");
  const heading = document.createElement("p"); heading.className = "status-panel__title"; heading.textContent = title;
  const copy = document.createElement("p"); copy.className = "status-panel__body"; copy.textContent = body;
  content.append(heading, copy); panel.append(icon, content); return panel;
}

function roster(roles) {
  const root = document.createElement("div"); root.className = "roster";
  for (const position of ["front", "back"]) {
    const positionRoles = roles.filter((role) => role.position === position);
    if (!positionRoles.length) continue;
    const group = document.createElement("div"); group.className = "roster__group";
    const label = document.createElement("span"); label.className = "roster__label"; label.textContent = t(position);
    const portraits = document.createElement("div"); portraits.className = "roster__portraits";
    for (const role of positionRoles) portraits.append(portrait(localisedRole(role)));
    group.append(label, portraits); root.append(group);
  }
  return root;
}

function engagementIcon(pathData) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}

const ENGAGEMENT_ICON_PATHS = Object.freeze({
  heart: "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78a5.5 5.5 0 0 0 0-7.78Z",
  star: "m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z",
});

function engagementStat(label, count, iconPath) {
  const item = document.createElement("div");
  item.className = "candidate__engagement-item";
  const term = document.createElement("dt");
  term.append(engagementIcon(iconPath), label);
  const value = document.createElement("dd");
  const locale = state.locale === "zh-Hant" ? "zh-Hant-TW" : state.locale === "zh-Hans" ? "zh-CN" : "en-GB";
  value.textContent = new Intl.NumberFormat(locale).format(Number.isSafeInteger(count) ? count : 0);
  item.append(term, value);
  return item;
}

function candidateEngagement(engagement = {}) {
  const root = document.createElement("dl");
  root.className = "candidate__engagement";
  root.append(
    engagementStat(t("likes"), engagement.likes, ENGAGEMENT_ICON_PATHS.heart),
    engagementStat(t("saves"), engagement.saves, ENGAGEMENT_ICON_PATHS.star),
  );
  return root;
}

function selectCandidate(candidate) {
  if (state.selectedCandidate?.id !== candidate.id) resetTransferUi();
  state.selectedCandidate = candidate;
  renderResults();
  renderTray();
  document.body.classList.add("has-selection");
}

function candidateCard(candidate, index) {
  const article = document.createElement("article");
  article.className = "candidate";
  article.dataset.candidateId = candidate.id;
  if (candidate.isExpired) article.classList.add("candidate--expired");
  if (state.selectedCandidate?.id === candidate.id) article.classList.add("candidate--selected");
  const indexColumn = document.createElement("div"); indexColumn.className = "candidate__index";
  const number = document.createElement("span"); number.textContent = String(index + 1).padStart(2, "0");
  const radio = document.createElement("input"); radio.className = "candidate__radio"; radio.type = "radio"; radio.name = "candidate"; radio.value = candidate.id; radio.checked = state.selectedCandidate?.id === candidate.id; radio.disabled = Boolean(candidate.isExpired); radio.setAttribute("aria-label", candidate.isExpired ? `${candidate.title} — ${t("expiredCandidate")}` : candidate.title);
  radio.addEventListener("change", () => selectCandidate(candidate)); indexColumn.append(number, radio);
  const body = document.createElement("div"); body.className = "candidate__body";
  const headingRow = document.createElement("div"); headingRow.className = "candidate__heading-row";
  const heading = document.createElement("div");
  const title = document.createElement("h3"); title.className = "candidate__title"; title.textContent = candidate.title;
  const author = document.createElement("p"); author.className = "candidate__author"; author.textContent = t("author", { name: candidate.author.nickname || "—" });
  const metadata = document.createElement("div"); metadata.className = "candidate__meta-row"; metadata.append(author, candidateEngagement(candidate.engagement));
  heading.append(title, metadata);
  const badge = document.createElement("span"); badge.className = "candidate__badge"; badge.textContent = t("selected"); badge.hidden = state.selectedCandidate?.id !== candidate.id;
  const expiredBadge = document.createElement("span"); expiredBadge.className = "candidate__badge candidate__badge--expired"; expiredBadge.textContent = t("expired"); expiredBadge.hidden = !candidate.isExpired;
  headingRow.append(heading, expiredBadge, badge);
  const description = document.createElement("p"); description.className = "candidate__description"; description.textContent = candidate.description || t("descriptionEmpty");
  const footer = document.createElement("div"); footer.className = "candidate__footer";
  const source = document.createElement("a"); source.href = candidate.sourceUrl; source.target = "_blank"; source.rel = "noreferrer"; source.textContent = t("viewSource");
  const expand = document.createElement("button"); expand.className = "button button--quiet"; expand.type = "button"; expand.textContent = t("expand");
  expand.addEventListener("click", () => { const expanded = description.dataset.expanded === "true"; description.dataset.expanded = String(!expanded); expand.textContent = t(expanded ? "expand" : "collapse"); });
  footer.append(source, expand); body.append(headingRow, description, roster(candidate.roles), footer);
  article.append(indexColumn, body);
  article.addEventListener("click", (event) => { if (!candidate.isExpired && !event.target.closest("a, button, input")) selectCandidate(candidate); });
  return article;
}

function renderResults() {
  elements["candidate-list"].replaceChildren();
  if (!state.searchResult) return;
  const candidates = state.candidates;
  elements["results-header"].hidden = false;
  elements["result-count"].textContent = t("resultCount", { count: candidates.length });
  elements["search-status"].replaceChildren();
  const pageInfo = state.searchResult.pageInfo ?? {};
  const partialWarning = () => statusPanel(
    "",
    t("partialSearchTitle"),
    t("partialSearchBody", { page: pageInfo.failedPage ?? "—" }),
  );
  if (!candidates.length) {
    elements["search-status"].append(statusPanel("empty", t("noResultsTitle"), t("noResultsBody")));
    if (pageInfo.partial) elements["search-status"].append(partialWarning());
    return;
  }
  candidates.forEach((candidate, index) => elements["candidate-list"].append(candidateCard(candidate, index)));
  const info = document.createElement("p"); info.className = "result-summary"; info.textContent = t("scanned", { count: pageInfo.scannedStrategies });
  elements["search-status"].append(info);
  if (pageInfo.partial) {
    elements["search-status"].append(partialWarning());
  } else if (pageInfo.truncated) {
    elements["search-status"].append(statusPanel("", t("truncatedTitle"), t("truncatedBody")));
  }
}

function renderTray() {
  const candidate = state.selectedCandidate;
  elements["transfer-tray"].hidden = !candidate;
  if (!candidate) return;
  elements["tray-title"].textContent = candidate.title;
  elements["tray-roster"].replaceChildren(roster(candidate.roles));
}

function resetTransferUi() {
  state.transferController?.abort();
  state.transferController = null;
  elements["transfer-status"].replaceChildren();
  elements["share-code"].value = "";
  elements["share-code-wrap"].hidden = true;
  setTransferBusy(false);
}

function showSearchLoading() {
  elements["results-header"].hidden = true;
  elements["candidate-list"].replaceChildren();
  elements["search-status"].replaceChildren();
  for (let index = 0; index < 3; index += 1) {
    const card = document.createElement("div"); card.className = "candidate candidate--loading";
    const number = document.createElement("div"); number.className = "candidate__index skeleton";
    const body = document.createElement("div"); body.className = "candidate__body";
    for (const width of ["70%", "42%", "88%"] ) { const line = document.createElement("div"); line.className = "skeleton skeleton--line"; line.style.width = width; body.append(line); }
    card.append(number, body); elements["search-status"].append(card);
  }
}

function setSearchBusy(busy) {
  state.searchBusy = busy;
  elements["search-button"].disabled = busy;
  elements["search-button"].replaceChildren();
  if (busy) {
    const spinner = document.createElement("span"); spinner.className = "button__spinner"; spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span"); label.textContent = t("searching"); elements["search-button"].append(spinner, label);
  } else {
    const label = document.createElement("span"); label.textContent = t("search"); elements["search-button"].append(label);
  }
}

function setTransferBusy(busy) {
  elements["transfer-submit"].disabled = busy;
  elements["transfer-submit"].replaceChildren();
  if (busy) {
    const spinner = document.createElement("span"); spinner.className = "button__spinner"; spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span"); label.textContent = t("submitting"); elements["transfer-submit"].append(spinner, label);
  } else {
    const label = document.createElement("span"); label.textContent = t("submit"); elements["transfer-submit"].append(label);
  }
}

async function performSearch() {
  clearValidation();
  const source = elements["source-input"].value.trim();
  const keyword = elements["keyword-input"].value.trim();
  const authorKeyword = elements["author-input"].value.trim();
  if (state.mode === "direct" && !source) {
    elements["source-field"].classList.add("field--error"); elements["source-error"].textContent = t("sourceRequired"); elements["source-error"].hidden = false; elements["source-input"].focus(); return;
  }
  if (state.mode === "details" && !keyword && !authorKeyword && state.selectedRoleIds.size === 0) {
    elements["details-error"].textContent = t("detailsRequired"); elements["details-error"].hidden = false; elements["keyword-input"].focus(); return;
  }
  state.searchController?.abort(); state.searchController = new AbortController();
  resetTransferUi(); state.selectedCandidate = null; document.body.classList.remove("has-selection"); elements["transfer-tray"].hidden = true;
  setSearchBusy(true); showSearchLoading(); closeRolePicker();
  try {
    const payload = state.mode === "direct" ? { source } : { keyword, authorKeyword, roleIds: [...state.selectedRoleIds], maxPages: 10, pageSize: 10 };
    const response = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: state.searchController.signal });
    const data = await response.json();
    if (!response.ok) {
      const presentation = getSearchErrorPresentation(response.status, data);
      if (presentation.refreshRoles && await loadRoles()) {
        state.selectedRoleIds = new Set(retainKnownRoleIds(state.selectedRoleIds, state.rolesById));
        renderRoleGrid(); updateRoleTrigger();
      }
      const searchError = new Error("search"); searchError.presentation = presentation; throw searchError;
    }
    state.searchResult = data; state.candidates = state.searchResult.candidates ?? []; renderResults();
  } catch (error) {
    if (error.name === "AbortError") return;
    const presentation = error.presentation ?? getSearchErrorPresentation(0, null);
    state.searchResult = null; state.candidates = []; elements["results-header"].hidden = true; elements["candidate-list"].replaceChildren(); elements["search-status"].replaceChildren(statusPanel("error", t(presentation.titleKey), t(presentation.bodyKey)));
  } finally { setSearchBusy(false); }
}

function waitForPoll(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Transfer polling was cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollTransfer(jobId, signal) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await waitForPoll(1_500, signal);
    const response = await fetch(`/api/transfers?jobId=${encodeURIComponent(jobId)}`, { signal });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error?.code ?? "transfer_poll_failed");
      error.code = data.error?.code;
      throw error;
    }
    if (data.status !== "queued") return data;
  }
  const error = new Error("transfer_timeout");
  error.code = "transfer_timeout";
  throw error;
}

function renderTransferResult(data) {
  elements["transfer-status"].replaceChildren();
  if (data.status === "failed") {
    elements["transfer-status"].append(statusPanel("error", t("transferFailedTitle"), t("transferFailedBody")));
    return;
  }
  if (data.shareCode) {
    elements["share-code"].value = data.shareCode;
    elements["share-code-wrap"].hidden = false;
  }
  const ignored = data.ignored ?? [];
  const ignoredList = ignored
    .map((item) => [item.type, item.id].filter(Boolean).join(" "))
    .join(state.locale === "en" ? ", " : "、");
  const body = ignored.length
    ? `${t("ignoredBody", { count: ignored.length })} ${t("ignoredItems", { items: ignoredList })}`
    : "";
  elements["transfer-status"].append(statusPanel("", data.status === "partial" ? t("partialTitle") : t("completeTitle"), body));
}

async function submitTransfer() {
  if (!state.selectedCandidate || state.transferController) return;
  const controller = new AbortController();
  state.transferController = controller;
  setTransferBusy(true); elements["transfer-status"].replaceChildren(statusPanel("working", t("preparingTitle"), t("preparingBody"))); elements["share-code-wrap"].hidden = true;
  try {
    const response = await fetch("/api/transfers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: state.selectedCandidate.id }), signal: controller.signal });
    let data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error?.code ?? "transfer_failed");
      error.code = data.error?.code;
      throw error;
    }
    if (data.status === "queued") {
      elements["transfer-status"].replaceChildren(statusPanel("working", t("queuedTitle"), t("queuedBody", { id: data.jobId ?? "—" })));
      data = await pollTransfer(data.jobId, controller.signal);
    }
    renderTransferResult(data);
  } catch (error) {
    if (error.name === "AbortError") return;
    const unavailable = error.code === "transfer_service_unavailable";
    const timedOut = error.code === "transfer_timeout";
    const policyBlocked = [
      "public_submissions_disabled",
      "source_not_allowed",
      "rate_limited",
      "daily_quota_reached",
      "queue_full",
    ].includes(error.code);
    elements["transfer-status"].replaceChildren(statusPanel(
      "error",
      t(timedOut ? "transferTimeoutTitle" : unavailable ? "transferUnavailableTitle" : policyBlocked ? "transferPolicyTitle" : "transferFailedTitle"),
      t(timedOut ? "transferTimeoutBody" : unavailable ? "transferUnavailableBody" : policyBlocked ? "transferPolicyBody" : "transferFailedBody"),
    ));
  } finally {
    if (state.transferController === controller) {
      state.transferController = null;
      setTransferBusy(false);
    }
  }
}

elements["locale-select"].value = state.locale;
elements["theme-toggle"].addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark", { persist: true }));
elements["locale-select"].addEventListener("change", (event) => { state.locale = event.target.value; applyTranslations(); renderRoleGrid(); });
for (const tab of document.querySelectorAll("[data-mode]")) {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
  tab.addEventListener("keydown", (event) => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); setMode(state.mode === "direct" ? "details" : "direct", true); });
}
elements["role-trigger"].addEventListener("click", () => elements["role-popover"].hidden ? openRolePicker() : closeRolePicker());
elements["role-filter"].addEventListener("input", renderRoleGrid);
elements["role-clear"].addEventListener("click", () => { state.selectedRoleIds.clear(); renderRoleGrid(); updateRoleTrigger(); });
document.addEventListener("click", (event) => {
  const clickedInsideRolePicker = event.composedPath().some((node) =>
    node instanceof Element && node.classList.contains("role-picker"));
  if (!clickedInsideRolePicker) closeRolePicker();
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !elements["role-popover"].hidden) { closeRolePicker(); elements["role-trigger"].focus(); } });
window.addEventListener("resize", constrainRolePopoverToViewport);
window.visualViewport?.addEventListener("resize", constrainRolePopoverToViewport);
elements["search-form"].addEventListener("submit", (event) => { event.preventDefault(); performSearch(); });
elements["selection-clear"].addEventListener("click", () => { resetTransferUi(); state.selectedCandidate = null; document.body.classList.remove("has-selection"); renderResults(); renderTray(); });
elements["transfer-submit"].addEventListener("click", submitTransfer);
elements["copy-code"].addEventListener("click", async () => { await navigator.clipboard.writeText(elements["share-code"].value); elements["copy-code"].textContent = t("copied"); setTimeout(() => { elements["copy-code"].textContent = t("copy"); }, 1200); });

applyTranslations();
loadRoles();
