import assert from "node:assert/strict";
import test from "node:test";

import {
  applySourceAttribution,
  buildGlobalTitlePrefix,
  transferStrategy,
} from "../src/transfer.mjs";

const SOURCE_ID = "6a4dfde2ce98d01a5bac0343";
const GLOBAL_ID = "6a4dfde2ce98d01a5bac0999";

function config() {
  return {
    rpg_game_big_version: "4.4",
    season_id: "1",
    sub_season_id: "4",
    role_list: [{ id: "1001" }],
    trait_info_list: [
      { trait_id: "1001", trait_name: "列車同行" },
    ],
    equipment_list: [],
    fight_augment_list: [],
    portal_list: [],
    label_list: [],
  };
}

function source(title = "【1列车同行】攻略標題") {
  return {
    id: SOURCE_ID,
    nickname: "作者",
    title,
    description: "原文",
    tourn_detail: {
      support_hard: false,
      role_stages: [
        {
          stage: "Early",
          front_roles: [],
          back_roles: [],
          carry_list: [],
        },
        {
          stage: "Middle",
          front_roles: [],
          back_roles: [],
          carry_list: [],
        },
        {
          stage: "Final",
          front_roles: [{
            id: "1001",
            star: 1,
            board_index: 0,
            rec_equip_index: -1,
            is_carry: true,
            first_equipments: [],
            second_equipments: [],
          }],
          back_roles: [],
          carry_list: ["1001"],
          traits: [
            {
              trait_id: "1001",
              trait_name: "列车同行",
              current_role_count: 1,
            },
          ],
        },
      ],
      order_compose: [],
      order_basic: [],
      first_fight_augments: [],
      second_fight_augments: [],
      portals: [],
      labels: [],
    },
  };
}

function publishedFrom(payload, shareCode = "share-code") {
  return {
    id: GLOBAL_ID,
    ...structuredClone(payload),
    tourn_detail: {
      ...structuredClone(payload.tourn_detail),
      share_code: shareCode,
    },
  };
}

function dependencies({
  previous = null,
  published = null,
  sourceLineup = source(),
  staleReadsAfterPublish = 0,
} = {}) {
  const records = new Map(previous ? [[SOURCE_ID, previous]] : []);
  const calls = { create: [], edit: [], set: [] };
  let currentPublished = published;
  let stalePublished = published;
  let remainingStaleReads = 0;

  return {
    calls,
    options: {
      publisher: {
        async create(payload) {
          calls.create.push(payload);
          stalePublished = currentPublished;
          currentPublished = publishedFrom(payload);
          remainingStaleReads = staleReadsAfterPublish;
          return { lineupId: GLOBAL_ID };
        },
        async edit(id, payload) {
          calls.edit.push({ id, payload });
          stalePublished = currentPublished;
          currentPublished = publishedFrom(payload);
          remainingStaleReads = staleReadsAfterPublish;
          return { lineupId: id };
        },
      },
      store: {
        async get(id) {
          return records.get(id) ?? null;
        },
        async set(id, value) {
          calls.set.push({ id, value });
          records.set(id, value);
        },
      },
      async fetchConfigFn(region) {
        assert.equal(region, "global");
        return config();
      },
      async fetchLineupDetailFn(region, id) {
        if (region === "cn") {
          assert.equal(id, SOURCE_ID);
          return { lineup: sourceLineup };
        }
        if (id !== GLOBAL_ID || !currentPublished) {
          throw new Error("not found");
        }
        if (remainingStaleReads > 0 && stalePublished) {
          remainingStaleReads -= 1;
          return { lineup: stalePublished };
        }
        return { lineup: currentPublished };
      },
      now: () => new Date("2026-07-31T00:00:00.000Z"),
      verification: { attempts: 1, retryDelayMs: 0 },
    },
  };
}

test("creates once with a translated bond prefix and Chinese attribution", async () => {
  const { calls, options } = dependencies();
  const result = await transferStrategy(SOURCE_ID, options);

  assert.equal(result.status, "created");
  assert.equal(result.shareCode, "share-code");
  assert.equal(calls.create.length, 1);
  assert.equal(
    calls.create[0].title,
    "【1列車同行】攻略標題｜作者",
  );
  assert.equal(calls.create[0].description, "原文\n來源：作者");
  assert.deepEqual(result.attribution, {
    title: "added",
    description: "added",
  });
  assert.equal(calls.set.length, 1);
});

test("only adds attribution to fields with enough remaining space", () => {
  const result = applySourceAttribution(
    {
      title: "1234567890",
      description: "1234567890",
    },
    { nickname: "作者" },
    { title: 10, description: 100 },
  );

  assert.equal(result.payload.title, "1234567890");
  assert.equal(result.payload.description, "1234567890\n來源：作者");
  assert.deepEqual(result.attribution, {
    title: "skipped-no-space",
    description: "added",
  });
});

test("rebuilds the source-selected bond prefix with global zh-tw names", () => {
  const sourceLineup = source(
    "【6战技点4命运圣杯】干将莫邪，全员满装！",
  );
  sourceLineup.tourn_detail.role_stages[2].traits = [
    {
      trait_id: "2011",
      trait_name: "战技点",
      current_role_count: 6,
    },
    {
      trait_id: "1013",
      trait_name: "命运圣杯",
      current_role_count: 4,
    },
  ];

  const result = buildGlobalTitlePrefix(sourceLineup, {
    trait_info_list: [
      { trait_id: "2011", trait_name: "戰技點" },
      { trait_id: "1013", trait_name: "命運聖杯" },
    ],
  });

  assert.equal(result.value, "【6戰技點4命運聖杯】");
  assert.equal(result.status, "translated");
});

test("returns the existing code without publishing when nothing changed", async () => {
  const first = dependencies();
  const created = await transferStrategy(SOURCE_ID, first.options);
  const record = first.calls.set[0].value;
  const published = publishedFrom(first.calls.create[0], "same-code");
  const second = dependencies({ previous: record, published });

  const result = await transferStrategy(SOURCE_ID, second.options);

  assert.equal(created.status, "created");
  assert.equal(result.status, "unchanged");
  assert.equal(result.shareCode, "same-code");
  assert.equal(second.calls.create.length, 0);
  assert.equal(second.calls.edit.length, 0);
});

test("edits the existing strategy when its source changed", async () => {
  const first = dependencies();
  await transferStrategy(SOURCE_ID, first.options);
  const record = first.calls.set[0].value;
  const oldPublished = publishedFrom(first.calls.create[0], "old-code");
  const second = dependencies({
    previous: record,
    published: oldPublished,
    sourceLineup: source("【1列车同行】新標題"),
  });

  const result = await transferStrategy(SOURCE_ID, second.options);

  assert.equal(result.status, "updated");
  assert.equal(second.calls.edit.length, 1);
  assert.equal(second.calls.edit[0].id, GLOBAL_ID);
  assert.equal(
    second.calls.edit[0].payload.title,
    "【1列車同行】新標題｜作者",
  );
});

test("waits for the public detail cache to reflect an edit", async () => {
  const first = dependencies();
  await transferStrategy(SOURCE_ID, first.options);
  const record = first.calls.set[0].value;
  const oldPublished = publishedFrom(first.calls.create[0], "old-code");
  const second = dependencies({
    previous: record,
    published: oldPublished,
    sourceLineup: source("【1列车同行】快取後的新標題"),
    staleReadsAfterPublish: 1,
  });
  second.options.verification = { attempts: 2, retryDelayMs: 0 };

  const result = await transferStrategy(SOURCE_ID, second.options);

  assert.equal(result.status, "updated");
  assert.equal(second.calls.edit.length, 1);
});
