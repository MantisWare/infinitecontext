/**
 * Normalise S3 endpoint URL for stable CAS cache binding keys.
 *
 * @param {string | undefined} endpoint
 * @returns {string}
 */
export function normalizeStorageCasEndpoint(endpoint) {
  const raw = String(endpoint ?? "").trim();
  if (!raw) {
    return "aws";
  }
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
  let host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    host = "loopback";
  }
  let port = url.port;
  if (!port) {
    port = url.protocol === "https:" ? "443" : "80";
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${host}:${port}${path}`;
}
