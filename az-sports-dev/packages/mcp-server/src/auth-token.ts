const MAX_BEARER_TOKEN_LENGTH = 4096;
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+/;
const STORED_MCP_TOKEN_PREFIX = "azs_";
const BEARER_TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~+/=-";

export function isValidBearerToken(value: string): boolean {
  const match = BEARER_TOKEN_PATTERN.exec(value);
  return (
    value.length > 0 &&
    value.length <= MAX_BEARER_TOKEN_LENGTH &&
    match?.[0].length === value.length
  );
}

export function isValidStoredMcpToken(value: string): boolean {
  return value.startsWith(STORED_MCP_TOKEN_PREFIX) && isValidBearerToken(value);
}

export function normalizedBearerToken(value: string): string {
  if (!isValidBearerToken(value)) {
    throw new Error("Invalid bearer token.");
  }
  const chars: string[] = [];
  for (const char of value) {
    const index = BEARER_TOKEN_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("Invalid bearer token.");
    }
    chars.push(BEARER_TOKEN_ALPHABET[index]);
  }
  return chars.join("");
}

export function normalizedStoredMcpToken(value: string): string {
  const token = normalizedBearerToken(value);
  if (!token.startsWith(STORED_MCP_TOKEN_PREFIX)) {
    throw new Error("Invalid MCP token.");
  }
  return token;
}

export function bearerAuthorizationHeader(token: string): string {
  return `Bearer ${normalizedBearerToken(token)}`;
}
