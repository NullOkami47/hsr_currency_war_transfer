export function requestAddress(request, {
  vercel = process.env.VERCEL === "1",
  trustProxy = process.env.CURRENCY_WAR_TRUST_PROXY === "1",
} = {}) {
  const forwarded = vercel
    ? request.headers?.["x-vercel-forwarded-for"]
    : trustProxy
      ? request.headers?.["x-forwarded-for"]
      : undefined;
  const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(candidate ?? request.socket?.remoteAddress ?? "unknown")
    .split(",", 1)[0]
    .trim()
    .slice(0, 200);
}
