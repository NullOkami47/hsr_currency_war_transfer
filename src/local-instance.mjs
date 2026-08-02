export async function localInstanceMatches(
  url,
  expectedInstanceId,
  { fetchFn = fetch } = {},
) {
  if (!expectedInstanceId || !url) return false;
  try {
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(1000),
      cache: "no-store",
    });
    return response.ok
      && response.headers.get("x-currency-war-instance") === expectedInstanceId;
  } catch {
    return false;
  }
}
