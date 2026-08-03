import assert from "node:assert/strict";
import test from "node:test";

import {
  addSubmissionHistoryEntry,
  clearSubmissionHistory,
  loadSubmissionHistory,
  SUBMISSION_HISTORY_KEY,
  SUBMISSION_HISTORY_LIMIT,
} from "../public/history.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function entry(index = 0) {
  return {
    id: `history-${index}`,
    sourceId: `6a56fe3021253d0e1a9f${String(4700 + index).padStart(4, "0")}`,
    sourceTitle: `中國服攻略 ${index}`,
    status: index % 2 ? "partial" : "created",
    shareCode: `##global-code-${index}=##`,
    globalUrl: "https://act.hoyolab.com/sr/event/currency-wars/index.html?gt__lineup_id=tatctwrapascrunpdnbrubpt",
    completedAt: new Date(Date.UTC(2026, 7, 3, 1, index)).toISOString(),
  };
}

test("stores completed submissions locally with public fields only", () => {
  const storage = memoryStorage();
  const saved = addSubmissionHistoryEntry(entry(), storage);

  assert.equal(saved.length, 1);
  assert.deepEqual(loadSubmissionHistory(storage)[0], entry());
  const raw = storage.getItem(SUBMISSION_HISTORY_KEY);
  assert.doesNotMatch(raw, /worker|token|session|globalId/);
});

test("keeps an accepted job across page closure and replaces it with its result", () => {
  const storage = memoryStorage();
  const pending = {
    id: "job-accepted-before-page-close",
    jobId: "job-accepted-before-page-close",
    sourceId: "6a56fe3021253d0e1a9f4761",
    sourceTitle: "Recoverable transfer",
    status: "queued",
    submittedAt: "2026-08-03T01:00:00.000Z",
  };

  addSubmissionHistoryEntry(pending, storage);
  assert.deepEqual(loadSubmissionHistory(storage), [pending]);

  const completed = {
    ...entry(),
    id: pending.id,
    jobId: pending.jobId,
    sourceId: pending.sourceId,
    sourceTitle: pending.sourceTitle,
    submittedAt: pending.submittedAt,
  };
  addSubmissionHistoryEntry(completed, storage);

  assert.deepEqual(loadSubmissionHistory(storage), [completed]);
});

test("rejects failed records and untrusted Global links", () => {
  const storage = memoryStorage();
  addSubmissionHistoryEntry({ ...entry(), status: "failed" }, storage);
  addSubmissionHistoryEntry({
    ...entry(1),
    globalUrl: "https://example.com/?gt__lineup_id=tatctwrapascrunpdnbrubpt",
  }, storage);

  assert.deepEqual(loadSubmissionHistory(storage), []);
});

test("keeps the newest fifty records and clears them explicitly", () => {
  const storage = memoryStorage();
  for (let index = 0; index < SUBMISSION_HISTORY_LIMIT + 5; index += 1) {
    addSubmissionHistoryEntry(entry(index), storage);
  }

  const saved = loadSubmissionHistory(storage);
  assert.equal(saved.length, SUBMISSION_HISTORY_LIMIT);
  assert.equal(saved[0].id, "history-54");
  assert.equal(saved.at(-1).id, "history-5");
  assert.deepEqual(clearSubmissionHistory(storage), []);
  assert.deepEqual(loadSubmissionHistory(storage), []);
});
