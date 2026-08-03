const INPUT_ERROR_PRESENTATIONS = Object.freeze({
  invalid_source: "searchInvalidSource",
  missing_criteria: "searchInvalidCriteria",
  stale_role_ids: "searchStaleRoles",
  stale_bond_ids: "searchStaleBonds",
  invalid_pagination: "searchInvalidPagination",
  invalid_roles: "searchInvalidRoles",
  invalid_bonds: "searchInvalidBonds",
  invalid_request: "searchInvalidGeneric",
});

export function getSearchErrorPresentation(status, payload) {
  const reason = payload?.error?.reason;
  if (
    status === 400 &&
    payload?.error?.code === "invalid_request" &&
    reason in INPUT_ERROR_PRESENTATIONS
  ) {
    return {
      titleKey: "searchInputErrorTitle",
      bodyKey: INPUT_ERROR_PRESENTATIONS[reason],
      refreshRoles: ["stale_role_ids", "stale_bond_ids"].includes(reason),
    };
  }

  return {
    titleKey: "searchErrorTitle",
    bodyKey: "searchErrorBody",
    refreshRoles: false,
  };
}

export function retainKnownRoleIds(selectedRoleIds, rolesById) {
  return [...selectedRoleIds].filter((id) => rolesById.has(String(id)));
}
