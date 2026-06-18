/**
 * AlphaZede Sports MCP Server schemas and shared type re-exports.
 *
 * API response shapes come from public MCP type definitions.
 */

import { type AzsTier, type Sport, sportsAsNonEmptyTuple } from "./public-types.js";
import { z } from "zod";

export type {
  DriftPoint,
  FutureGame,
  Game,
  GameBoardResponse,
  GamesResponse,
  MovementEntry,
  MovementHistoryResponse,
  Prop,
  SgpEvaluateResponse,
  Sport,
} from "./public-types.js";

export const SUPPORTED_SPORTS = sportsAsNonEmptyTuple();

export const SUPPORTED_SPORTS_DESCRIPTION = SUPPORTED_SPORTS.join(", ");

export const sportEnum = z.enum(SUPPORTED_SPORTS);

export const KNOWN_TIERS = [
  "POD",
  "LOCK",
  "STANDARD",
  "EXPERIMENTAL",
  "LOTTO",
] as const satisfies readonly AzsTier[];

// ---------------------------------------------------------------------------
// MCP tool input schemas
// ---------------------------------------------------------------------------

export interface FindGameMarketsInput {
  sport: Sport;
  date?: string;
  game_id?: string;
}

interface AnalyzeParlayLeg {
  prop_id: string;
  side: "over" | "under";
  player: string;
  stat: string;
  line: number;
  sport?: Sport;
  game_id?: string;
}

export interface AnalyzeParlayInput {
  sport: Sport;
  game_id: string;
  sportsbook_parlay_odds?: number;
  legs: AnalyzeParlayLeg[];
}

export interface PricePlayerPropInput {
  sport: Sport;
  game_id: string;
  player_name?: string;
  prop_type?: string;
  include_movement?: boolean;
}

export interface ExplainEdgeInput {
  sport: Sport;
  game_id: string;
  prop_id: string;
}

export interface GetDailyPicksInput {
  sport?: Sport;
  date?: string;
  limit?: number;
}
