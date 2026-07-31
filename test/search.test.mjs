import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchChinaRoleOptions,
  getChinaRoleOptions,
  searchChinaStrategies,
  toChinaStrategyCandidate,
} from "../src/search.mjs";

const roles = [
  {
    id: "1510",
    name: "姬子•启行",
    icon: "himeko.png",
    big_icon: "himeko-big.png",
    rarity: "4",
    is_hide: false,
    is_expert: true,
  },
  {
    id: "1001",
    name: "三月七",
    icon: "march.png",
    big_icon: "march-big.png",
    rarity: "2",
    is_hide: false,
    is_expert: false,
  },
  {
    id: "9999",
    name: "隱藏角色",
    icon: "hidden.png",
    is_hide: true,
  },
];

const silverWolfVariants = ["15061", "15062", "15063"].map(
  (id, index) => ({
    id,
    name: "银狼LV.999",
    icon: "silver-wolf-999.png",
    big_icon: "silver-wolf-999-big.png",
    rarity: String(index + 3),
    is_hide: false,
  }),
);

function config() {
  return {
    role_list: roles,
    rpg_game_big_version: "4.4",
    season_id: "1",
    sub_season_id: "4",
  };
}

function lineup({
  id = "6a56fe3021253d0e1a9f4761",
  title = "【6列车同行3能量】币战科研项目：姬七猫！",
  roleIds = ["1510", "1001"],
} = {}) {
  return {
    id,
    title,
    description: "營運概念",
    nickname: "田宫良子ol",
    avatar_url: "author.png",
    certification: "攻略作者",
    created_at: "10",
    last_edit: "20",
    tourn_detail: {
      is_expired: false,
      role_stages: [
        {
          stage: "Final",
          front_roles: roleIds.slice(0, 1).map((roleId, index) => ({
            id: roleId,
            star: 4,
            board_index: index,
          })),
          back_roles: roleIds.slice(1).map((roleId, index) => ({
            id: roleId,
            star: 3,
            board_index: index,
          })),
        },
      ],
    },
  };
}

test("builds visible China role options for a multi-select control", () => {
  const options = getChinaRoleOptions(config());

  assert.equal(options.length, 2);
  assert.deepEqual(
    new Map(options.map((role) => [role.id, role])),
    new Map([
      [
        "1001",
        {
          id: "1001",
          name: "三月七",
          icon: "march.png",
          bigIcon: "march-big.png",
          displayCost: "2",
          costs: ["2"],
          isExpert: false,
        },
      ],
      [
        "1510",
        {
          id: "1510",
          name: "姬子•启行",
          icon: "himeko.png",
          bigIcon: "himeko-big.png",
          displayCost: "4",
          costs: ["4"],
          isExpert: true,
        },
      ],
    ]),
  );
  assert.equal(options.some(({ id }) => id === "9999"), false);
});

test("groups upgrade variants into one searchable role option", () => {
  const options = getChinaRoleOptions({ role_list: silverWolfVariants });

  assert.equal(options.length, 1);
  assert.equal(options[0].id, "15061");
  assert.equal(options[0].name, "银狼LV.999");
  assert.equal(options[0].displayCost, "3");
  assert.deepEqual(options[0].costs, ["3", "4", "5"]);
  assert.equal(options[0].isExpert, false);
  assert.deepEqual(options[0].matchIds, ["15061", "15062", "15063"]);
});

test("returns role catalogue metadata from the anonymous config", async () => {
  const calls = [];
  const result = await fetchChinaRoleOptions({
    fetchConfigFn: async (region, options) => {
      calls.push([region, options?.language]);
      return config();
    },
  });

  assert.equal(result.version, "4.4");
  assert.equal(result.roles.length, 2);
  assert.deepEqual(calls, [
    ["cn", undefined],
    ["global", "zh-tw"],
    ["global", "en-us"],
  ]);
  assert.deepEqual(result.roles[0].names, {
    zhHans: result.roles[0].name,
    zhHant: result.roles[0].name,
    en: result.roles[0].name,
  });
});

test("merges Traditional Chinese and English role names by stable id", () => {
  const result = getChinaRoleOptions(config(), {
    traditionalConfig: {
      role_list: roles.map((role) => ({ ...role, name: `繁體-${role.id}` })),
    },
    englishConfig: {
      role_list: roles.map((role) => ({ ...role, name: `English-${role.id}` })),
    },
  });
  const himeko = result.find(({ id }) => id === "1510");
  assert.equal(himeko.names.zhHant, "繁體-1510");
  assert.equal(himeko.names.en, "English-1510");
});

test("keeps the role picker available when the China config is temporarily unavailable", async () => {
  const result = await fetchChinaRoleOptions({
    fetchConfigFn: async (region) => {
      if (region === "cn") throw new Error("temporary China timeout");
      return config();
    },
  });

  assert.equal(result.roles.length, 2);
  assert.ok(result.roles.every((role) => role.icon));
});

test("normalises a China strategy into a safe candidate shape", () => {
  const result = toChinaStrategyCandidate(lineup(), config(), {
    selectedRoleIds: ["1510", "1001"],
  });

  assert.equal(result.id, "6a56fe3021253d0e1a9f4761");
  assert.equal(result.author.nickname, "田宫良子ol");
  assert.deepEqual(result.matchedRoleIds, ["1510", "1001"]);
  assert.deepEqual(
    result.roles.map(({ id, position }) => ({ id, position })),
    [
      { id: "1510", position: "front" },
      { id: "1001", position: "back" },
    ],
  );
  assert.match(result.sourceUrl, /#\/lineup\/6a56fe3021253d0e1a9f4761$/);
  assert.equal("account_uid" in result, false);
});

test("resolves a URL or ID directly to one candidate", async () => {
  const sourceLineup = lineup();
  const result = await searchChinaStrategies(
    { source: sourceLineup.id },
    {
      fetchConfigFn: async () => config(),
      fetchLineupDetailFn: async (region, id) => {
        assert.equal(region, "cn");
        assert.equal(id, sourceLineup.id);
        return { lineup: sourceLineup };
      },
    },
  );

  assert.equal(result.mode, "direct");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.pageInfo.scannedStrategies, 1);
});

test("combines title keyword and selected roles with AND matching", async () => {
  const calls = [];
  const first = lineup();
  const missingMarch = lineup({
    id: "6a56fe3021253d0e1a9f4762",
    title: "姬子科研二號",
    roleIds: ["1510"],
  });
  const wrongTitle = lineup({
    id: "6a56fe3021253d0e1a9f4763",
    title: "列車隊",
  });

  const result = await searchChinaStrategies(
    {
      keyword: "科研",
      roleIds: ["1510", "1001", "1510"],
      maxPages: 2,
      pageSize: 3,
    },
    {
      fetchConfigFn: async () => config(),
      fetchLineupPageFn: async (region, options) => {
        calls.push({ region, options });
        if (options.page === 1) {
          return {
            list: [first, missingMarch, wrongTitle],
            next_page_token: "next",
          };
        }
        return {
          list: [first],
          next_page_token: "still-more",
        };
      },
    },
  );

  assert.equal(result.mode, "search");
  assert.deepEqual(result.query.roleIds, ["1510", "1001"]);
  assert.equal(result.query.roleMatch, "all");
  assert.deepEqual(
    result.candidates.map(({ id }) => id),
    [first.id],
  );
  assert.equal(result.pageInfo.scannedPages, 2);
  assert.equal(result.pageInfo.scannedStrategies, 4);
  assert.equal(result.pageInfo.truncated, true);
  assert.deepEqual(calls[0].options.roleIds, ["1510", "1001"]);
  assert.equal(calls[1].options.nextPageToken, "next");
});

test("matches any internal ID belonging to a grouped upgrade role", async () => {
  let upstreamRoleIds;
  const specialConfig = { role_list: silverWolfVariants };
  const upgradedLineup = lineup({ roleIds: ["15063"] });

  const result = await searchChinaStrategies(
    { roleIds: ["15061"] },
    {
      fetchConfigFn: async () => specialConfig,
      fetchLineupPageFn: async (region, options) => {
        upstreamRoleIds = options.roleIds;
        return { list: [upgradedLineup] };
      },
    },
  );

  assert.deepEqual(upstreamRoleIds, []);
  assert.deepEqual(result.candidates.map(({ id }) => id), [upgradedLineup.id]);
  assert.deepEqual(result.candidates[0].matchedRoleIds, ["15061"]);
  assert.equal(result.candidates[0].roles[0].displayCost, "5");
});

test("filters strategies by author display name", async () => {
  const matching = lineup({ id: "6a56fe3021253d0e1a9f4701" });
  matching.nickname = "田宮良子-Fol";
  const other = lineup({ id: "6a56fe3021253d0e1a9f4702" });
  other.nickname = "另一位作者";

  const result = await searchChinaStrategies(
    { authorKeyword: "田宮良子" },
    {
      fetchConfigFn: async () => config(),
      fetchLineupPageFn: async () => ({ list: [matching, other] }),
    },
  );

  assert.deepEqual(result.candidates.map(({ id }) => id), [matching.id]);
  assert.equal(result.query.authorKeyword, "田宮良子");
});

test("rejects unknown role IDs before scanning recommendation pages", async () => {
  let pageWasFetched = false;

  await assert.rejects(
    searchChinaStrategies(
      { roleIds: ["404"] },
      {
        fetchConfigFn: async () => config(),
        fetchLineupPageFn: async () => {
          pageWasFetched = true;
          return { list: [] };
        },
      },
    ),
    /Unknown China role id: 404/,
  );
  assert.equal(pageWasFetched, false);
});

test("requires at least one search criterion", async () => {
  await assert.rejects(searchChinaStrategies(), /Provide a China strategy/);
});
