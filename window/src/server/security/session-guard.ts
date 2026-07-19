import { createHash, timingSafeEqual } from "node:crypto";

export type GuardError = "UNAUTHENTICATED" | "FORBIDDEN_ORIGIN" | "FORBIDDEN_CSRF" | "STALE_REVISION" | "INVALID_COMMAND" | "INVALID_IDEMPOTENCY_KEY";
export type GuardResult = { ok: true } | { ok: false; code: GuardError };
type ReadInput = { cookie?: string; origin?: string };
type MutationInput = ReadInput & { csrf?: string; revision?: number; currentRevision?: number; commandId?: string; idempotencyKey?: string };
type Config = { session: string; csrf: string; origin: string; cookieName?: string; maxCommandLength?: number };

export class SessionGuardConfigError extends Error {
  readonly code = "INVALID_SESSION_GUARD_CONFIG" as const;
  constructor() { super("INVALID_SESSION_GUARD_CONFIG"); this.name = "SessionGuardConfigError"; }
}

const digest = (value: string | undefined) => createHash("sha256").update(typeof value === "string" ? value : "").digest();
const equalSecret = (left: string | undefined, right: string) => timingSafeEqual(digest(left), digest(right)) && typeof left === "string";
const cookieValue = (cookie: string | undefined, name: string) => {
  const matches = cookie?.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)) ?? [];
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : undefined;
};
const bounded = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value === value.trim() && Buffer.byteLength(value) <= max;
const validOrigin = (value: unknown) => {
  if (typeof value !== "string" || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.origin === value && ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
};
const validCookieName = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const validSecret = (value: unknown) => bounded(value, 512) && /^[A-Za-z0-9._~-]+$/.test(value as string);

/** Small deterministic HTTP authority boundary; route handlers own status mapping. */
export class SessionGuard {
  private readonly cookieName: string;
  private readonly max: number;
  constructor(private readonly config: Config) {
    const cookieName = config.cookieName ?? "sid";
    const max = config.maxCommandLength ?? 128;
    if (!validSecret(config.session) || !validSecret(config.csrf) || config.session === config.csrf
      || !validOrigin(config.origin) || !validCookieName(cookieName) || !Number.isSafeInteger(max) || max <= 0) {
      throw new SessionGuardConfigError();
    }
    this.cookieName = cookieName;
    this.max = max;
  }
  cookie() { return `${this.cookieName}=${this.config.session}; HttpOnly; SameSite=Strict; Path=/`; }
  requireRead(input: ReadInput): GuardResult {
    if (!equalSecret(cookieValue(input.cookie, this.cookieName), this.config.session)) return { ok: false, code: "UNAUTHENTICATED" };
    return input.origin === this.config.origin ? { ok: true } : { ok: false, code: "FORBIDDEN_ORIGIN" };
  }
  requireMutation(input: MutationInput, callback?: () => void): GuardResult {
    const read = this.requireRead(input); if (!read.ok) return read;
    if (!equalSecret(input.csrf, this.config.csrf)) return { ok: false, code: "FORBIDDEN_CSRF" };
    if (!Number.isSafeInteger(input.revision) || input.revision! < 0 || !Number.isSafeInteger(input.currentRevision)
      || input.currentRevision! < 0 || input.revision !== input.currentRevision) return { ok: false, code: "STALE_REVISION" };
    if (!bounded(input.commandId, this.max)) return { ok: false, code: "INVALID_COMMAND" };
    if (!bounded(input.idempotencyKey, this.max)) return { ok: false, code: "INVALID_IDEMPOTENCY_KEY" };
    callback?.(); return { ok: true };
  }
}
