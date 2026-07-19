// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OptionalStateMotion } from "../../../src/components/today/optional-state-motion";

const motion = vi.hoisted(() => ({ animate: vi.fn() }));
vi.mock("motion/react", () => ({ animate: motion.animate }));

const setReducedMotion = (matches: boolean) => Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
});

beforeEach(() => { motion.animate.mockReset().mockReturnValue({ stop: vi.fn() }); setReducedMotion(false); });
afterEach(cleanup);

describe("OptionalStateMotion", () => {
  it("enhances only a state change and never gates content or interaction", async () => {
    const user = userEvent.setup(), onAction = vi.fn();
    const view = render(<OptionalStateMotion stateKey="before"><button onClick={onAction}>Act now</button></OptionalStateMotion>);
    expect(motion.animate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Act now" }));
    expect(onAction).toHaveBeenCalledTimes(1);

    view.rerender(<OptionalStateMotion stateKey="after"><button onClick={onAction}>Act now</button></OptionalStateMotion>);
    await waitFor(() => expect(motion.animate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Act now" })).toBeTruthy();
  });

  it("preserves the same content when explicitly disabled, reduced, or Motion fails", async () => {
    const disabled = render(<OptionalStateMotion stateKey="before" enabled={false}><span>Same recommendation</span></OptionalStateMotion>);
    disabled.rerender(<OptionalStateMotion stateKey="after" enabled={false}><span>Same recommendation</span></OptionalStateMotion>);
    expect(screen.getByText("Same recommendation")).toBeTruthy();
    expect(motion.animate).not.toHaveBeenCalled();
    disabled.unmount();

    setReducedMotion(true);
    const reduced = render(<OptionalStateMotion stateKey="before"><span>Same recommendation</span></OptionalStateMotion>);
    reduced.rerender(<OptionalStateMotion stateKey="after"><span>Same recommendation</span></OptionalStateMotion>);
    expect(screen.getByText("Same recommendation")).toBeTruthy();
    expect(motion.animate).not.toHaveBeenCalled();
    reduced.unmount();

    setReducedMotion(false);
    motion.animate.mockImplementationOnce(() => { throw new Error("motion unavailable"); });
    const failed = render(<OptionalStateMotion stateKey="before"><span>Same recommendation</span></OptionalStateMotion>);
    failed.rerender(<OptionalStateMotion stateKey="after"><span>Same recommendation</span></OptionalStateMotion>);
    await waitFor(() => expect(motion.animate).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Same recommendation")).toBeTruthy();
  });
});
