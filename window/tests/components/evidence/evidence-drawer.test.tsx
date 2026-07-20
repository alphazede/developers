// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EvidenceDrawer } from "../../../src/components/evidence/evidence-drawer";
import type { CapacityPointV1 } from "../../../src/ui/projections";

afterEach(cleanup);

const point: CapacityPointV1 = {
  schemaVersion: 1, id: "80000000-0000-4000-8000-000000000097", startAt: "2026-07-23T20:30:00Z", timeLabel: "15:30",
  capacity: 70, confidence: 0.8, components: { effectiveSampleSize: 4, sampleScore: 0.5, dateScore: 0.75, freshnessScore: 1 },
  status: "known", statusLabel: "Known capacity 70 of 100", limitations: ["Sparse weekend observations"],
};

describe("EvidenceDrawer", () => {
  it("uses native disclosure keyboard behavior and returns focus on Escape and close", async () => {
    const user = userEvent.setup();
    render(<EvidenceDrawer point={point} />);
    const summary = screen.getByText("Review evidence for 15:30");
    await user.click(summary);
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getByText("Source: Capacity history")).toBeTruthy();
    expect(screen.getByText(/transparent weighted heuristic/i).textContent).toMatch(/not a medical, causal, stress, or diagnostic judgment/i);

    const confirm = screen.getByRole("button", { name: "Preview confirm evidence" });
    expect(confirm.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(/Preview only.*no evidence, source data, or stored records change/i)).toBeTruthy();
    confirm.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(details.open).toBe(false);

    await user.click(summary);
    await user.click(screen.getByRole("button", { name: "Close evidence" }));
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(details.open).toBe(false);
  });

  it("emits typed local callback payloads without mutating or disclosing evidence IDs", async () => {
    const user = userEvent.setup(), onAction = vi.fn(), before = structuredClone(point);
    render(<EvidenceDrawer point={point} onAction={onAction} />);
    await user.click(screen.getByText("Review evidence for 15:30"));
    for (const [label, action] of [["Preview confirm evidence", "confirm"], ["Preview reject evidence", "reject"], ["Preview correct evidence", "correct"], ["Preview forget evidence", "forget"]] as const) {
      await user.click(screen.getByRole("button", { name: label }));
      expect(onAction).toHaveBeenLastCalledWith({ schemaVersion: 1, action, startAt: point.startAt, capacity: point.capacity });
    }
    expect(point).toEqual(before);
    expect(document.body.textContent).not.toContain(point.id);
  });
});
