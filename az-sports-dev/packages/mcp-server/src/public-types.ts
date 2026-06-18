export const SPORT_SLUGS = [
  "nba",
  "ncaab",
  "wnba",
  "ncaawb",
  "nfl",
  "ncaaf",
  "mlb",
  "nhl",
  "epl",
  "laliga",
  "bundesliga",
  "seriea",
  "ligue1",
  "mls",
  "champions_league",
  "liga_mx",
  "saudi_pro",
  "tennis_atp",
  "tennis_wta",
  "pga",
  "liv_golf",
  "euro_tour",
  "mma",
  "cricket",
  "darts",
] as const;

export type Sport = (typeof SPORT_SLUGS)[number];
export type SportSlugTuple = readonly [Sport, ...Sport[]];

export function sportsAsNonEmptyTuple(): SportSlugTuple {
  return SPORT_SLUGS as SportSlugTuple;
}

export type AzsTier =
  | "POD"
  | "LOCK"
  | "STANDARD"
  | "EXPERIMENTAL"
  | "LOTTO";

export type PublicRecord = Record<string, any>;

export type ActiveArbsResponse = PublicRecord;
export type DfsLineupsResponse = PublicRecord;
export type DriftPoint = PublicRecord;
export type DriftResponse = PublicRecord;
export type FantasyLeagueDetailResponse = PublicRecord;
export type FantasyLeaguesResponse = PublicRecord;
export type FantasyProjectionsResponse = PublicRecord;
export type FantasyProvidersResponse = PublicRecord;
export type FutureGame = PublicRecord;
export type FuturesResponse = PublicRecord;
export type Game = PublicRecord;
export type GameBoardResponse = PublicRecord;
export type GamesResponse = PublicRecord;
export type MovementEntry = PublicRecord;
export type MovementHistoryResponse = PublicRecord;
export type PlayerProfileSliceResponse = PublicRecord;
export type PlayerTrend = PublicRecord;
export type Prop = PublicRecord;
export type SgpEvaluateResponse = PublicRecord;
export type UnifiedPlayerProfileResponse = PublicRecord;

export interface WaiverPayload extends PublicRecord {
  add_targets: any;
  drop_candidates: any;
}

export interface ErrorDetail extends PublicRecord {
  code: string;
  message: string;
}

export interface ErrorResponse extends PublicRecord {
  error: ErrorDetail | string;
}
