import { IcsBoundaryError, parsePreview } from "../../../../../adapters/ics";
import { readBoundedBytes, RequestBoundaryError } from "../../request-boundary";

const headers = { "cache-control": "private, no-store" } as const;
const MAX_ICS_BYTES = 5 * 1_024 * 1_024;

export const POST = async (request: Request): Promise<Response> => {
  try {
    const revisionHeader = request.headers.get("x-consent-revision");
    const consentRevision = revisionHeader === null ? Number.NaN : Number(revisionHeader);
    const fetchedAt = request.headers.get("x-fetched-at") ?? "";
    const preview = await parsePreview(await readBoundedBytes(request, MAX_ICS_BYTES), { consentRevision, fetchedAt });
    return Response.json(preview, { status: 200, headers });
  } catch (error) {
    const code = error instanceof RequestBoundaryError ? error.code : error instanceof IcsBoundaryError ? error.code : "MALFORMED_CALENDAR";
    const status = error instanceof RequestBoundaryError ? error.status : code === "OVERSIZED_SOURCE" ? 413 : 422;
    return Response.json({ error: { code } }, { status, headers });
  }
};
