"use client";

import { useEffect, useRef, type ReactNode } from "react";

export type OptionalStateMotionProps = Readonly<{
  stateKey: string;
  enabled?: boolean;
  children: ReactNode;
}>;

export function OptionalStateMotion({ stateKey, enabled = true, children }: OptionalStateMotionProps) {
  const host = useRef<HTMLDivElement>(null);
  const previous = useRef(stateKey);

  useEffect(() => {
    if (previous.current === stateKey) return;
    previous.current = stateKey;
    if (!enabled || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !host.current) return;
    let cancelled = false;
    let controls: { stop: () => void } | undefined;
    void import("motion/react").then(({ animate }) => {
      if (!cancelled && host.current) controls = animate(host.current, { opacity: [0.7, 1] }, { duration: 0.14 });
    }).catch(() => undefined);
    return () => { cancelled = true; controls?.stop(); };
  }, [enabled, stateKey]);

  return <div ref={host} data-motion-enabled={enabled || undefined}>{children}</div>;
}
