import type { Identity } from "./tool.js";

export function classifyIdentity(token: string | null | undefined): Identity {
  if (!token || token.trim() === "") {
    throw new Error("Empty token cannot be classified");
  }

  if (token.startsWith("azs_at_")) {
    return { kind: "oauth", token };
  }
  if (token.startsWith("azs_")) {
    return { kind: "api_key", token };
  }
  return { kind: "system", token };
}
