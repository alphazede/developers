// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { MeetingWarningPanel } from "../../../src/components/evidence/meeting-warning-panel";
import type { MeetingWarningV1 } from "../../../src/ui/projections";

afterEach(cleanup);

const warning: MeetingWarningV1 = {
  schemaVersion: 1, classification: "historically-demanding", wording: "Historically demanding meeting pattern",
  occurrenceCount: 3, distinctUtcDates: 3, newestAgeDays: 2.8333, weightedChange: -0.291, confidence: 0.6659,
  confidenceComponents: { count: 0.6, distinctDates: 0.6, freshness: 0.7976 }, limitations: ["Observational evidence only."],
  explanation: "Observational evidence only. This is a private personal pattern—not medical or causal, not a stress or toxic label, and not a judgment about any person or contact.",
  recovery: { minutes: 15, rationale: "Observational meeting-pattern history supports a recovery buffer." },
};

describe("MeetingWarningPanel", () => {
  it("renders exact observational evidence and recovery copy without identity fields", async () => {
    const user = userEvent.setup(), before = structuredClone(warning);
    render(<MeetingWarningPanel warning={warning} />);
    expect(screen.getByRole("heading", { name: warning.wording })).toBeTruthy();
    expect(screen.getByText(warning.explanation)).toBeTruthy();
    expect(screen.getByText("Suggested 15-minute recovery buffer.")).toBeTruthy();
    expect(screen.getByText(warning.recovery!.rationale)).toBeTruthy();
    await user.click(screen.getByText("Review meeting-pattern evidence"));
    expect(screen.getByText("2.8333 days")).toBeTruthy();
    expect(screen.getByText("Count 60%; dates 60%; freshness 80%")).toBeTruthy();
    const rendered = document.body.textContent ?? "";
    for (const forbidden of ["participantSetKey", "recurringSeriesRef", "sourceEntityId", "patternKey", "hmac", "digest"]) expect(rendered).not.toContain(forbidden);
    expect(warning).toEqual(before);
  });

  it("renders nothing when no redacted warning exists", () => {
    const { container } = render(<MeetingWarningPanel warning={null} />);
    expect(container.textContent).toBe("");
  });
});
