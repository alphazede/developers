import { NextResponse } from "next/server";

import { buildJordanTodayProjection } from "../../../../runtime/today-fixture";

const headers = {
  "cache-control": "private, no-store",
  "content-type": "application/vnd.capacity-scheduling.today.v1+json",
} as const;

export const dynamic = "force-dynamic";

export const GET = async (): Promise<NextResponse> => {
  try {
    return NextResponse.json(await buildJordanTodayProjection(), { headers });
  } catch {
    return NextResponse.json({
      error: {
        code: "TODAY_FIXTURE_UNAVAILABLE",
        message: "Today data is unavailable.",
        retriable: false,
      },
    }, { status: 500, headers });
  }
};
