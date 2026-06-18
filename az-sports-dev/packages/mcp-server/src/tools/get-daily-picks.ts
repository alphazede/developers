/**
 * Tool: get_daily_picks
 *
 * Get top-rated props across all or a specific sport for a given date.
 * Aggregates data from multiple API endpoints and ranks by grade quality.
 */

import { z } from "zod";
import type { AzsClient } from "../client.js";
import {
  formatDailyPicks,
  gradeWeight,
  propGrade,
  type RankedPick,
} from "../format.js";
import { defineTool } from "../tool.js";
import {
  type Sport,
  SUPPORTED_SPORTS,
  SUPPORTED_SPORTS_DESCRIPTION,
  sportEnum,
} from "../types.js";
import { todayString } from "../util.js";

const getDailyPicksParamsShape = {
  sport: sportEnum
    .optional()
    .describe(
      `Filter to a specific sport (${SUPPORTED_SPORTS_DESCRIPTION}). If omitted, scans all supported sports.`,
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .optional()
    .describe("Date in YYYY-MM-DD format. Defaults to today if not provided."),
  limit: z
    .number()
    .min(1)
    .max(25)
    .optional()
    .describe("Maximum number of picks to return (default: 10, max: 25)"),
};

const GET_DAILY_PICKS_NAME_VALUE = "get_daily_picks";
const GET_DAILY_PICKS_DESCRIPTION_VALUE =
  "Get today's top-rated props across all or a specific sport. " +
  "Returns a ranked list of the best current opportunities with game context, " +
  `prop details, and analysis grades. Supported sports: ${SUPPORTED_SPORTS_DESCRIPTION}. Useful for a quick daily overview.`;

/** Cap concurrent gameboard requests to avoid overwhelming the API. */
async function fetchGameboardsBatched(
  client: AzsClient,
  sport: Sport,
  gameIds: string[],
  batchSize = 10,
): Promise<
  Array<{
    game_id: string;
    board: Awaited<ReturnType<AzsClient["getGameboard"]>> | null;
  }>
> {
  const results: Array<{
    game_id: string;
    board: Awaited<ReturnType<AzsClient["getGameboard"]>> | null;
  }> = [];
  for (let i = 0; i < gameIds.length; i += batchSize) {
    const batch = gameIds.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((gid) =>
        client
          .getGameboard(sport, gid)
          .then((b) => ({ game_id: gid, board: b })),
      ),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      }
    }
  }
  return results;
}

export const getDailyPicksTool = defineTool({
  name: GET_DAILY_PICKS_NAME_VALUE,
  description: GET_DAILY_PICKS_DESCRIPTION_VALUE,
  params: getDailyPicksParamsShape,
  handler: async (ctx, input) => {
    const client = ctx.client;
    const date = input.date ?? todayString();
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 25);
    const sports: Sport[] = input.sport ? [input.sport] : [...SUPPORTED_SPORTS];

    const allPicks: RankedPick[] = [];

    // Fetch all sports' games in parallel
    const gamesResults = await Promise.allSettled(
      sports.map((sport) =>
        client.listGames(sport, date).then((r) => ({ sport, games: r.games })),
      ),
    );

    // Collect games to fetch gameboards for, filtering out cancelled/postponed/final
    const gameboardRequests: Array<{
      sport: Sport;
      games: Array<{
        game_id: string;
        home_team: string;
        away_team: string;
        start_time: string;
      }>;
    }> = [];

    for (const result of gamesResults) {
      if (result.status !== "fulfilled") continue;
      const { sport, games } = result.value;
      const eligible = games.filter(
        (g) =>
          g.prop_count > 0 && (g.status === "scheduled" || g.status === "live"),
      );
      // Cap at 5 games per sport
      const gamesToFetch = eligible.slice(0, 5);
      if (gamesToFetch.length > 0) {
        gameboardRequests.push({
          sport,
          games: gamesToFetch.map((g) => ({
            game_id: g.game_id,
            home_team: g.home_team,
            away_team: g.away_team,
            start_time: g.start_time,
          })),
        });
      }
    }

    // Fetch gameboards in parallel per sport, capped at 10 concurrent
    const boardResults = await Promise.allSettled(
      gameboardRequests.map(({ sport, games }) =>
        fetchGameboardsBatched(
          client,
          sport,
          games.map((g) => g.game_id),
        ).then((boards) => ({ sport, games, boards })),
      ),
    );

    for (const result of boardResults) {
      if (result.status !== "fulfilled") continue;
      const { sport, games, boards } = result.value;
      for (const boardEntry of boards) {
        if (!boardEntry.board) continue;
        const game = games.find((g) => g.game_id === boardEntry.game_id);
        if (!game) continue;
        for (const prop of boardEntry.board.props) {
          const grade = propGrade(prop);
          if (grade !== "--" && grade !== "D") {
            allPicks.push({
              sport,
              game_id: game.game_id,
              home_team: game.home_team,
              away_team: game.away_team,
              start_time: game.start_time,
              prop,
            });
          }
        }
      }
    }

    // Sort by grade quality (best first)
    allPicks.sort(
      (a, b) => gradeWeight(propGrade(a.prop)) - gradeWeight(propGrade(b.prop)),
    );

    // Return top N
    const topPicks = allPicks.slice(0, limit);
    return formatDailyPicks(topPicks, date);
  },
});
