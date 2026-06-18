/**
 * Typed HTTP client for the AlphaZede Sports REST API.
 *
 * Reads configuration from environment variables:
 * - AZS_API_URL (default: https://api.alphazedesports.com)
 *
 * All requests include the identity-bound token in the Authorization header.
 */

import type {
  ActiveArbsResponse,
  DfsLineupsResponse,
  DriftResponse,
  FantasyLeagueDetailResponse,
  FantasyLeaguesResponse,
  FantasyProjectionsResponse,
  FantasyProvidersResponse,
  FuturesResponse,
  GameBoardResponse,
  GamesResponse,
  MovementHistoryResponse,
  PlayerProfileSliceResponse,
  PlayerTrend,
  Prop,
  SgpEvaluateResponse,
  Sport,
  UnifiedPlayerProfileResponse,
  WaiverPayload,
} from "./public-types.js";
import { bearerAuthorizationHeader } from "./auth-token.js";
import {
  AzsApiError,
  errorFromStatus,
  mapHttpError,
  mapNetworkError,
  parseAzsErrorBody,
} from "./errors.js";
import type { Identity } from "./tool.js";
import { tools } from "./tools/index.js";
import { buildApiUrl, normalizeApiBaseUrl } from "./url-utils.js";

export const PACKAGE_VERSION = "1.0.0";
export const DEFAULT_MCP_CLIENT_ID = "azs-claude-mcp";
const MCP_CLIENT_ID_PATTERN = /^azs-(claude|cursor|codex|gemini)-mcp$/;
export const USER_AGENT = `${DEFAULT_MCP_CLIENT_ID}/${PACKAGE_VERSION}`;
const REGISTERED_MCP_TOOL_NAMES = new Set(tools.map((tool) => tool.name));

export interface AzsClientConfig {
  baseUrl: string;
  timeoutMs: number;
}

export interface AzsClientAllowlistRuntime {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export type UpstreamStatusObserver = (status: number) => void;
export type FantasyWaiverWireResponse = {
  sport: string;
  add_targets: WaiverPayload["add_targets"];
  drop_candidates: WaiverPayload["drop_candidates"];
};
export type FantasyTrendsBucketsResponse = {
  trending_up: PlayerTrend[];
  trending_down: PlayerTrend[];
};

export function loadConfig(): AzsClientConfig {
  const baseUrl = normalizeApiBaseUrl(
    process.env.AZS_API_URL ?? "https://api.alphazedesports.com",
  );
  const timeoutMs = 10_000;
  return { baseUrl, timeoutMs };
}

export class AzsClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly mcpTool: string | null;
  private readonly clientId: string;
  private readonly onUpstreamStatus?: UpstreamStatusObserver;
  private readonly forwardedHeaders?: Headers;

  constructor(
    config: AzsClientConfig,
    identity: Identity,
    mcpTool?: string,
    clientIdOrObserver?: string | UpstreamStatusObserver,
    onUpstreamStatus?: UpstreamStatusObserver,
    forwardedHeaders?: Headers,
  ) {
    this.baseUrl = normalizeApiBaseUrl(config.baseUrl);
    this.token = identity.token;
    this.timeoutMs = config.timeoutMs;
    this.mcpTool = validateMcpTool(mcpTool);
    if (typeof clientIdOrObserver === "function") {
      this.clientId = DEFAULT_MCP_CLIENT_ID;
      this.onUpstreamStatus = clientIdOrObserver;
    } else {
      this.clientId = validateClientId(clientIdOrObserver);
      this.onUpstreamStatus = onUpstreamStatus;
    }
    this.forwardedHeaders = forwardedHeaders;
  }

  /**
   * Core fetch wrapper with auth, timeout, and error mapping.
   */
  getRuntimeForAllowlist(): AzsClientAllowlistRuntime {
    return {
      baseUrl: this.baseUrl,
      token: this.token,
      timeoutMs: this.timeoutMs,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = buildApiUrl(this.baseUrl, path);
    const authorization = bearerAuthorizationHeader(this.token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: authorization,
        "User-Agent": `${this.clientId}/${PACKAGE_VERSION}`,
      };
      for (const [name, value] of this.forwardedHeaders?.entries() ?? []) {
        const lower = name.toLowerCase();
        if (
          lower === "authorization" ||
          lower === "content-type" ||
          lower === "user-agent" ||
          lower === "x-mcp-tool"
        ) {
          continue;
        }
        headers[canonicalHeaderName(name)] = value;
      }
      if (this.mcpTool) {
        headers["X-MCP-Tool"] = this.mcpTool;
      }
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      this.onUpstreamStatus?.(response.status);

      if (!response.ok) {
        // Try to parse the API error envelope for richer messages.
        const envelope = await parseAzsErrorBody(response);
        if (envelope) {
          throw new AzsApiError(
            response.status,
            envelope.message || mapHttpError(response.status),
            envelope.code,
          );
        }
        throw errorFromStatus(response.status);
      }

      return (await response.json()) as T;
    } catch (error: unknown) {
      if (error instanceof AzsApiError) {
        throw error;
      }
      throw new AzsApiError(0, mapNetworkError(error));
    } finally {
      clearTimeout(timer);
    }
  }

  // -----------------------------------------------------------------------
  // Games
  // -----------------------------------------------------------------------

  async listGames(sport: Sport, date: string): Promise<GamesResponse> {
    return this.request<GamesResponse>(
      "GET",
      `/api/v1/games/${encodeURIComponent(sport)}/${encodeURIComponent(date)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Gameboard
  // -----------------------------------------------------------------------

  async getGameboard(sport: Sport, gameId: string): Promise<GameBoardResponse> {
    return this.request<GameBoardResponse>(
      "GET",
      `/api/v1/gameboard/${encodeURIComponent(sport)}/${encodeURIComponent(gameId)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Props (per-game)
  // -----------------------------------------------------------------------

  async getGameProps(sport: Sport, gameId: string): Promise<{ props: Prop[] }> {
    return this.request<{ props: Prop[] }>(
      "GET",
      `/api/v1/games/${encodeURIComponent(sport)}/${encodeURIComponent(gameId)}/props`,
    );
  }

  // -----------------------------------------------------------------------
  // Movement
  // -----------------------------------------------------------------------

  async getMovementHistory(
    sport: Sport,
    gameId: string,
    propId: string,
  ): Promise<MovementHistoryResponse> {
    return this.request<MovementHistoryResponse>(
      "GET",
      `/api/v1/movement/${encodeURIComponent(sport)}/${encodeURIComponent(gameId)}/${encodeURIComponent(propId)}/history`,
    );
  }

  // -----------------------------------------------------------------------
  // Drift
  // -----------------------------------------------------------------------

  async getDrift(sport: Sport, propId: string): Promise<DriftResponse> {
    return this.request<DriftResponse>(
      "GET",
      `/api/v1/futures/${encodeURIComponent(sport)}/${encodeURIComponent(propId)}/drift`,
    );
  }

  // -----------------------------------------------------------------------
  // SGP
  // -----------------------------------------------------------------------

  async evaluateSgp(
    sport: Sport,
    gameId: string,
    legs: Array<{
      player: string;
      stat: string;
      line: number;
      direction: string;
    }>,
    parlayOdds: number,
  ): Promise<SgpEvaluateResponse> {
    return this.request<SgpEvaluateResponse>("POST", "/api/v1/sgp/evaluate", {
      sport: sport.toUpperCase(),
      game_id: gameId,
      legs,
      sportsbook_parlay_odds: parlayOdds,
    });
  }

  // -----------------------------------------------------------------------
  // Futures
  // -----------------------------------------------------------------------

  async getFutures(sport: Sport): Promise<FuturesResponse> {
    return this.request<FuturesResponse>(
      "GET",
      `/api/v1/futures/${encodeURIComponent(sport)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Alerts
  // -----------------------------------------------------------------------

  async getAlertHistory(
    hours?: number,
    alertType?: string,
  ): Promise<{
    alerts: Array<{
      id: string;
      alert_type: string;
      player: string;
      stat: string;
      sport: string;
      detail: string;
      timestamp: string;
    }>;
  }> {
    const params = new URLSearchParams();
    if (hours) params.set("hours", String(hours));
    if (alertType) params.set("type", alertType);
    const qs = params.toString();
    return this.request("GET", `/api/v1/alerts/history${qs ? `?${qs}` : ""}`);
  }

  // -----------------------------------------------------------------------
  // ML Projections
  // -----------------------------------------------------------------------

  async getMlProjection(
    sport: Sport,
    player: string,
    stat: string,
  ): Promise<{
    player: string;
    stat: string;
    sport: string;
    projected_value: number;
    model_date: string;
  }> {
    const params = new URLSearchParams({ sport, player, stat });
    return this.request("GET", `/api/v1/ml/projection?${params.toString()}`);
  }

  // -----------------------------------------------------------------------
  // Arbitrage
  // -----------------------------------------------------------------------

  async getActiveArbs(): Promise<ActiveArbsResponse> {
    return this.request<ActiveArbsResponse>("GET", "/api/v1/arb/active");
  }

  // -----------------------------------------------------------------------
  // DFS Lineups
  // -----------------------------------------------------------------------

  async getDfsLineups(
    sport: Sport,
    platform: string,
  ): Promise<DfsLineupsResponse> {
    const params = new URLSearchParams({ sport, platform });
    return this.request<DfsLineupsResponse>(
      "GET",
      `/api/v1/dfs/lineups?${params.toString()}`,
    );
  }

  // -----------------------------------------------------------------------
  // Forecasts
  // -----------------------------------------------------------------------

  async getForecasts(sport: Sport): Promise<{
    sport: string;
    date: string;
    count: number;
    forecasts: Array<{
      forecast_id: string;
      game_id: string;
      league: string;
      generated_at: string;
      forecast: Record<string, unknown>;
    }>;
  }> {
    return this.request(
      "GET",
      `/api/v1/forecasts/${encodeURIComponent(sport)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Fantasy
  // -----------------------------------------------------------------------

  async getFantasyProjections(
    sport: Sport,
  ): Promise<FantasyProjectionsResponse> {
    const params = new URLSearchParams({ sport });
    return this.request<FantasyProjectionsResponse>(
      "GET",
      `/api/v1/fantasy/projections?${params}`,
    );
  }

  async getFantasyProviders(): Promise<FantasyProvidersResponse> {
    return this.request<FantasyProvidersResponse>(
      "GET",
      "/api/v1/fantasy/providers",
    );
  }

  async getFantasyLeagues(): Promise<FantasyLeaguesResponse> {
    return this.request<FantasyLeaguesResponse>(
      "GET",
      "/api/v1/fantasy/leagues",
    );
  }

  private async getFantasyLeagueDetail(
    leagueId: string,
    tab: "roster" | "matchup" | "waivers" | "trades",
  ): Promise<FantasyLeagueDetailResponse> {
    return this.request<FantasyLeagueDetailResponse>(
      "GET",
      `/api/v1/fantasy/leagues/${encodeURIComponent(leagueId)}/${tab}`,
    );
  }

  async getFantasyLeagueRoster(
    leagueId: string,
  ): Promise<FantasyLeagueDetailResponse> {
    return this.getFantasyLeagueDetail(leagueId, "roster");
  }

  async getFantasyLeagueMatchup(
    leagueId: string,
  ): Promise<FantasyLeagueDetailResponse> {
    return this.getFantasyLeagueDetail(leagueId, "matchup");
  }

  async getFantasyLeagueWaivers(
    leagueId: string,
  ): Promise<FantasyLeagueDetailResponse> {
    return this.getFantasyLeagueDetail(leagueId, "waivers");
  }

  async getFantasyLeagueTrades(
    leagueId: string,
  ): Promise<FantasyLeagueDetailResponse> {
    return this.getFantasyLeagueDetail(leagueId, "trades");
  }

  async getUnifiedPlayerProfile(
    canonicalId: string,
  ): Promise<UnifiedPlayerProfileResponse> {
    return this.request<UnifiedPlayerProfileResponse>(
      "GET",
      `/api/v1/players/${encodeURIComponent(canonicalId)}/profile`,
    );
  }

  async getFantasyPlayerProfile(
    canonicalId: string,
  ): Promise<PlayerProfileSliceResponse> {
    return this.request<PlayerProfileSliceResponse>(
      "GET",
      `/api/v1/players/${encodeURIComponent(canonicalId)}/fantasy`,
    );
  }

  async getBettingPlayerProfile(
    canonicalId: string,
  ): Promise<PlayerProfileSliceResponse> {
    return this.request<PlayerProfileSliceResponse>(
      "GET",
      `/api/v1/players/${encodeURIComponent(canonicalId)}/betting`,
    );
  }

  async getFantasyWaiver(sport: Sport): Promise<FantasyWaiverWireResponse> {
    const params = new URLSearchParams({ sport });
    return this.request<FantasyWaiverWireResponse>(
      "GET",
      `/api/v1/fantasy/waiver?${params}`,
    );
  }

  async getFantasyTrends(
    sport: Sport,
    days = 7,
  ): Promise<FantasyTrendsBucketsResponse> {
    const params = new URLSearchParams({ sport, days: String(days) });
    return this.request<FantasyTrendsBucketsResponse>(
      "GET",
      `/api/v1/fantasy/trends?${params}`,
    );
  }
}

function canonicalHeaderName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("-");
}

function validateMcpTool(mcpTool: string | undefined): string | null {
  if (mcpTool === undefined) {
    return null;
  }
  if (!REGISTERED_MCP_TOOL_NAMES.has(mcpTool)) {
    throw new Error(`Unknown MCP tool: ${mcpTool}`);
  }
  return mcpTool;
}

function validateClientId(clientId: string | undefined): string {
  if (!clientId) {
    return DEFAULT_MCP_CLIENT_ID;
  }
  if (!MCP_CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(`Invalid MCP client_id: ${clientId}`);
  }
  return clientId;
}
