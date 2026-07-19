// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccessibleTimeline, resolvePlacement } from "../../../src/components/today/accessible-timeline";
import type { Candidate } from "../../../src/domain/schedule";
import type { TodayProjectionV1, TimelineEntryV1 } from "../../../src/ui/projections";

vi.mock("echarts", () => ({ init: () => ({ dispose: vi.fn(), resize: vi.fn(), setOption: vi.fn() }) }));

afterEach(cleanup);

const taskId = "a1000000-0000-4000-8000-000000000011";
const localTaskId = "a1000000-0000-4000-8000-000000000013";
const commandId = "90000000-0000-4000-8000-000000000006";
const candidate: Candidate = {
  id: "90000000-0000-5000-8000-000000000011", requestHash: "a".repeat(64), taskId,
  startAt: "2026-07-23T20:30:00Z", endAt: "2026-07-23T21:00:00Z", score: 82,
  breakdown: { capacityFit: 34, deadlineUrgency: 19, goalAlignment: 9, contextSwitch: 10, recoverySupport: 10 },
  confidence: 0.6, limitations: ["context_unknown"],
};
const entry = (type: TimelineEntryV1["type"], id: string, startAt: string, title: string, overrides: Partial<TimelineEntryV1> = {}): TimelineEntryV1 => ({
  schemaVersion: 1, id, type, startAt, endAt: "2026-07-23T21:00:00Z", startLabel: startAt.slice(11, 16), endLabel: "16:00",
  title, source: "local", sourceLabel: "Local", status: type, statusLabel: ({ hard: "Hard commitment", protected: "Protected time", recovery: "Recovery", task: "Task placement", proposal: "Preview" } as const)[type], taskId: null,
  mutabilityLabel: "Commitment — read-only", score: null, breakdown: null, confidence: null, limitations: [], ...overrides,
});

const projection = (gate: "open" | "read-only" = "open"): TodayProjectionV1 => ({
  schemaVersion: 1, revision: 1, date: "2026-07-23", timeZone: "America/Chicago",
  dayStartAt: "2026-07-23T05:00:00Z", dayEndAt: "2026-07-24T05:00:00Z",
  capacityPoints: [
    { schemaVersion: 1, id: "80000000-0000-4000-8000-000000000001", startAt: "2026-07-23T20:30:00Z", timeLabel: "15:30", capacity: 70, confidence: 0.8, components: { effectiveSampleSize: 4, sampleScore: 0.5, dateScore: 0.75, freshnessScore: 1 }, status: "known", statusLabel: "Known capacity 70 of 100", limitations: [] },
    { schemaVersion: 1, id: "80000000-0000-4000-8000-000000000002", startAt: "2026-07-23T21:00:00Z", timeLabel: "16:00", capacity: null, confidence: 0.3, components: { effectiveSampleSize: 2.5, sampleScore: 0.25, dateScore: 0.5, freshnessScore: 1 }, status: "unknown", statusLabel: "Capacity unknown", limitations: ["capacity_unknown"] },
  ],
  timeline: [
    entry("hard", "81000000-0000-4000-8000-000000000001", "2026-07-23T19:00:00Z", "Decision review"),
    entry("protected", "81000000-0000-4000-8000-000000000002", "2026-07-23T21:30:00Z", "Protected workout"),
    entry("recovery", "81000000-0000-4000-8000-000000000003", "2026-07-23T20:00:00Z", "Suggested recovery", { status: "soft", statusLabel: "Soft recovery" }),
    entry("task", "81000000-0000-4000-8000-000000000004", "2026-07-23T17:00:00Z", "Draft strategy", { taskId: localTaskId, status: "approved", statusLabel: "Approved task placement", score: 87, breakdown: { capacityFit: 38, deadlineUrgency: 15, goalAlignment: 14, contextSwitch: 10, recoverySupport: 10 }, confidence: 0.75 }),
    entry("proposal", candidate.id, candidate.startAt, "Review imported follow-up", { taskId, source: "github", sourceLabel: "GitHub", status: "preview", statusLabel: "Preview — source task unchanged", score: candidate.score, breakdown: candidate.breakdown, confidence: candidate.confidence, limitations: candidate.limitations, endAt: candidate.endAt, startLabel: "15:30", endLabel: "16:00", mutabilityLabel: "Imported GitHub task — read-only" }),
  ],
  backlog: [
    { schemaVersion: 1, id: taskId, title: "Review imported follow-up", source: "github", sourceLabel: "GitHub", state: "open", durationMinutes: 30, deadlineAt: "2026-07-23T21:00:00Z", mutable: false, mutabilityLabel: "Imported GitHub task — read-only", intent: { requiredCapacity: 55, goalAlignment: 60 } },
    { schemaVersion: 1, id: localTaskId, title: "Draft deep-work learning strategy", source: "local", sourceLabel: "Local", state: "open", durationMinutes: 30, deadlineAt: null, mutable: true, mutabilityLabel: "Local task — editable", intent: { requiredCapacity: 85, goalAlignment: 90 } },
  ],
  focusGate: { enabled: true, state: gate, allowed: gate === "open", label: gate === "open" ? "Focus Gate is open" : "Focus Gate is closed — tasks are read-only", nextBoundaryAt: "2026-07-23T21:00:00Z", nextBoundaryLabel: "16:00" },
  meetingWarning: {
    schemaVersion: 1, classification: "historically-demanding", wording: "Historically demanding meeting pattern",
    occurrenceCount: 3, distinctUtcDates: 3, newestAgeDays: 2.8333, weightedChange: -0.291, confidence: 0.6659,
    confidenceComponents: { count: 0.6, distinctDates: 0.6, freshness: 0.7976 }, limitations: ["Observational evidence only."],
    explanation: "Observational evidence only. This is a private personal pattern—not medical or causal, not a stress or toxic label, and not a judgment about any person or contact.",
    recovery: { minutes: 15, rationale: "Observational meeting-pattern history supports a recovery buffer." },
  },
  placementTargets: {
    [`${taskId}@2026-07-23T20:30:00Z`]: { schemaVersion: 1, key: `${taskId}@2026-07-23T20:30:00Z`, taskId, startAt: "2026-07-23T20:30:00Z", timeLabel: "15:30", status: "candidate", label: "Available at 15:30; score 82 of 100", candidate },
    [`${taskId}@2026-07-23T19:00:00Z`]: { schemaVersion: 1, key: `${taskId}@2026-07-23T19:00:00Z`, taskId, startAt: "2026-07-23T19:00:00Z", timeLabel: "14:00", status: "rejected", label: "Conflicts with committed or protected time", rejection: "hard-conflict" },
  },
  visualization: {
    schemaVersion: 1, title: "Today 2026-07-23 — revision 1", summary: "Focus Gate is open. Full day.",
    series: [{ id: "70000000-0000-4000-8000-000000000001", label: "Capacity", points: [{ x: "2026-07-23T20:30:00Z", y: 70 }, { x: "2026-07-23T21:00:00Z", y: null }] }],
    table: { columns: ["Type", "Start", "Status"], rows: [["Capacity", "15:30", "Known"], ["Capacity", "16:00", "Unknown"]] },
    announcements: ["Focus Gate is open"],
  },
});

describe("AccessibleTimeline", () => {
  it("renders one semantic full-day surface with compact written non-color state", async () => {
    const user = userEvent.setup();
    render(<AccessibleTimeline projection={projection()} commandId={commandId} proposalRevision={0} />);
    expect(screen.getByRole("main", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Personal rhythm" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Full day rhythm timeline" }).getAttribute("data-day-start")).toBe("2026-07-23T05:00:00Z");
    expect(screen.getAllByTestId("ruler-time")).toHaveLength(24);
    expect(screen.getAllByText("Capacity unknown").length).toBeGreaterThan(0);
    expect(screen.getByText("Confidence band 30%")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Historically demanding meeting pattern" })).toBeTruthy();
    expect(screen.getByText("Suggested 15-minute recovery buffer.")).toBeTruthy();
    expect(document.querySelector('[data-kind="hard"]')?.textContent).toContain("◆ Hard commitment");
    expect(document.querySelector('[data-kind="protected"]')?.textContent).toContain("▣ Protected time");
    expect(document.querySelector('[data-kind="recovery"]')?.textContent).toContain("≈ Soft recovery");
    expect(screen.getByLabelText("GitHub source task, read-only").textContent).toContain("Read-only");
    const pickup = screen.getByRole("button", { name: "Pick up Review imported follow-up" }) as HTMLButtonElement;
    expect(pickup.disabled).toBe(false);
    expect(pickup.getAttribute("aria-describedby")).toContain("today-placement-1");
    expect(screen.queryByRole("button", { name: /Place at 15:30/ })).toBeNull();
    await user.click(pickup);
    const exactDeadlineTarget = screen.getByRole("button", { name: /Place at 15:30/ }) as HTMLButtonElement;
    expect(exactDeadlineTarget.hidden).toBe(false);
    expect(exactDeadlineTarget.querySelector("time")?.dateTime).toBe("2026-07-23T20:30:00Z");
    expect(screen.getByText("Capacity fit")).toBeTruthy();
    expect(screen.getAllByText("context_unknown").length).toBeGreaterThan(0);
    expect(screen.getByTestId("today-shell").className).toContain("min-w-0");
    expect(screen.getByTestId("today-shell").className).toContain("motion-reduce:transition-none");
  });

  it("uses the same command/result and live feedback for native placement", async () => {
    const user = userEvent.setup(), onPlacement = vi.fn(), value = projection(), before = structuredClone(value);
    render(<AccessibleTimeline projection={value} commandId={commandId} proposalRevision={0} onPlacement={onPlacement} />);
    await user.click(screen.getByRole("button", { name: "Pick up Review imported follow-up" }));
    expect(screen.getByRole("status", { name: "Placement updates" }).textContent).toContain("Picked up Review imported follow-up");
    const success = screen.getByRole("button", { name: /Place at 15:30/ });
    await user.click(success);
    expect(onPlacement).toHaveBeenLastCalledWith(resolvePlacement(value, commandId, 0, taskId, "2026-07-23T20:30:00Z"));
    expect(screen.getByRole("status", { name: "Placement updates" }).textContent).toContain("Placed Review imported follow-up at 15:30 as a local preview. Source task unchanged.");
    await waitFor(() => expect(document.activeElement).toBe(success));
    expect(screen.getByRole("heading", { name: "Local preview" })).toBeTruthy();
    const rejection = screen.getByRole("button", { name: /Place at 14:00/ });
    await user.click(rejection);
    expect(screen.getByRole("status", { name: "Placement updates" }).textContent).toContain("Could not place Review imported follow-up at 14:00: Conflicts with committed or protected time.");
    await waitFor(() => expect(document.activeElement).toBe(rejection));
    expect(screen.getByRole("heading", { name: "Local preview" })).toBeTruthy();
    expect(value).toEqual(before);
  });

  it("keeps native placement when drag is disabled and reflects a closed gate", async () => {
    const user = userEvent.setup(), onPlacement = vi.fn();
    render(<AccessibleTimeline projection={projection("read-only")} commandId={commandId} proposalRevision={0} dragEnabled={false} onPlacement={onPlacement} />);
    expect(screen.getByText("Focus Gate is closed — tasks are read-only")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Pick up Draft deep-work learning strategy" }) as HTMLButtonElement).disabled).toBe(true);
    const imported = screen.getByRole("button", { name: "Pick up Review imported follow-up" });
    expect(imported.getAttribute("aria-roledescription")).not.toBe("draggable");
    await user.click(imported);
    await user.click(screen.getByRole("button", { name: /Place at 15:30/ }));
    expect(onPlacement).toHaveBeenCalledTimes(1);
  });

  it("owns truthful local previews for every bounded evidence action", async () => {
    const user = userEvent.setup(), onEvidenceAction = vi.fn(), value = projection(), before = structuredClone(value);
    render(<AccessibleTimeline projection={value} commandId={commandId} proposalRevision={0} onEvidenceAction={onEvidenceAction} />);
    await user.click(screen.getByText("Exact capacity evidence and complete table (2 points)"));
    const drawer = screen.getByText("Review evidence for 15:30").closest("details") as HTMLDetailsElement;
    await user.click(within(drawer).getByText("Review evidence for 15:30"));

    for (const [name, action, visible] of [
      ["Preview confirm evidence", "confirm", "Confirm evidence requested for 15:30."],
      ["Preview reject evidence", "reject", "Reject evidence requested for 15:30."],
      ["Preview correct evidence", "correct", "Correct evidence requested for 15:30."],
      ["Preview forget evidence", "forget", "Forget evidence requested for 15:30."],
    ] as const) {
      const control = within(drawer).getByRole("button", { name });
      control.focus();
      await user.keyboard("{Enter}");
      expect(document.activeElement).toBe(control);
      expect(screen.getByRole("status", { name: "Evidence action preview" }).textContent).toContain(visible);
      expect(screen.getByRole("status", { name: "Evidence action preview" }).textContent).toContain("No evidence, source data, or stored records changed.");
      expect(onEvidenceAction).toHaveBeenLastCalledWith({ schemaVersion: 1, action, startAt: "2026-07-23T20:30:00Z", capacity: 70 });
    }
    expect(onEvidenceAction).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("status", { name: "Evidence action preview" }).textContent).not.toMatch(/receipt|persisted|deleted|confirmed/i);
    expect(document.body.textContent).not.toContain(value.capacityPoints[0]!.id);
    expect(value).toEqual(before);
  });

  it("resolves pointer, keyboard, and button paths byte-identically under budget", () => {
    const value = projection(), expected = resolvePlacement(value, commandId, 0, taskId, "2026-07-23T20:30:00Z");
    expect(["pointer", "keyboard", "button"].map(() => resolvePlacement(value, commandId, 0, taskId, "2026-07-23T20:30:00Z"))).toEqual([expected, expected, expected]);
    const samples: number[] = [];
    for (let run = 0; run < 100; run += 1) {
      const started = performance.now();
      resolvePlacement(value, commandId, 0, taskId, "2026-07-23T20:30:00Z");
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const receipt = { iterations: 100, p50: samples[49]!, p95: samples[94]! };
    console.info("today-placement-benchmark", JSON.stringify(receipt));
    expect(receipt.p95).toBeLessThan(50);
  });
});
