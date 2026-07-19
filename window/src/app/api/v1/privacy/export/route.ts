import { NextResponse } from "next/server";

import { exportPrivacy, type PrivacyStateV1 } from "../../../../../application/privacy";
import { hasExactKeys, readBoundedJsonObject, RequestBoundaryError } from "../../request-boundary";

const MAX_PRIVACY_BYTES = 5 * 1_024 * 1_024;

export async function POST(request: Request) {
  try {
    const body = await readBoundedJsonObject(request, MAX_PRIVACY_BYTES) as { state: PrivacyStateV1 };
    if (!hasExactKeys(body, ["state"]) || !body.state || body.state.schemaVersion !== 1 || !Array.isArray(body.state.connectors)) throw new RangeError("INVALID_PRIVACY_STATE");
    return NextResponse.json(exportPrivacy(body.state), { headers: { "cache-control": "private, no-store", "content-disposition": "attachment; filename=privacy-export.json" } });
  } catch (error) {
    const status = error instanceof RequestBoundaryError ? error.status : 400;
    return NextResponse.json({ schemaVersion: 1, code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_PRIVACY_EXPORT" }, { status, headers: { "cache-control": "private, no-store" } });
  }
}
