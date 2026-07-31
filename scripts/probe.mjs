import {
  fetchConfig,
  fetchLineupDetail,
  fetchLineupPage,
  parseChinaLineupInput,
} from "../src/api.mjs";
import { toGlobalPublishPayload } from "../src/transform.mjs";

function summariseConfig(config) {
  return {
    version: config.rpg_game_big_version,
    seasonId: config.season_id,
    subSeasonId: config.sub_season_id,
    roles: config.role_list?.length ?? 0,
    traits: config.trait_info_list?.length ?? 0,
    equipment: config.equipment_list?.length ?? 0,
    fightAugments: config.fight_augment_list?.length ?? 0,
    portals: config.portal_list?.length ?? 0,
    labels: config.label_list?.length ?? 0,
  };
}

function ids(list, key = "id") {
  return new Set((list ?? []).map((item) => String(item[key])));
}

function nestedIds(list, childKeys, key = "id") {
  const result = new Set();
  const pending = [...(list ?? [])];
  const nestedKeys = new Set(childKeys);

  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) {
      continue;
    }
    if (item[key] !== undefined && item[key] !== null) {
      result.add(String(item[key]));
    }
    for (const childKey of nestedKeys) {
      if (Array.isArray(item[childKey])) {
        pending.push(...item[childKey]);
      }
    }
  }

  return result;
}

function compareIds(cnConfig, globalConfig) {
  const groups = [
    ["roles", "role_list", "id"],
    ["traits", "trait_info_list", "trait_id"],
    [
      "equipment",
      "equipment_list",
      "id",
      ["compose_list", "childrens"],
    ],
    ["fightAugments", "fight_augment_list", "id"],
    ["portals", "portal_list", "id"],
    ["labels", "label_list", "id"],
  ];

  return Object.fromEntries(
    groups.map(([name, field, key, childKey]) => {
      const cn = childKey
        ? nestedIds(cnConfig[field], childKey, key)
        : ids(cnConfig[field], key);
      const global = childKey
        ? nestedIds(globalConfig[field], childKey, key)
        : ids(globalConfig[field], key);
      return [
        name,
        {
          cn: cn.size,
          global: global.size,
          cnOnly: [...cn].filter((id) => !global.has(id)).length,
          globalOnly: [...global].filter((id) => !cn.has(id)).length,
        },
      ];
    }),
  );
}

async function main() {
  const input = process.argv[2];
  const [cnConfig, globalConfig] = await Promise.all([
    fetchConfig("cn"),
    fetchConfig("global"),
  ]);

  let sourceId;
  if (input) {
    sourceId = parseChinaLineupInput(input);
  } else {
    const firstPage = await fetchLineupPage("cn", { limit: 1 });
    sourceId = firstPage.list?.[0]?.id;
  }

  if (!sourceId) {
    throw new Error("China recommendation API returned no lineups");
  }

  const sourceResult = await fetchLineupDetail("cn", sourceId);
  const sourceLineup = sourceResult.lineup;
  const transformed = toGlobalPublishPayload(sourceLineup, globalConfig);

  console.log(
    JSON.stringify(
      {
        anonymousRead: {
          chinaConfig: summariseConfig(cnConfig),
          globalConfig: summariseConfig(globalConfig),
          idCompatibility: compareIds(cnConfig, globalConfig),
        },
        sample: {
          sourceId,
          title: sourceLineup.title,
          author: sourceLineup.nickname,
          sourceShareCode: sourceLineup.tourn_detail?.share_code,
          contentHash: transformed.contentHash,
          ignoredCount: transformed.ignored.length,
          ignored: transformed.ignored,
        },
        write: {
          attempted: false,
          reason:
            "The probe intentionally stops before the authenticated global create/edit call.",
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
