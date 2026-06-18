export const operations = Object.freeze(
{
  "getHealth": {
    "method": "GET",
    "path": "/api/v1/health"
  },
  "listGamesBySportAndDate": {
    "method": "GET",
    "path": "/api/v1/games/{sport}/{date}"
  },
  "listGameProps": {
    "method": "GET",
    "path": "/api/v1/games/{sport}/{game_id}/props"
  },
  "getGameboard": {
    "method": "GET",
    "path": "/api/v1/gameboard/{sport}/{game_id}"
  },
  "getMovementHistory": {
    "method": "GET",
    "path": "/api/v1/movement/{sport}/{game_id}/{prop_id}/history"
  },
  "listFutures": {
    "method": "GET",
    "path": "/api/v1/futures/{sport}"
  },
  "listFuturesMarket": {
    "method": "GET",
    "path": "/api/v1/futures/{sport}/market"
  },
  "getFuturesDrift": {
    "method": "GET",
    "path": "/api/v1/futures/{sport}/{prop_id}/drift"
  },
  "listAlertHistory": {
    "method": "GET",
    "path": "/api/v1/alerts/history"
  },
  "listActiveAlerts": {
    "method": "GET",
    "path": "/api/v1/alerts/active"
  },
  "getMlProjection": {
    "method": "GET",
    "path": "/api/v1/ml/projection"
  },
  "listFantasyProviders": {
    "method": "GET",
    "path": "/api/v1/fantasy/providers"
  },
  "listFantasyLeagues": {
    "method": "GET",
    "path": "/api/v1/fantasy/leagues"
  },
  "listFantasyProjections": {
    "method": "GET",
    "path": "/api/v1/fantasy/projections"
  },
  "getFantasyStartSit": {
    "method": "GET",
    "path": "/api/v1/fantasy/start-sit"
  },
  "getFantasyWaiver": {
    "method": "GET",
    "path": "/api/v1/fantasy/waiver"
  },
  "getFantasyDraftRankings": {
    "method": "GET",
    "path": "/api/v1/fantasy/draft-rankings"
  },
  "getFantasyMatchup": {
    "method": "GET",
    "path": "/api/v1/fantasy/matchup"
  },
  "getFantasyTrends": {
    "method": "GET",
    "path": "/api/v1/fantasy/trends"
  },
  "getFantasyLeagueRoster": {
    "method": "GET",
    "path": "/api/v1/fantasy/leagues/{league_id}/roster"
  },
  "getFantasyLeagueMatchup": {
    "method": "GET",
    "path": "/api/v1/fantasy/leagues/{league_id}/matchup"
  },
  "getFantasyLeagueWaivers": {
    "method": "GET",
    "path": "/api/v1/fantasy/leagues/{league_id}/waivers"
  },
  "getFantasyLeagueTrades": {
    "method": "GET",
    "path": "/api/v1/fantasy/leagues/{league_id}/trades"
  },
  "getUnifiedPlayerProfile": {
    "method": "GET",
    "path": "/api/v1/players/{canonical_id}/profile"
  },
  "getFantasyPlayerProfile": {
    "method": "GET",
    "path": "/api/v1/players/{canonical_id}/fantasy"
  },
  "getBettingPlayerProfile": {
    "method": "GET",
    "path": "/api/v1/players/{canonical_id}/betting"
  },
  "listActiveArbs": {
    "method": "GET",
    "path": "/api/v1/arb/active"
  },
  "getDfsLineups": {
    "method": "GET",
    "path": "/api/v1/dfs/lineups"
  },
  "evaluateSgp": {
    "method": "POST",
    "path": "/api/v1/sgp/evaluate"
  },
  "streamSportUpdates": {
    "method": "GET",
    "path": "/api/v1/stream/{sport}"
  },
  "listForecastsBySport": {
    "method": "GET",
    "path": "/api/v1/forecasts/{sport}"
  },
  "getGameForecast": {
    "method": "GET",
    "path": "/api/v1/forecasts/{sport}/{game_id}"
  },
  "listForecastSchedule": {
    "method": "GET",
    "path": "/api/v1/forecasts/schedule"
  },
  "getForecastHistory": {
    "method": "GET",
    "path": "/api/v1/forecasts/{sport}/history"
  },
  "listPropEdges": {
    "method": "GET",
    "path": "/api/v1/props/{sport}/edges"
  },
  "streamForecasts": {
    "method": "GET",
    "path": "/api/v1/stream/forecasts/{sport}"
  }
}
);

export type OperationId = keyof typeof operations;
