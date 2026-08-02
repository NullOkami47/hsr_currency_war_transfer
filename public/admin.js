const elements = Object.fromEntries([
  "admin-theme-toggle", "admin-login", "admin-login-form", "admin-token",
  "admin-login-status", "admin-console", "admin-title", "admin-refresh",
  "admin-logout", "admin-stats", "admin-settings-form", "admin-save",
  "admin-save-status", "setting-public-enabled", "setting-allowlist-enabled",
  "setting-allowlist", "setting-ip-limit", "setting-ip-window",
  "setting-daily-quota", "setting-max-pending", "setting-retention-days",
  "setting-max-stored", "admin-record-count", "admin-record-body",
  "admin-record-empty",
].map((id) => [id, document.getElementById(id)]));

const state = {
  csrfToken: null,
  dirty: false,
  loading: false,
};

function setTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#111714" : "#eee8da");
  elements["admin-theme-toggle"].setAttribute(
    "aria-label",
    theme === "dark" ? "切換淺色模式" : "切換深色模式",
  );
  if (persist) {
    try { localStorage.setItem("currency-war-theme", theme); } catch {}
  }
}

function status(element, message, variant = "") {
  element.textContent = message;
  element.dataset.variant = variant;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.error?.message ?? "管理服務暫時無法使用");
    error.code = body.error?.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function showLogin(message = "") {
  state.csrfToken = null;
  elements["admin-console"].hidden = true;
  elements["admin-login"].hidden = false;
  status(elements["admin-login-status"], message, message ? "error" : "");
  document.getElementById("admin-login-title").focus?.();
  elements["admin-token"].focus();
}

function showConsole() {
  elements["admin-login"].hidden = true;
  elements["admin-console"].hidden = false;
}

function numberValue(id) {
  return Number(elements[id].value);
}

function formSettings() {
  const sourceAllowlist = elements["setting-allowlist"].value
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (sourceAllowlist.some((id) => !/^[a-f0-9]{24}$/i.test(id))) {
    throw new Error("來源 allow-list 只接受每行一個 24 位十六進位攻略 ID。");
  }
  return {
    publicSubmissionsEnabled: elements["setting-public-enabled"].checked,
    sourceAllowlistEnabled: elements["setting-allowlist-enabled"].checked,
    sourceAllowlist: [...new Set(sourceAllowlist)],
    perIpLimit: numberValue("setting-ip-limit"),
    perIpWindowMinutes: numberValue("setting-ip-window"),
    dailyAccountQuota: numberValue("setting-daily-quota"),
    maxPendingJobs: numberValue("setting-max-pending"),
    retentionDays: numberValue("setting-retention-days"),
    maxStoredJobs: numberValue("setting-max-stored"),
  };
}

function renderSettings(settings) {
  elements["setting-public-enabled"].checked = settings.publicSubmissionsEnabled;
  elements["setting-allowlist-enabled"].checked = settings.sourceAllowlistEnabled;
  elements["setting-allowlist"].value = (settings.sourceAllowlist ?? []).join("\n");
  elements["setting-ip-limit"].value = settings.perIpLimit;
  elements["setting-ip-window"].value = settings.perIpWindowMinutes;
  elements["setting-daily-quota"].value = settings.dailyAccountQuota;
  elements["setting-max-pending"].value = settings.maxPendingJobs;
  elements["setting-retention-days"].value = settings.retentionDays;
  elements["setting-max-stored"].value = settings.maxStoredJobs;
  state.dirty = false;
}

function statCard(label, value, detail) {
  const card = document.createElement("article");
  card.className = "admin-stat";
  const title = document.createElement("p"); title.textContent = label;
  const number = document.createElement("strong"); number.textContent = String(value);
  const copy = document.createElement("span"); copy.textContent = detail;
  card.append(title, number, copy);
  return card;
}

function renderStats(stats, settings) {
  elements["admin-stats"].replaceChildren(
    statCard("進行中", stats.active ?? 0, `上限 ${settings.maxPendingJobs}`),
    statCard("今日工作", stats.jobsToday ?? 0, `尚餘 ${stats.remainingDailyQuota ?? 0}`),
    statCard("已儲存紀錄", stats.storedJobs ?? 0, `上限 ${settings.maxStoredJobs}`),
    statCard("公開提交", settings.publicSubmissionsEnabled ? "啟用" : "停用", settings.sourceAllowlistEnabled ? "使用 allow-list" : "允許任何來源"),
  );
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(date);
}

function tableCell(value, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = value;
  return cell;
}

function renderJobs(jobs) {
  elements["admin-record-body"].replaceChildren();
  elements["admin-record-count"].textContent = `${jobs.length} 筆`;
  elements["admin-record-empty"].hidden = jobs.length > 0;
  for (const job of jobs) {
    const row = document.createElement("tr");
    const statusCell = tableCell(job.status);
    const badge = document.createElement("span");
    badge.className = `admin-job-status admin-job-status--${job.status}`;
    badge.textContent = job.status;
    statusCell.replaceChildren(badge);
    const result = job.error
      ? `${job.error.code}：${job.error.message}`
      : job.result?.shareCode
        ? job.result.shareCode
        : job.result?.globalId ?? "—";
    row.append(
      statusCell,
      tableCell(job.sourceId, "admin-mono"),
      tableCell(result, "admin-mono"),
      tableCell(formatTime(job.createdAt)),
      tableCell(formatTime(job.updatedAt)),
    );
    elements["admin-record-body"].append(row);
  }
}

async function loadDashboard({ discardDirty = false } = {}) {
  if (state.loading) return;
  if (state.dirty && !discardDirty && !confirm("尚有未儲存設定，仍要重新整理嗎？")) return;
  state.loading = true;
  elements["admin-refresh"].disabled = true;
  try {
    const dashboard = await jsonRequest("/api/admin");
    renderSettings(dashboard.settings);
    renderStats(dashboard.stats, dashboard.settings);
    renderJobs(dashboard.jobs ?? []);
    showConsole();
  } catch (error) {
    if (error.status === 401) showLogin("管理員工作階段已失效，請重新登入。");
    else status(elements["admin-save-status"], error.message, "error");
  } finally {
    state.loading = false;
    elements["admin-refresh"].disabled = false;
  }
}

elements["admin-theme-toggle"].addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next, true);
});

elements["admin-login-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  status(elements["admin-login-status"], "正在驗證…");
  const token = elements["admin-token"].value;
  elements["admin-token"].value = "";
  try {
    const session = await jsonRequest("/api/admin/session", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    state.csrfToken = session.csrfToken;
    await loadDashboard({ discardDirty: true });
  } catch (error) {
    showLogin(error.message);
  } finally {
    button.disabled = false;
  }
});

elements["admin-settings-form"].addEventListener("input", () => {
  state.dirty = true;
  status(elements["admin-save-status"], "有尚未儲存的設定。", "pending");
});

elements["admin-settings-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  elements["admin-save"].disabled = true;
  status(elements["admin-save-status"], "正在儲存並套用安全政策…");
  try {
    const settings = formSettings();
    const result = await jsonRequest("/api/admin", {
      method: "PUT",
      headers: { "x-csrf-token": state.csrfToken },
      body: JSON.stringify(settings),
    });
    renderSettings(result.settings);
    status(elements["admin-save-status"], "設定已儲存，新的提交會立即套用。", "success");
    elements["admin-save-status"].focus();
    await loadDashboard({ discardDirty: true });
  } catch (error) {
    if (error.status === 401) showLogin("管理員工作階段已失效，請重新登入。");
    else status(elements["admin-save-status"], error.message, "error");
  } finally {
    elements["admin-save"].disabled = false;
  }
});

elements["admin-refresh"].addEventListener("click", () => loadDashboard());
elements["admin-logout"].addEventListener("click", async () => {
  try {
    await jsonRequest("/api/admin/session", {
      method: "DELETE",
      headers: { "x-csrf-token": state.csrfToken },
    });
  } finally {
    showLogin("已安全登出。");
  }
});

setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
try {
  const session = await jsonRequest("/api/admin/session");
  if (session.authenticated) {
    state.csrfToken = session.csrfToken;
    await loadDashboard({ discardDirty: true });
  } else {
    showLogin();
  }
} catch (error) {
  showLogin(error.message);
}
