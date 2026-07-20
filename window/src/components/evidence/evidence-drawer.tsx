"use client";

import { useId, useRef, type KeyboardEvent } from "react";

import type { CapacityPointV1 } from "../../ui/projections";

export type EvidenceAction = "confirm" | "reject" | "correct" | "forget";
export type EvidenceActionPayload = Readonly<{
  schemaVersion: 1;
  action: EvidenceAction;
  startAt: string;
  capacity: number | null;
}>;
export type EvidenceDrawerProps = Readonly<{
  point: CapacityPointV1;
  onAction?: (payload: EvidenceActionPayload) => void;
}>;

const actions: ReadonlyArray<readonly [EvidenceAction, string]> = [
  ["confirm", "Preview confirm evidence"],
  ["reject", "Preview reject evidence"],
  ["correct", "Preview correct evidence"],
  ["forget", "Preview forget evidence"],
];

export function EvidenceDrawer({ point, onAction }: EvidenceDrawerProps) {
  const previewNoticeId = useId();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
    queueMicrotask(() => summaryRef.current?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== "Escape" || !detailsRef.current?.open) return;
    event.preventDefault();
    close();
  };
  const emit = (action: EvidenceAction) => onAction?.(Object.freeze({
    schemaVersion: 1 as const,
    action,
    startAt: point.startAt,
    capacity: point.capacity,
  }));

  return (
    <details ref={detailsRef} onKeyDown={onKeyDown} className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2">
      <summary ref={summaryRef} className="cursor-pointer font-semibold">Review evidence for {point.timeLabel}</summary>
      <div className="grid gap-3 p-2" aria-label={`Evidence details for ${point.timeLabel}`}>
        <p>Source: Capacity history</p>
        <p>This capacity estimate is a transparent weighted heuristic, not a medical, causal, stress, or diagnostic judgment.</p>
        <dl className="grid gap-1">
          <div><dt className="font-semibold">Status</dt><dd>{point.statusLabel}</dd></div>
          <div><dt className="font-semibold">Confidence band</dt><dd>{Math.round(point.confidence * 100)}%</dd></div>
          <div><dt className="font-semibold">Effective sample size</dt><dd>{point.components.effectiveSampleSize}</dd></div>
          <div><dt className="font-semibold">Date coverage</dt><dd>{Math.round(point.components.dateScore * 100)}%</dd></div>
          <div><dt className="font-semibold">Freshness</dt><dd>{Math.round(point.components.freshnessScore * 100)}%</dd></div>
          <div><dt className="font-semibold">Sample support</dt><dd>{Math.round(point.components.sampleScore * 100)}%</dd></div>
        </dl>
        <div>
          <h5 className="font-semibold">Limitations</h5>
          {point.limitations.length ? <ul>{point.limitations.map((limitation) => <li key={limitation}><span aria-hidden="true">△ </span>{limitation}</li>)}</ul> : <p>None reported</p>}
        </div>
        <p id={previewNoticeId}>Preview only. These controls send a local action intent; no evidence, source data, or stored records change.</p>
        <div className="flex flex-wrap gap-2" aria-label="Local evidence controls">
          {actions.map(([action, label]) => <button key={action} type="button" className="control-button" aria-describedby={previewNoticeId} onClick={() => emit(action)}>{label}</button>)}
          <button type="button" className="control-button" onClick={close}>Close evidence</button>
        </div>
      </div>
    </details>
  );
}
