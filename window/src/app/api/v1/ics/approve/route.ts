import { approvePreview } from "../../../../../application/imports";
import { hasExactKeys, readBoundedJsonObject, RequestBoundaryError } from "../../request-boundary";

const headers = { "cache-control": "private, no-store" } as const;
const MAX_APPROVAL_BYTES = 5 * 1_024 * 1_024;

export const POST = async (request: Request): Promise<Response> => {
  try {
    const body = await readBoundedJsonObject(request, MAX_APPROVAL_BYTES);
    if (!hasExactKeys(body, ["command", "preview", "state"])) throw new Error("invalid");
    return Response.json(approvePreview(body.state as never, body.preview as never, body.command as never), { status: 200, headers });
  } catch (error) {
    const status = error instanceof RequestBoundaryError ? error.status : 409;
    return Response.json({ error: { code: error instanceof RequestBoundaryError ? error.code : "INVALID_APPROVAL" } }, { status, headers });
  }
};
