/**
 * Tool: get_arb_opportunities
 *
 * Get currently active arbitrage opportunities across sportsbooks.
 */

import { attribution, bullet, heading, separator } from "../format.js";
import { defineSimpleTool } from "../tool.js";

const getArbOpportunitiesParamsShape = {};

const GET_ARB_OPPORTUNITIES_NAME_VALUE = "get_arb_opportunities";
const GET_ARB_OPPORTUNITIES_DESCRIPTION_VALUE =
  "Get currently active arbitrage opportunities — situations where odds differences " +
  "between sportsbooks create guaranteed profit regardless of outcome. " +
  "Returns player, stat, books involved, odds, edge percentage, and suggested sizing.";

export const getArbOpportunitiesTool = defineSimpleTool({
  name: GET_ARB_OPPORTUNITIES_NAME_VALUE,
  description: GET_ARB_OPPORTUNITIES_DESCRIPTION_VALUE,
  params: getArbOpportunitiesParamsShape,
  fetch: (client, _input) => client.getActiveArbs(),
  format: (data, _input) => {
    const arbs = data.arbs ?? [];
    if (!arbs.length) {
      return "No active arbitrage opportunities right now. Check back — arbs are fleeting.";
    }
    const lines = [
      heading(
        `${arbs.length} active arbitrage opportunit${arbs.length === 1 ? "y" : "ies"}`,
      ) + separator(),
    ];
    for (const a of arbs) {
      lines.push(
        bullet([
          `${a.player} ${a.stat} (${a.sport}) — ${a.book_a} vs ${a.book_b}`,
        ]),
      );
      lines.push(
        `    Odds: ${a.odds_a} / ${a.odds_b} | Edge: ${a.edge_pct}% | ${a.sizing}`,
      );
    }
    lines.push(separator() + attribution());
    return lines.join("\n");
  },
});
