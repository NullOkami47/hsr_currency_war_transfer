import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  contentHash,
  stripCalculatedTitlePrefix,
  toGlobalPublishPayload,
} from "../src/transform.mjs";
import { parseChinaLineupInput } from "../src/api.mjs";

function config() {
  return {
    rpg_game_big_version: "4.4",
    season_id: "1",
    sub_season_id: "4",
    role_list: [{ id: "1001" }, { id: "1002" }],
    equipment_list: [
      {
        id: "35030101",
        compose_list: [
          {
            craft_id: "1",
            childrens: [{ id: "350201" }, { id: "350202" }],
          },
        ],
      },
    ],
    fight_augment_list: [{ id: "200602" }],
    portal_list: [{ id: "101" }],
    label_list: [{ id: "2" }],
  };
}

function source() {
  return {
    id: "6a4dfde2ce98d01a5bac0343",
    title: "原始攻略標題",
    description: "原始營運概念",
    tourn_detail: {
      support_hard: true,
      role_stages: [
        {
          stage: "Early",
          front_roles: [
            {
              id: "1001",
              star: 2,
              board_index: 1,
              rec_equip_index: -1,
              is_carry: false,
              first_equipments: [],
              second_equipments: [],
            },
          ],
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
          front_roles: [
            {
              id: "1002",
              star: 3,
              board_index: 0,
              rec_equip_index: 0,
              is_carry: true,
              first_equipments: [{ id: "350201" }],
              second_equipments: [{ id: "350202" }],
            },
          ],
          back_roles: [],
          carry_list: ["1002"],
        },
      ],
      order_compose: [{ id: "350202" }],
      order_basic: [{ id: "350201" }],
      first_fight_augments: [{ id: "200602" }],
      second_fight_augments: [],
      portals: [{ id: "101" }],
      labels: [{ id: "2" }],
    },
  };
}

test("creates the explicit global write payload without display-only fields", () => {
  const result = toGlobalPublishPayload(source(), config());

  assert.equal(result.ignored.length, 0);
  assert.equal(result.payload.title, "原始攻略標題");
  assert.equal(result.payload.description, "原始營運概念");
  assert.equal(result.payload.lineup_type, "Tourn");
  assert.deepEqual(result.payload.tourn_detail.portals, [{ id: "101" }]);
  assert.deepEqual(
    result.payload.tourn_detail.role_stages[2].front_roles[0],
    {
      id: "1002",
      rec_equip_index: 0,
      board_index: 0,
      star: 3,
      is_carry: true,
      first_equipments: [{ id: "350201" }],
      second_equipments: [{ id: "350202" }],
    },
  );
  assert.deepEqual(
    result.payload.tourn_detail.role_stages[2].switch_role_map,
    {},
  );
});

test("removes the source-language bond summary before global translation", () => {
  const changed = source();
  changed.title = "【2列车同行3群攻】永久创伤千冶刃主C，试用可玩";

  const result = toGlobalPublishPayload(changed, config());

  assert.equal(result.payload.title, "永久创伤千冶刃主C，试用可玩");
  assert.equal(
    stripCalculatedTitlePrefix("【2列车同行】【3群攻】攻略"),
    "攻略",
  );
  assert.equal(stripCalculatedTitlePrefix("【只有前綴】"), "【只有前綴】");
});

test("ignores unmapped content and reports every omission", () => {
  const changed = source();
  changed.tourn_detail.role_stages[2].front_roles.push({
    id: "9999",
    board_index: 2,
    first_equipments: [],
    second_equipments: [],
  });
  changed.tourn_detail.role_stages[2].carry_list.push("9999");
  changed.tourn_detail.order_basic.push({ id: "999999" });

  const result = toGlobalPublishPayload(changed, config());

  assert.equal(
    result.payload.tourn_detail.role_stages[2].front_roles.length,
    1,
  );
  assert.deepEqual(
    result.ignored.map(({ type, id, reason }) => ({ type, id, reason })),
    [
      { type: "role", id: "9999", reason: "missing-in-global-config" },
      {
        type: "carry-role",
        id: "9999",
        reason: "referenced-role-was-ignored",
      },
      {
        type: "equipment",
        id: "999999",
        reason: "missing-in-global-config",
      },
    ],
  );
});

test("content hash is stable across object key order", () => {
  const first = { b: 2, a: { d: 4, c: 3 } };
  const second = { a: { c: 3, d: 4 }, b: 2 };

  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(contentHash(first), contentHash(second));
});

test("parses a direct China lineup URL or id", () => {
  const id = "6a4dfde2ce98d01a5bac0343";
  assert.equal(parseChinaLineupInput(id), id);
  assert.equal(
    parseChinaLineupInput(
      `https://act.miyoushe.com/sr/event/currency-wars/index.html#/lineup/${id}?source_tab=StrategyGuide`,
    ),
    id,
  );
});

test("rejects a global URL as a China source", () => {
  assert.throws(
    () =>
      parseChinaLineupInput(
        "https://act.hoyolab.com/sr/event/currency-wars/index.html#/lineup/6a4dfde2ce98d01a5bac0343",
      ),
    /Only act\.miyoushe\.com/,
  );
});
