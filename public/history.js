export const SUBMISSION_HISTORY_KEY = "currency-war-submission-history-v1";
export const SUBMISSION_HISTORY_LIMIT = 50;

const COMPLETED_STATUSES = new Set([
  "created",
  "updated",
  "unchanged",
  "partial",
]);

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
  const shareCode = String(value?.shareCode ?? "");
  const globalUrl = sanitiseGlobalStrategyUrl(value?.globalUrl);
  const completedAt = new Date(value?.completedAt ?? "");
  if (
    !COMPLETED_STATUSES.has(status)
    || !/^[a-f0-9]{24}$/i.test(sourceId)
    || !/^##[^#]{1,500}##$/.test(shareCode)
    || !globalUrl
    || Number.isNaN(completedAt.valueOf())
  ) {
    return null;
  }

  return {
    id: String(value?.id ?? `${completedAt.valueOf()}-${sourceId}`).slice(0, 100),
    sourceId,
    sourceTitle: String(value?.sourceTitle ?? "").trim().slice(0, 300),
    status,
    shareCode,
    globalUrl,
    completedAt: completedAt.toISOString(),
  };
}

export function loadSubmissionHistory(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(SUBMISSION_HISTORY_KEY) ?? "null");
    const entries = Array.isArray(saved?.entries) ? saved.entries : [];
    return entries
      .map(normaliseSubmissionHistoryEntry)
      .filter(Boolean)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, SUBMISSION_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function saveSubmissionHistory(entries, storage = globalThis.localStorage) {
  const safeEntries = (entries ?? [])
    .map(normaliseSubmissionHistoryEntry)
    .filter(Boolean)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
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
  return saveSubmissionHistory(
    [safeEntry, ...loadSubmissionHistory(storage)],
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
