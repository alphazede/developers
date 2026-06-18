import { assertNoDuplicateToolNames, type Tool } from "../tool.js";
import { analyzeParlayTool } from "./analyze-parlay.js";
import { explainEdgeTool } from "./explain-edge.js";
import { findGameMarketsTool } from "./find-game-markets.js";
import { getAlertsTool } from "./get-alerts.js";
import { getArbOpportunitiesTool } from "./get-arb-opportunities.js";
import { getDailyPicksTool } from "./get-daily-picks.js";
import { getDfsLineupsTool } from "./get-dfs-lineups.js";
import { getFantasyProjectionsTool } from "./get-fantasy-projections.js";
import { getFantasyWorkspaceTool } from "./get-fantasy-workspace.js";
import { getForecastsTool } from "./get-forecasts.js";
import { getFuturesTool } from "./get-futures.js";
import { getMlProjectionTool } from "./get-ml-projection.js";
import { pricePlayerPropTool } from "./price-player-prop.js";

// biome-ignore lint/suspicious/noExplicitAny: registry stores tools with heterogeneous parameter shapes.
type RegisteredTool = Tool<any>;

export const tools: readonly RegisteredTool[] = [
  findGameMarketsTool,
  analyzeParlayTool,
  pricePlayerPropTool,
  explainEdgeTool,
  getDailyPicksTool,
  getFuturesTool,
  getAlertsTool,
  getMlProjectionTool,
  getArbOpportunitiesTool,
  getDfsLineupsTool,
  getForecastsTool,
  getFantasyProjectionsTool,
  getFantasyWorkspaceTool,
] as const;

assertNoDuplicateToolNames(tools);
