import { createHash } from "node:crypto";

const STAGES = new Set(["Early", "Middle", "Final"]);

export function stripCalculatedTitlePrefix(value) {
  const title = String(value ?? "").trim();
  const stripped = title.replace(/^(?:【[^】]*】\s*)+/u, "").trimStart();

  // A generated bond prefix should never be the whole user-visible title.
  // Keep the source value as a safe fallback if the source has no text after it.
  return stripped || title;
}

function idSet(list, key = "id") {
  return new Set((list ?? []).map((item) => String(item[key])));
}

function nestedIdSet(list, childKeys, key = "id") {
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

function allowedIds(config) {
  return {
    roles: idSet(config.role_list),
    // Basic equipment is nested under advanced equipment's compose_list in
    // the public configuration, while published lineups refer to those
    // nested items directly.
    equipment: nestedIdSet(
      config.equipment_list,
      ["compose_list", "childrens"],
    ),
    fightAugments: idSet(config.fight_augment_list),
    portals: idSet(config.portal_list),
    labels: idSet(config.label_list),
  };
}

function ignore(ignored, type, id, path, reason = "missing-in-global-config") {
  ignored.push({
    type,
    id: String(id),
    path,
    reason,
  });
}

function filterIdItems(items, allowed, ignored, type, path) {
  const kept = [];

  for (const [index, item] of (items ?? []).entries()) {
    const id = String(item?.id ?? "");
    if (id && allowed.has(id)) {
      kept.push({ id });
    } else if (id) {
      ignore(ignored, type, id, `${path}[${index}]`);
    }
  }

  return kept;
}

function transformRole(
  role,
  path,
  ids,
  ignored,
) {
  const id = String(role?.id ?? "");
  if (!id || !ids.roles.has(id)) {
    if (id) {
      ignore(ignored, "role", id, path);
    }
    return null;
  }

  const firstEquipments = filterIdItems(
    role.first_equipments,
    ids.equipment,
    ignored,
    "equipment",
    `${path}.first_equipments`,
  );
  const secondEquipments = filterIdItems(
    role.second_equipments,
    ids.equipment,
    ignored,
    "equipment",
    `${path}.second_equipments`,
  );

  let recEquipIndex = Number(role.rec_equip_index ?? -1);
  if (recEquipIndex >= 0 && firstEquipments.length === 0) {
    ignore(
      ignored,
      "recommended-equipment-slot",
      id,
      `${path}.rec_equip_index`,
      "all-recommended-equipment-was-ignored",
    );
    recEquipIndex = -1;
  }

  return {
    id,
    rec_equip_index: recEquipIndex,
    board_index: Number(role.board_index ?? 0),
    star: Number(role.star ?? 1),
    is_carry: Boolean(role.is_carry),
    first_equipments: firstEquipments,
    second_equipments: secondEquipments,
  };
}

function transformStage(stage, stageIndex, ids, ignored) {
  const path = `tourn_detail.role_stages[${stageIndex}]`;
  const stageName = STAGES.has(stage?.stage)
    ? stage.stage
    : ["Early", "Middle", "Final"][stageIndex];

  const frontRoles = (stage?.front_roles ?? [])
    .map((role, index) =>
      transformRole(
        role,
        `${path}.front_roles[${index}]`,
        ids,
        ignored,
      ),
    )
    .filter(Boolean)
    .sort((a, b) => a.board_index - b.board_index);

  const backRoles = (stage?.back_roles ?? [])
    .map((role, index) =>
      transformRole(
        role,
        `${path}.back_roles[${index}]`,
        ids,
        ignored,
      ),
    )
    .filter(Boolean)
    .sort((a, b) => a.board_index - b.board_index);

  const survivingRoleIds = new Set(
    [...frontRoles, ...backRoles].map((role) => role.id),
  );
  const carryList = [];

  for (const [index, carryIdValue] of (stage?.carry_list ?? []).entries()) {
    const carryId = String(carryIdValue);
    if (survivingRoleIds.has(carryId)) {
      carryList.push(carryId);
    } else {
      ignore(
        ignored,
        "carry-role",
        carryId,
        `${path}.carry_list[${index}]`,
        "referenced-role-was-ignored",
      );
    }
  }

  return {
    back_roles: backRoles,
    front_roles: frontRoles,
    carry_list: carryList,
    stage: stageName,
    // The official editor intentionally clears this when importing a
    // published lineup, then recalculates it from the selected roles.
    switch_role_map: {},
  };
}

export function toGlobalPublishPayload(sourceLineup, globalConfig) {
  if (!sourceLineup?.id || !sourceLineup?.tourn_detail) {
    throw new TypeError("A complete source lineup detail is required");
  }

  const ignored = [];
  const ids = allowedIds(globalConfig);
  const detail = sourceLineup.tourn_detail;
  const stages = (detail.role_stages ?? [])
    .slice(0, 3)
    .map((stage, index) => transformStage(stage, index, ids, ignored));

  while (stages.length < 3) {
    const index = stages.length;
    ignored.push({
      type: "stage",
      id: ["Early", "Middle", "Final"][index],
      path: `tourn_detail.role_stages[${index}]`,
      reason: "missing-in-source",
    });
    stages.push(
      transformStage(
        { stage: ["Early", "Middle", "Final"][index] },
        index,
        ids,
        ignored,
      ),
    );
  }

  const payload = {
    // Remove the China-language summary from the editable title. The transfer
    // orchestrator later rebuilds it with global zh-tw trait names, matching
    // the official editor's client-side save behaviour.
    title: stripCalculatedTitlePrefix(sourceLineup.title),
    description: String(sourceLineup.description ?? ""),
    lineup_type: "Tourn",
    tourn_detail: {
      support_hard: Boolean(detail.support_hard),
      order_compose: filterIdItems(
        detail.order_compose,
        ids.equipment,
        ignored,
        "equipment",
        "tourn_detail.order_compose",
      ),
      order_basic: filterIdItems(
        detail.order_basic,
        ids.equipment,
        ignored,
        "equipment",
        "tourn_detail.order_basic",
      ),
      first_fight_augments: filterIdItems(
        detail.first_fight_augments,
        ids.fightAugments,
        ignored,
        "fight-augment",
        "tourn_detail.first_fight_augments",
      ),
      second_fight_augments: filterIdItems(
        detail.second_fight_augments,
        ids.fightAugments,
        ignored,
        "fight-augment",
        "tourn_detail.second_fight_augments",
      ),
      portals: filterIdItems(
        detail.portals,
        ids.portals,
        ignored,
        "portal",
        "tourn_detail.portals",
      ),
      labels: filterIdItems(
        detail.labels,
        ids.labels,
        ignored,
        "label",
        "tourn_detail.labels",
      ),
      role_stages: stages,
      rpg_game_big_version: String(globalConfig.rpg_game_big_version),
      season_id: String(globalConfig.season_id),
      sub_season_id: String(globalConfig.sub_season_id),
    },
  };

  return {
    sourceId: sourceLineup.id,
    payload,
    ignored,
    contentHash: contentHash(payload),
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(payload) {
  return createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex");
}
