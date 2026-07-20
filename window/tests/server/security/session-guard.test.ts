import { describe, expect, it, vi } from "vitest";

import { SessionGuard, SessionGuardConfigError } from "../../../src/server/security/session-guard";

const valid = { cookie: "sid=server-session", origin: "https://local.test", csrf: "csrf-value", revision: 1, currentRevision: 1, commandId: "command", idempotencyKey: "idempotency" };
const guard = new SessionGuard({ session: "server-session", csrf: "csrf-value", origin: "https://local.test" });

describe("SessionGuard", () => {
  it("rejects invalid configuration with one secret-free typed error", () => {
    const invalid = [
      { session: "", csrf: "csrf-value", origin: valid.origin },
      { session: "  ", csrf: "csrf-value", origin: valid.origin },
      { session: "server; Domain=evil.invalid", csrf: "csrf-value", origin: valid.origin },
      { session: "server-session", csrf: "", origin: valid.origin },
      { session: "server-session", csrf: " server-csrf", origin: valid.origin },
      { session: "server-session", csrf: "server-csrf\r\nInjected: true", origin: valid.origin },
      { session: "same-secret", csrf: "same-secret", origin: valid.origin },
      { session: "server-session", csrf: "csrf-value", origin: "" },
      { session: "server-session", csrf: "csrf-value", origin: "https://local.test/path" },
      { session: "server-session", csrf: "csrf-value", origin: "https://local.test?query=true" },
      { session: "server-session", csrf: "csrf-value", origin: "https://local.test#fragment" },
      { session: "server-session", csrf: "csrf-value", origin: "https://user:pass@local.test" },
      { session: "server-session", csrf: "csrf-value", origin: "https://local.test/" },
      { session: "server-session", csrf: "csrf-value", origin: "https://local.test:443" },
      { session: "server-session", csrf: "csrf-value", origin: "not-an-origin" },
      { session: "server-session", csrf: "csrf-value", origin: valid.origin, cookieName: "" },
      { session: "server-session", csrf: "csrf-value", origin: valid.origin, cookieName: "sid; Path=/" },
      { session: "server-session", csrf: "csrf-value", origin: valid.origin, cookieName: "sid.v1" },
      { session: "server-session", csrf: "csrf-value", origin: valid.origin, maxCommandLength: 0 },
    ];
    for (const config of invalid) {
      expect(() => new SessionGuard(config)).toThrow(SessionGuardConfigError);
      try { new SessionGuard(config); } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_SESSION_GUARD_CONFIG", message: "INVALID_SESSION_GUARD_CONFIG" });
        expect(JSON.stringify(error)).not.toMatch(/same-secret|server-session|csrf-value|local\.test/);
      }
    }
  });

  it("accepts conservative opaque tokens and a canonical loopback Origin", () => {
    const configured = new SessionGuard({
      session: "Session._~-123",
      csrf: "Csrf._~-456",
      origin: "http://127.0.0.1:3000",
      cookieName: "sid_v1-2",
    });
    expect(configured.cookie()).toBe("sid_v1-2=Session._~-123; HttpOnly; SameSite=Strict; Path=/");
    expect(configured.requireMutation({
      cookie: "sid_v1-2=Session._~-123",
      origin: "http://127.0.0.1:3000",
      csrf: "Csrf._~-456",
      revision: 0,
      currentRevision: 0,
      commandId: "command",
      idempotencyKey: "idempotency",
    })).toEqual({ ok: true });
  });

  it("requires one server session cookie and the exact Origin", () => {
    expect(guard.requireRead(valid)).toEqual({ ok: true });
    expect(guard.requireRead({ origin: valid.origin })).toEqual({ ok: false, code: "UNAUTHENTICATED" });
    expect(guard.requireRead({ cookie: "sid=wrong", origin: valid.origin })).toEqual({ ok: false, code: "UNAUTHENTICATED" });
    expect(guard.requireRead({ cookie: "sid=server-session; sid=wrong", origin: valid.origin })).toEqual({ ok: false, code: "UNAUTHENTICATED" });
    expect(guard.requireRead({ cookie: valid.cookie })).toEqual({ ok: false, code: "FORBIDDEN_ORIGIN" });
    expect(guard.requireRead({ cookie: valid.cookie, origin: "https://local.test.evil" })).toEqual({ ok: false, code: "FORBIDDEN_ORIGIN" });
    expect(guard.cookie()).toBe("sid=server-session; HttpOnly; SameSite=Strict; Path=/");
  });

  it("uses fixed-size secret comparisons and validates all authority before work", () => {
    const work = vi.fn();
    for (const input of [
      { ...valid, csrf: "x" },
      { ...valid, revision: -1, currentRevision: -1 },
      { ...valid, revision: Number.MAX_SAFE_INTEGER + 1, currentRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, currentRevision: 2 },
      { ...valid, currentRevision: undefined },
      { ...valid, commandId: "" },
      { ...valid, commandId: " command" },
      { ...valid, commandId: "x".repeat(129) },
      { ...valid, commandId: 7 as unknown as string },
      { ...valid, idempotencyKey: "" },
      { ...valid, idempotencyKey: "key " },
      { ...valid, idempotencyKey: "x".repeat(129) },
      { ...valid, idempotencyKey: 7 as unknown as string },
    ]) expect(guard.requireMutation(input, work).ok).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(guard.requireMutation(valid, work)).toEqual({ ok: true });
    expect(work).toHaveBeenCalledOnce();
  });

  it("allows the first guarded mutation at LocalStore revision zero", () => {
    const work = vi.fn();
    const firstMutation = { ...valid, revision: 0, currentRevision: 0 };
    expect(guard.requireMutation(firstMutation, work)).toEqual({ ok: true });
    expect(work).toHaveBeenCalledOnce();
    expect(guard.requireMutation({ ...firstMutation, currentRevision: 1 }, work)).toEqual({ ok: false, code: "STALE_REVISION" });
    expect(work).toHaveBeenCalledOnce();
  });

  it("bounds command values by bytes and returns secret-free codes", () => {
    const small = new SessionGuard({ session: "session-secret", csrf: "csrf-secret", origin: valid.origin, maxCommandLength: 4 });
    expect(small.requireMutation({ ...valid, cookie: "sid=session-secret", csrf: "csrf-secret", commandId: "ééé", idempotencyKey: "key" })).toEqual({ ok: false, code: "INVALID_COMMAND" });
    const failure = small.requireMutation({ ...valid, cookie: "sid=session-secret", csrf: "supplied-secret" });
    expect(JSON.stringify(failure)).not.toMatch(/session-secret|csrf-secret|supplied-secret/);
  });
});
