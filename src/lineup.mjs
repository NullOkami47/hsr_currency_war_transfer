export function finalStage(lineup) {
  const stages = lineup?.tourn_detail?.role_stages ?? [];
  return stages.find((stage) => stage.stage === "Final") ?? stages.at(-1);
}
