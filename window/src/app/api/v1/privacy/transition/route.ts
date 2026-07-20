import { NextResponse } from "next/server";

import { deleteProfile, deleteSource, forgetPattern, prunePrivacy, revokeSource, type PrivacyStateV1 } from "../../../../../application/privacy";
import { hasExactKeys, readBoundedJsonObject, RequestBoundaryError } from "../../request-boundary";

const MAX_PRIVACY_BYTES = 5 * 1_024 * 1_024;

export async function POST(request: Request) {
  try {
    const body = await readBoundedJsonObject(request, MAX_PRIVACY_BYTES) as { state: PrivacyStateV1; command: Record<string, unknown> };
    if (!hasExactKeys(body, ["command", "state"]) || !body.state || !body.command) throw new RangeError("INVALID_PRIVACY_TRANSITION");
    const result = body.command.kind === "revoke-source" ? revokeSource(body.state, body.command as never)
      : body.command.kind === "delete-source" ? deleteSource(body.state, body.command as never)
        : body.command.kind === "forget-pattern" ? forgetPattern(body.state, body.command as never)
          : body.command.kind === "delete-profile" ? deleteProfile(body.state, body.command as never)
            : body.command.kind === "prune" ? prunePrivacy(body.state, body.command as never)
              : (() => { throw new RangeError("INVALID_PRIVACY_TRANSITION"); })();
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_PRIVACY_TRANSITION";
    const status = error instanceof RequestBoundaryError ? error.status : code === "REVISION_CONFLICT" ? 409 : 400;
    return NextResponse.json({ schemaVersion: 1, code }, { status, headers: { "cache-control": "private, no-store" } });
  }
}
