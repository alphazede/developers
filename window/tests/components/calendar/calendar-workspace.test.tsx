// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import {
  autoColorEvent,
  buildCalendarMonth,
  localCalendarAgentReply,
} from "../../../src/components/calendar/calendar-model";
import { CalendarWorkspace } from "../../../src/components/calendar/calendar-workspace";
import type { TodayProjectionV1, TimelineEntryV1 } from "../../../src/ui/projections";

afterEach(cleanup);

const entry = (overrides: Partial<TimelineEntryV1> & Pick<TimelineEntryV1, "id" | "type" | "title" | "startAt" | "endAt">): TimelineEntryV1 => ({
  schemaVersion: 1,
  startLabel: overrides.startAt.slice(11, 16),
  endLabel: overrides.endAt.slice(11, 16),
  source: "local",
  sourceLabel: "Local",
  status: overrides.type,
  statusLabel: overrides.type === "proposal" ? "Preview — source task unchanged" : overrides.type === "protected" ? "Protected time" : "Hard commitment",
  taskId: null,
  mutabilityLabel: "Commitment — read-only",
  score: null,
  breakdown: null,
  confidence: null,
  limitations: [],
  ...overrides,
});

const projection: TodayProjectionV1 = {
  schemaVersion: 1,
  revision: 7,
  date: "2026-07-23",
  timeZone: "America/Chicago",
  dayStartAt: "2026-07-23T05:00:00Z",
  dayEndAt: "2026-07-24T05:00:00Z",
  capacityPoints: [{
    schemaVersion: 1,
    id: "80000000-0000-4000-8000-000000000001",
    startAt: "2026-07-23T16:00:00Z",
    timeLabel: "11:00 -05:00",
    capacity: 82,
    confidence: .8,
    components: { effectiveSampleSize: 4, sampleScore: .5, dateScore: .75, freshnessScore: 1 },
    status: "known",
    statusLabel: "Known capacity 82 of 100",
    limitations: [],
  }],
  timeline: [
    entry({ id: "81000000-0000-4000-8000-000000000001", type: "protected", title: "Protected focus block", startAt: "2026-07-23T16:00:00Z", endAt: "2026-07-23T17:30:00Z" }),
    entry({ id: "81000000-0000-4000-8000-000000000002", type: "hard", title: "Private decision review", startAt: "2026-07-23T19:00:00Z", endAt: "2026-07-23T19:30:00Z", source: "google-calendar", sourceLabel: "Google Calendar" }),
    entry({ id: "81000000-0000-4000-8000-000000000003", type: "recovery", title: "Suggested recovery", startAt: "2026-07-23T19:30:00Z", endAt: "2026-07-23T19:45:00Z", status: "soft", statusLabel: "Soft recovery" }),
  ],
  backlog: [
    { schemaVersion: 1, id: "a1000000-0000-4000-8000-000000000011", title: "Review imported follow-up", source: "github", sourceLabel: "GitHub", state: "open", durationMinutes: 30, deadlineAt: "2026-07-24T18:00:00Z", mutable: false, mutabilityLabel: "Imported GitHub task — read-only", intent: { requiredCapacity: 55, goalAlignment: 60 } },
    { schemaVersion: 1, id: "a1000000-0000-4000-8000-000000000013", title: "Draft deep-work learning strategy", source: "local", sourceLabel: "Local", state: "open", durationMinutes: 30, deadlineAt: null, mutable: true, mutabilityLabel: "Local task — editable", intent: { requiredCapacity: 85, goalAlignment: 90 } },
  ],
  focusGate: { enabled: true, state: "open", allowed: true, label: "Focus Gate is open", nextBoundaryAt: "2026-07-23T21:00:00Z", nextBoundaryLabel: "16:00 -05:00" },
  meetingWarning: null,
  placementTargets: {},
  visualization: {
    schemaVersion: 1,
    title: "Today 2026-07-23 — revision 7",
    summary: "Focus Gate is open.",
    series: [],
    table: { columns: ["Type"], rows: [["Focus"]] },
    announcements: ["Focus Gate is open"],
  },
};

describe("CalendarWorkspace", () => {
  it("updates the focused rundown when a date is selected and reveals event detail", async () => {
    const user = userEvent.setup();
    render(<CalendarWorkspace projection={projection} />);
    const selected = screen.getByRole("button", { name: /Select Thursday, July 23/ });
    expect(selected.getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: /Select Friday, July 24/ }));
    const rundown = screen.getByTestId("calendar-rundown");
    expect(within(rundown).getByRole("heading", { name: "Friday, July 24" })).toBeTruthy();
    expect(selected.getAttribute("aria-pressed")).toBe("false");

    await user.click(screen.getByRole("button", { name: /Select Thursday, July 23/ }));
    await user.click(within(rundown).getByRole("button", { name: /Protected focus block/ }));
    expect(within(rundown).getByText(/Protected focus time blocks conflicting meetings/)).toBeTruthy();
  });

  it("shows the compact day summary when a date receives keyboard focus", () => {
    render(<CalendarWorkspace projection={projection} />);
    const date = screen.getByRole("button", { name: /Select Wednesday, July 22/ });
    fireEvent.focus(date);
    const tooltip = screen.getByRole("tooltip");
    expect(date.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.textContent).toMatch(/Wednesday, July 22/);
    expect(tooltip.textContent).toMatch(/Deep-work block/);
  });

  it("auto-colors from stable event semantics without ML or network state", () => {
    expect(autoColorEvent({ title: "Protected quiet hour", type: "protected", source: "fixture" }).category).toBe("focus");
    expect(autoColorEvent({ title: "Team sync call", type: "hard", source: "google-calendar" }).category).toBe("meeting");
    expect(autoColorEvent({ title: "Review imported follow-up", type: "deadline", source: "github" }).category).toBe("task");
    expect(autoColorEvent({ title: "Suggested recovery", type: "recovery", source: "local" }).category).toBe("recovery");
    expect(autoColorEvent({ title: "Protected workout", type: "protected", source: "ics" }).category).toBe("personal");
    expect(autoColorEvent({ title: "Hold: review", type: "proposal", source: "local" }).category).toBe("tentative");
  });

  it("handles the bounded local agent intents and visibly reconfirms event colors", async () => {
    const day = buildCalendarMonth(projection).days.find((item) => item.date === projection.date)!;
    expect(localCalendarAgentReply({ prompt: "summarize this day", day }).intent).toBe("summary");
    expect(localCalendarAgentReply({ prompt: "explain conflicts", day }).intent).toBe("conflicts");
    expect(localCalendarAgentReply({ prompt: "protect a focus block", day })).toMatchObject({ intent: "protect-focus", action: { type: "protect-focus" } });
    expect(localCalendarAgentReply({ prompt: "run arbitrary code", day }).intent).toBe("unsupported");

    const user = userEvent.setup();
    const view = render(<CalendarWorkspace projection={projection} />);
    expect(screen.getByRole("heading", { name: "Ask Pennyworth" })).toBeTruthy();
    expect(screen.getByTestId("calendar-agent-conversation").textContent).toMatch(/PennyworthI can summarize the selected day/);
    expect(screen.getByText(/Pennyworth works only with this demo calendar/).textContent).toMatch(/offline.*cannot save changes or run code/i);
    await user.type(screen.getByLabelText(/Ask Pennyworth about Jul 23/), "apply event colors");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("calendar-agent-conversation").textContent).toMatch(/Reconfirmed \d+ local event colors/));
    expect(view.container.querySelectorAll('[data-color-confirmed="true"]').length).toBe(day.events.length);

    await user.type(screen.getByLabelText(/Ask Pennyworth about Jul 23/), "protect a focus block");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("calendar-agent-conversation").textContent).toMatch(/Protected Draft deep-work learning strategy/));
    expect(within(screen.getByTestId("calendar-rundown")).getByRole("button", { name: /Draft deep-work learning strategy/ }).getAttribute("data-protected-preview")).toBe("true");
  });
});
