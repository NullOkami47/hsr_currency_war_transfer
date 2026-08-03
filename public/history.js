export const SUBMISSION_HISTORY_KEY = "currency-war-submission-history-v1";
export const SUBMISSION_HISTORY_LIMIT = 50;

const COMPLETED_STATUSES = new Set([
  "created",
  "updated",
  "unchanged",
  "partial",
]);
const RECOVERABLE_STATUSES = new Set(["queued", "failed"]);

function validDate(value) {
  const date = new Date(value ?? "");
  return Number.isNaN(date.valueOf()) ? null : date;
}

function historyTimestamp(entry) {
  return entry.completedAt ?? entry.submittedAt;
}

export function sanitiseGlobalStrategyUrl(value) {
  try {
    const supplied = new URL(String(value ?? ""));
    const expected = new URL(
      "https://act.hoyolab.com/sr/event/currency-wars/index.html",
    );
    const encodedId = supplied.searchParams.get("gt__lineup_id");
    if (
      supplied.origin !== expected.origin
      || supplied.pathname !== expected.pathname
      || !/^[a-fn-w]{24}$/.test(encodedId ?? "")
    ) {
      return null;
    }
    expected.searchParams.set("gt__lineup_id", encodedId);
    return expected.toString();
  } catch {
    return null;
  }
}

export function normaliseSubmissionHistoryEntry(value) {
  const status = String(value?.status ?? "");
  const sourceId = String(value?.sourceId ?? "");
  const sourceTitle = String(value?.sourceTitle ?? "").trim().slice(0, 300);
  const jobId = String(value?.jobId ?? "");
  const submittedAt = validDate(value?.submittedAt);
  if (!/^[a-f0-9]{24}$/i.test(sourceId)) return null;

  if (RECOVERABLE_STATUSES.has(status)) {
    const completedAt = status === "failed"
      ? validDate(value?.completedAt ?? value?.submittedAt)
      : null;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId) || !submittedAt) return null;
    return {
      id: String(value?.id ?? jobId).slice(0, 100),
      jobId,
      sourceId,
      sourceTitle,
      status,
      submittedAt: submittedAt.toISOString(),
      ...(completedAt ? { completedAt: completedAt.toISOString() } : {}),
    };
  }

  const shareCode = String(value?.shareCode ?? "");
  const globalUrl = sanitiseGlobalStrategyUrl(value?.globalUrl);
  const completedAt = validDate(value?.completedAt);
  if (
    !COMPLETED_STATUSES.has(status)
    || !/^##[^#]{1,500}##$/.test(shareCode)
    || !globalUrl
    || !completedAt
  ) {
    return null;
  }

  return {
    id: String(value?.id ?? `${completedAt.valueOf()}-${sourceId}`).slice(0, 100),
    ...(jobId && /^[A-Za-z0-9_-]{1,100}$/.test(jobId) ? { jobId } : {}),
    sourceId,
    sourceTitle,
    status,
    shareCode,
    globalUrl,
    completedAt: completedAt.toISOString(),
    ...(submittedAt ? { submittedAt: submittedAt.toISOString() } : {}),
  };
}

export function loadSubmissionHistory(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(SUBMISSION_HISTORY_KEY) ?? "null");
    const entries = Array.isArray(saved?.entries) ? saved.entries : [];
    return entries
      .map(normaliseSubmissionHistoryEntry)
      .filter(Boolean)
      .sort((left, right) => historyTimestamp(right).localeCompare(historyTimestamp(left)))
      .slice(0, SUBMISSION_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function saveSubmissionHistory(entries, storage = globalThis.localStorage) {
  const safeEntries = (entries ?? [])
    .map(normaliseSubmissionHistoryEntry)
    .filter(Boolean)
    .sort((left, right) => historyTimestamp(right).localeCompare(historyTimestamp(left)))
    .slice(0, SUBMISSION_HISTORY_LIMIT);
  try {
    storage?.setItem(
      SUBMISSION_HISTORY_KEY,
      JSON.stringify({ version: 1, entries: safeEntries }),
    );
    return safeEntries;
  } catch {
    return safeEntries;
  }
}

export function addSubmissionHistoryEntry(
  entry,
  storage = globalThis.localStorage,
) {
  const safeEntry = normaliseSubmissionHistoryEntry(entry);
  if (!safeEntry) return loadSubmissionHistory(storage);
  const existing = loadSubmissionHistory(storage).filter((saved) =>
    saved.id !== safeEntry.id
    && (!safeEntry.jobId || saved.jobId !== safeEntry.jobId));
  return saveSubmissionHistory(
    [safeEntry, ...existing],
    storage,
  );
}

export function clearSubmissionHistory(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(SUBMISSION_HISTORY_KEY);
  } catch {
    // The visible list can still be cleared when storage is unavailable.
  }
  return [];
}
