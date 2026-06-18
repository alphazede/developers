/**
 * Tool: get_fantasy_workspace
 *
 * Read-only fantasy workspace surface for provider status, league summaries,
 * league scaffold views, and unified player profiles.
 */

import { z } from "zod";
import type { AzsClient } from "../client.js";
import { attribution, bullet, heading, separator } from "../format.js";
import { defineTool } from "../tool.js";

type FantasyWorkspaceView =
  | "providers"
  | "leagues"
  | "league_roster"
  | "league_matchup"
  | "league_waivers"
  | "league_trades"
  | "player_profile"
  | "player_fantasy"
  | "player_market";

const getFantasyWorkspaceParamsShape = {
  view: z
    .enum([
      "providers",
      "leagues",
      "league_roster",
      "league_matchup",
      "league_waivers",
      "league_trades",
      "player_profile",
      "player_fantasy",
      "player_market",
    ])
    .describe(
      "Which fantasy workspace view to fetch: provider status, league summaries, a league roster/matchup/waiver/trade scaffold, a unified player profile, or a player-level fantasy/market slice.",
    ),
  league_id: z
    .string()
    .optional()
    .describe(
      "Required when view is a league scaffold. Canonical league identifier.",
    ),
  canonical_id: z
    .string()
    .optional()
    .describe(
      "Required when view is player_profile, player_fantasy, or player_market. Canonical player identifier.",
    ),
};

const GET_FANTASY_WORKSPACE_NAME_VALUE = "get_fantasy_workspace";
const GET_FANTASY_WORKSPACE_DESCRIPTION_VALUE =
  "Get read-only fantasy workspace state — provider rollout status, linked league summaries, " +
  "league roster, matchup, waiver, and trade scaffolds, unified player profiles, and player-level " +
  "fantasy or market slices. Useful for checking fantasy sync readiness and inspecting the " +
  "converged player surface.";

function formatProvider(provider: Record<string, unknown>): string {
  const label = String(
    provider.label ?? provider.provider ?? "Unknown provider",
  );
  const status = String(provider.connection_status ?? "unknown");
  const trust = String(provider.trust_state ?? "unknown");
  return `${label} | ${status} | ${trust}`;
}

function formatLeague(league: Record<string, unknown>): string {
  const name = String(league.name ?? league.league_id ?? "Unknown league");
  const provider = String(league.provider ?? "unknown");
  const trust = String(league.trust_state ?? "unknown");
  return `${name} | ${provider} | ${trust}`;
}

function formatModule(module: Record<string, unknown>): string {
  const title = String(module.title ?? module.key ?? "Unknown module");
  const state = String(module.state ?? "unknown");
  return `${title} | ${state}`;
}

function formatLeagueViewLabel(view: FantasyWorkspaceView): string {
  switch (view) {
    case "league_roster":
      return "Roster";
    case "league_matchup":
      return "Matchup";
    case "league_waivers":
      return "Waivers";
    case "league_trades":
      return "Trades";
    default:
      return "League";
  }
}

async function getLeagueViewData(
  client: AzsClient,
  view: FantasyWorkspaceView,
  leagueId: string,
): Promise<Record<string, unknown>> {
  switch (view) {
    case "league_roster":
      return client.getFantasyLeagueRoster(leagueId);
    case "league_matchup":
      return client.getFantasyLeagueMatchup(leagueId);
    case "league_waivers":
      return client.getFantasyLeagueWaivers(leagueId);
    case "league_trades":
      return client.getFantasyLeagueTrades(leagueId);
    default:
      throw new Error(`Unsupported fantasy league view: ${view}`);
  }
}

function formatPlayerViewLabel(view: FantasyWorkspaceView): string {
  switch (view) {
    case "player_fantasy":
      return "Fantasy Slice";
    case "player_market":
      return "Market Slice";
    default:
      return "Profile";
  }
}

async function getPlayerViewData(
  client: AzsClient,
  view: FantasyWorkspaceView,
  canonicalId: string,
): Promise<Record<string, unknown>> {
  switch (view) {
    case "player_profile":
      return client.getUnifiedPlayerProfile(canonicalId);
    case "player_fantasy":
      return client.getFantasyPlayerProfile(canonicalId);
    case "player_market":
      return client.getBettingPlayerProfile(canonicalId);
    default:
      throw new Error(`Unsupported player workspace view: ${view}`);
  }
}

function isPlayerWorkspaceView(view: FantasyWorkspaceView): boolean {
  return (
    view === "player_profile" ||
    view === "player_fantasy" ||
    view === "player_market"
  );
}

export const getFantasyWorkspaceTool = defineTool({
  name: GET_FANTASY_WORKSPACE_NAME_VALUE,
  description: GET_FANTASY_WORKSPACE_DESCRIPTION_VALUE,
  params: getFantasyWorkspaceParamsShape,
  handler: async (ctx, input) => {
    const client = ctx.client;
    if (input.view === "providers") {
      const data = await client.getFantasyProviders();
      const providers = data.providers ?? [];
      if (!providers.length) {
        return "No fantasy providers returned.";
      }
      return [
        heading("Fantasy Providers") + separator(),
        bullet(providers.map((provider) => formatProvider(provider))),
        separator() + attribution(),
      ].join("\n");
    }

    if (input.view === "leagues") {
      const data = await client.getFantasyLeagues();
      const leagues = data.leagues ?? [];
      if (!leagues.length) {
        return `No linked fantasy leagues. ${data.message ?? ""}`.trim();
      }
      return [
        heading("Fantasy Leagues") + separator(),
        bullet(leagues.map((league) => formatLeague(league))),
        separator() + attribution(),
      ].join("\n");
    }

    if (
      input.view === "league_roster" ||
      input.view === "league_matchup" ||
      input.view === "league_waivers" ||
      input.view === "league_trades"
    ) {
      if (!input.league_id) {
        throw new Error(`league_id is required when view=${input.view}`);
      }
      const data = await getLeagueViewData(client, input.view, input.league_id);
      const league = data.league as Record<string, unknown> | undefined;
      const items = Array.isArray(data.items)
        ? (data.items as Record<string, unknown>[])
        : [];
      const notes = Array.isArray(data.notes)
        ? (data.notes as unknown[]).map((note) => `Note: ${String(note)}`)
        : [];
      const summary = data.summary ? `Summary: ${String(data.summary)}` : null;
      const headline = data.headline
        ? `Headline: ${String(data.headline)}`
        : null;
      return [
        heading(
          `Fantasy League ${formatLeagueViewLabel(input.view)} — ${String(league?.name ?? input.league_id)}`,
        ) + separator(),
        bullet([
          `Trust state: ${String(league?.trust_state ?? "unknown")}`,
          ...(headline ? [headline] : []),
          ...(summary ? [summary] : []),
          ...items.map(
            (item) =>
              `${String(item.title ?? "Item")} | ${String(item.state ?? "unknown")}`,
          ),
          ...notes,
        ]),
        separator() + attribution(),
      ].join("\n");
    }

    if (isPlayerWorkspaceView(input.view) && !input.canonical_id) {
      throw new Error(`canonical_id is required when view=${input.view}`);
    }

    const canonicalId = input.canonical_id;
    if (!canonicalId) {
      throw new Error(`Unsupported fantasy workspace view: ${input.view}`);
    }

    const data = await getPlayerViewData(client, input.view, canonicalId);
    const modules = Array.isArray(data.modules)
      ? (data.modules as Record<string, unknown>[])
      : [];
    const notes = Array.isArray(data.notes)
      ? (data.notes as unknown[]).map((note) => `Note: ${String(note)}`)
      : [];
    return [
      heading(
        `Player ${formatPlayerViewLabel(input.view)} — ${String(data.display_name ?? canonicalId)}`,
      ) + separator(),
      bullet([
        `Trust state: ${String(data.trust_state ?? "unknown")}`,
        ...modules.map((module) => formatModule(module)),
        ...notes,
      ]),
      separator() + attribution(),
    ].join("\n");
  },
});
