import { exportApproved } from "../../../../../adapters/ics";
import { hasExactKeys, readBoundedJsonObject, RequestBoundaryError } from "../../request-boundary";

const MAX_EXPORT_BYTES = 5 * 1_024 * 1_024;

export const POST = async (request: Request): Promise<Response> => {
  try {
    const body = await readBoundedJsonObject(request, MAX_EXPORT_BYTES);
    if (!hasExactKeys(body, ["items"]) || !Array.isArray(body.items)) throw new Error("invalid");
    return new Response(exportApproved(body.items as never), {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": "attachment; filename=approved-schedule.ics",
      },
    });
  } catch (error) {
    const status = error instanceof RequestBoundaryError ? error.status : 422;
    return Response.json({ error: { code: error instanceof RequestBoundaryError ? error.code : "INVALID_EXPORT" } }, { status, headers: { "cache-control": "private, no-store" } });
  }
};
