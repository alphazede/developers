import { NextResponse } from "next/server";

import { ExplanationPresenter } from "../../../../application/explanation";
import { readBoundedJsonObject, RequestBoundaryError } from "../request-boundary";

const MAX_EXPLANATION_BYTES = 64 * 1_024;

export async function POST(request: Request) {
  try {
    const explanation = await new ExplanationPresenter().present(await readBoundedJsonObject(request, MAX_EXPLANATION_BYTES) as never);
    return NextResponse.json(explanation, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof RequestBoundaryError ? error.status : 400;
    return NextResponse.json({ schemaVersion: 1, code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_EXPLANATION_PACKET" }, { status, headers: { "cache-control": "private, no-store" } });
  }
}
