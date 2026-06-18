/**
 * Tool: get_alerts
 *
 * Get recent alerts — arbitrage opportunities, sharp line moves,
 * threshold breaches, and market suspensions.
 */

import { z } from "zod";
import { attribution, bullet, heading, separator } from "../format.js";
import { defineSimpleTool } from "../tool.js";

const getAlertsParamsShape = {
  hours: z
    .number()
    .min(1)
    .max(720)
    .optional()
    .describe("How many hours back to look (default: 24, max: 720)."),
  type: z
    .enum(["all", "arb", "sharp", "threshold", "suspend"])
    .optional()
    .describe("Filter to a specific alert type. Defaults to all."),
};

const GET_ALERTS_NAME_VALUE = "get_alerts";
const GET_ALERTS_DESCRIPTION_VALUE =
  "Get recent alerts across all sports — arbitrage opportunities found between books, " +
  "sharp line movements, high-edge threshold breaches, and market suspensions. " +
  "Useful for finding live opportunities or understanding recent market activity.";

export const getAlertsTool = defineSimpleTool({
  name: GET_ALERTS_NAME_VALUE,
  description: GET_ALERTS_DESCRIPTION_VALUE,
  params: getAlertsParamsShape,
  fetch: (client, input) => client.getAlertHistory(input.hours, input.type),
  format: (data, input) => {
    const alerts = data.alerts ?? [];
    const hours = input.hours ?? 24;
    if (!alerts.length) {
      return `No alerts in the last ${hours} hours${input.type ? ` (type: ${input.type})` : ""}.`;
    }
    const lines = [
      heading(`${alerts.length} alert(s) in the last ${hours} hours`) +
        separator(),
    ];
    for (const a of alerts.slice(0, 25)) {
      lines.push(
        bullet([
          `[${a.alert_type.toUpperCase()}] ${a.player} ${a.stat} (${a.sport}) — ${a.detail}`,
        ]),
      );
    }
    if (alerts.length > 25)
      lines.push(bullet([`... and ${alerts.length - 25} more`]));
    lines.push(separator() + attribution());
    return lines.join("\n");
  },
});
