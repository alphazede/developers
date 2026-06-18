export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function normalizeApiBaseUrl(value: string): string {
  const normalized = stripTrailingSlashes(value.trim());
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API URL must use http or https.");
  }
  if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) {
    throw new Error(
      "API URL must use https unless it targets localhost or loopback.",
    );
  }
  if (url.username || url.password) {
    throw new Error("API URL must not include credentials.");
  }
  return normalized;
}

export function buildApiUrl(baseUrl: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("API path must start with exactly one '/'.");
  }
  const normalizedBaseUrl = normalizeApiBaseUrl(baseUrl);
  const base = new URL(`${normalizedBaseUrl}/`);
  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin) {
    throw new Error("API path must resolve within the configured API origin.");
  }
  return resolved.href;
}

function isLocalHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    normalized === "::1"
  ) {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return true;
  }
  return false;
}
