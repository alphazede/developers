// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RhythmFingerprint } from "../../../src/components/rhythm/rhythm-fingerprint";
import type { AccessibleVisualizationV1 } from "../../../src/contracts/v1";
import type { CapacityPointV1 } from "../../../src/ui/projections";

const chart = vi.hoisted(() => ({
  dispose: vi.fn(), resize: vi.fn(), setOption: vi.fn(),
  init: vi.fn(),
}));

vi.mock("echarts", () => ({ init: chart.init }));

const visualization: AccessibleVisualizationV1 = {
  schemaVersion: 1,
  title: "Today 2026-07-23 — revision 7",
  summary: "Capacity evidence for the full day.",
  series: [{
    id: "70000000-0000-4000-8000-000000000099",
    label: "Capacity, with unknown values preserved",
    points: [{ x: "2026-07-23T20:30:00Z", y: 70 }, { x: "2026-07-23T21:00:00Z", y: null }],
  }],
  table: {
    columns: ["Type", "Start", "Status", "Evidence components", "Limitations"],
    rows: [
      ["Capacity", "15:30", "Known capacity 70 of 100", "ESS 4; sample 0.5; dates 0.75; freshness 1", "None"],
      ["Capacity", "16:00", "Capacity unknown", "ESS 2.5; sample 0.25; dates 0.5; freshness 1", "capacity_unknown"],
    ],
  },
  announcements: ["Two capacity points."],
};
const capacityPoints: readonly CapacityPointV1[] = [
  { schemaVersion: 1, id: "80000000-0000-4000-8000-000000000099", startAt: "2026-07-23T20:30:00Z", timeLabel: "15:30", capacity: 70, confidence: 0.8, components: { effectiveSampleSize: 4, sampleScore: 0.5, dateScore: 0.75, freshnessScore: 1 }, status: "known", statusLabel: "Known capacity 70 of 100", limitations: [] },
  { schemaVersion: 1, id: "80000000-0000-4000-8000-000000000098", startAt: "2026-07-23T21:00:00Z", timeLabel: "16:00", capacity: null, confidence: 0.3, components: { effectiveSampleSize: 2.5, sampleScore: 0.25, dateScore: 0.5, freshnessScore: 1 }, status: "unknown", statusLabel: "Capacity unknown", limitations: ["capacity_unknown"] },
];

beforeEach(() => {
  chart.dispose.mockReset();
  chart.resize.mockReset();
  chart.setOption.mockReset();
  chart.init.mockReset().mockReturnValue({ dispose: chart.dispose, resize: chart.resize, setOption: chart.setOption });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});
afterEach(cleanup);

describe("RhythmFingerprint", () => {
  it("renders authoritative text and exact evidence before the lazy chart", async () => {
    const user = userEvent.setup();
    const before = structuredClone({ visualization, capacityPoints });
    render(<RhythmFingerprint visualization={visualization} capacityPoints={capacityPoints} />);

    expect(screen.getByRole("heading", { name: "Rhythm fingerprint" })).toBeTruthy();
    expect(screen.getByText(visualization.summary)).toBeTruthy();
    const disclosure = screen.getByText("Exact capacity evidence and complete table (2 points)");
    expect((disclosure.closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText("Date coverage 75%")).toBeTruthy();
    expect(screen.getAllByText("Freshness 100%")).toHaveLength(2);
    expect(screen.getByText("Effective sample size 4")).toBeTruthy();
    expect(screen.getByText("Confidence band 80%")).toBeTruthy();
    expect(screen.getAllByText("Capacity unknown").length).toBeGreaterThan(0);
    expect(screen.getByRole("status", { name: "Optional chart status" }).textContent).toContain("Loading");
    await user.click(disclosure);
    expect(screen.getByRole("table", { name: "Rhythm evidence table" }).textContent).toContain("Known capacity 70 of 100");

    await waitFor(() => expect(screen.getByRole("status", { name: "Optional chart status" }).textContent).toContain("ready"));
    const option = chart.setOption.mock.calls[0]![0] as { aria: { description: string }; series: Array<{ name: string; data: Array<[string, number | null]> }> };
    expect(option.aria.description).toBe(`Optional capacity chart. ${visualization.summary}`);
    expect(screen.getByRole("img", { name: `Optional capacity chart. ${visualization.summary}` })).toBeTruthy();
    expect(option.series[0]!.name).toBe(visualization.series[0]!.label);
    expect(option.series[0]!.data).toEqual(visualization.series[0]!.points.map(({ x, y }) => [x, y]));
    expect(option.series.some(({ name }) => name === "Confidence band (%)")).toBe(true);
    expect({ visualization, capacityPoints }).toEqual(before);
  });

  it("keeps the semantic view when chart enhancement fails and never exposes private identifiers", async () => {
    const user = userEvent.setup();
    chart.init.mockImplementationOnce(() => { throw new Error("chart unavailable"); });
    render(<RhythmFingerprint visualization={visualization} capacityPoints={capacityPoints} />);

    await waitFor(() => expect(screen.getByRole("status", { name: "Optional chart status" }).textContent).toContain("unavailable"));
    await user.click(screen.getByText("Exact capacity evidence and complete table (2 points)"));
    expect(screen.getByRole("table", { name: "Rhythm evidence table" })).toBeTruthy();
    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toContain(visualization.series[0]!.id);
    expect(rendered).not.toContain(capacityPoints[0]!.id);
    expect(JSON.stringify(chart.setOption.mock.calls)).not.toContain(visualization.series[0]!.id);
    expect(JSON.stringify(chart.setOption.mock.calls)).not.toContain(capacityPoints[0]!.id);
  });
});
