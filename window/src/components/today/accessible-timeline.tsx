"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useMemo, useState, type CSSProperties, type MouseEvent } from "react";

import {
  createTargetPlacementCommand,
  type BacklogTaskV1,
  type PlacementTargetV1,
  type TargetPlacementCommand,
  type TodayProjectionV1,
  type TimelineEntryV1,
} from "../../ui/projections";
import { type EvidenceActionPayload } from "../evidence/evidence-drawer";
import { MeetingWarningPanel } from "../evidence/meeting-warning-panel";
import { RhythmFingerprint } from "../rhythm/rhythm-fingerprint";
import { OptionalStateMotion } from "./optional-state-motion";

export type PlacementAttempt = Readonly<{ command: TargetPlacementCommand; target: PlacementTargetV1 }>;
export type AccessibleTimelineProps = Readonly<{
  projection: TodayProjectionV1;
  commandId: string;
  proposalRevision: number;
  dragEnabled?: boolean;
  motionEnabled?: boolean;
  onPlacement?: (attempt: PlacementAttempt) => void;
  onEvidenceAction?: (payload: EvidenceActionPayload) => void;
}>;

export const resolvePlacement = (
  projection: TodayProjectionV1,
  commandId: string,
  proposalRevision: number,
  taskId: string,
  targetAt: string,
): PlacementAttempt => {
  const target = projection.placementTargets[`${taskId}@${targetAt}`];
  if (!target) throw new RangeError("UNKNOWN_PLACEMENT_TARGET");
  return Object.freeze({
    command: createTargetPlacementCommand({ schemaVersion: 1, commandId, taskId, sourceRevision: projection.revision, proposalRevision, targetAt }),
    target,
  });
};

const symbols: Record<TimelineEntryV1["type"], string> = { hard: "◆", protected: "▣", recovery: "≈", task: "●", proposal: "◇" };
const scoreLabels: ReadonlyArray<readonly [keyof NonNullable<TimelineEntryV1["breakdown"]>, string]> = [
  ["capacityFit", "Capacity fit"], ["deadlineUrgency", "Deadline urgency"], ["goalAlignment", "Goal alignment"],
  ["contextSwitch", "Context continuity"], ["recoverySupport", "Recovery support"],
];
const evidenceActionLabels: Record<EvidenceActionPayload["action"], string> = {
  confirm: "Confirm evidence",
  reject: "Reject evidence",
  correct: "Correct evidence",
  forget: "Forget evidence",
};

const TaskControl = ({ task, disabled, dragEnabled, onPick }: Readonly<{
  task: BacklogTaskV1; disabled: boolean; dragEnabled: boolean; onPick: (task: BacklogTaskV1) => void;
}>) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, disabled: disabled || !dragEnabled });
  const style: CSSProperties | undefined = transform ? { transform: `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` } : undefined;
  return (
    <li className="task-card" data-dragging={isDragging || undefined}>
      <div className="task-card__topline">
        <strong>{task.title}</strong>
        <span className="source-badge" aria-label={`${task.sourceLabel} source task, ${task.mutable ? "editable" : "read-only"}`}>
          {task.sourceLabel} · {task.mutable ? "Editable" : "Read-only"}
        </span>
      </div>
      <p>{task.durationMinutes ? `${task.durationMinutes} minutes` : "Duration unknown"} · {task.mutabilityLabel}</p>
      <button
        ref={setNodeRef}
        type="button"
        id={`pickup-${task.id}`}
        className="control-button today-transition motion-reduce:transition-none"
        disabled={disabled}
        style={style}
        onClick={() => onPick(task)}
        {...(dragEnabled && !disabled ? { ...attributes, ...listeners } : {})}
      >
        Pick up {task.title}
      </button>
    </li>
  );
};

const TargetControl = ({ target, activeTaskId, onAnnounce, onPlace }: Readonly<{
  target: PlacementTargetV1; activeTaskId: string | null; onAnnounce: (message: string) => void;
  onPlace: (target: PlacementTargetV1, control: HTMLButtonElement) => void;
}>) => {
  const { setNodeRef, isOver } = useDroppable({ id: target.key });
  const disabled = activeTaskId !== target.taskId;
  const announce = () => onAnnounce(`Target ${target.timeLabel}: ${target.label}`);
  const place = (event: MouseEvent<HTMLButtonElement>) => onPlace(target, event.currentTarget);
  return (
    <li>
      <button
        ref={setNodeRef}
        type="button"
        className="target-button today-transition motion-reduce:transition-none"
        data-target-status={target.status}
        data-target-rejection={target.status === "rejected" ? target.rejection : undefined}
        data-over={isOver || undefined}
        disabled={disabled}
        aria-label={`Place at ${target.timeLabel} — ${target.label}`}
        onFocus={announce}
        onClick={place}
      >
        <time dateTime={target.startAt}>{target.timeLabel}</time>
        <span>{target.status === "candidate" ? "✓ Available" : `× ${target.rejection}`}</span>
      </button>
    </li>
  );
};

export function AccessibleTimeline({ projection, commandId, proposalRevision, dragEnabled = true, motionEnabled = true, onPlacement, onEvidenceAction }: AccessibleTimelineProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor));
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState(projection.visualization.announcements[0] ?? projection.focusGate.label);
  const [preview, setPreview] = useState<Extract<PlacementTargetV1, { status: "candidate" }> | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<Readonly<{ actionLabel: string; startAt: string; timeLabel: string }> | null>(null);
  const tasks = useMemo(() => new Map(projection.backlog.map((task) => [task.id, task])), [projection.backlog]);
  const targets = useMemo(() => Object.values(projection.placementTargets), [projection.placementTargets]);
  const activeTargets = activeTaskId === null ? [] : targets.filter((target) => target.taskId === activeTaskId);
  const activeTask = activeTaskId === null ? undefined : tasks.get(activeTaskId);
  const rankedCandidateIds = new Set(projection.timeline.filter((entry) => entry.type === "proposal" && entry.taskId === activeTaskId).map((entry) => entry.id));
  const candidateTargets = activeTargets.filter((target): target is Extract<PlacementTargetV1, { status: "candidate" }> => target.status === "candidate");
  const rankedTargets = candidateTargets
    .filter((target) => rankedCandidateIds.has(target.candidate.id))
    .sort((left, right) => right.candidate.score - left.candidate.score || left.startAt.localeCompare(right.startAt));
  const deadlineTarget = activeTask?.deadlineAt === null || activeTask?.deadlineAt === undefined ? undefined
    : candidateTargets.find((target) => target.candidate.endAt === activeTask.deadlineAt);
  const preferredTargets = [...rankedTargets, ...(deadlineTarget ? [deadlineTarget] : [])]
    .filter((target, index, all) => all.findIndex((item) => item.key === target.key) === index)
    .slice(0, 4);
  const availableTargets = preferredTargets.length > 0 ? preferredTargets : candidateTargets.slice(0, 4);
  const representativeRejection = activeTargets.find((target) => target.status === "rejected");
  const keyTargets = representativeRejection ? [...availableTargets, representativeRejection] : availableTargets;
  const keyTargetKeys = new Set(keyTargets.map((target) => target.key));
  const remainingTargets = activeTargets.filter((target) => !keyTargetKeys.has(target.key));
  const inspected = preview?.candidate
    ?? projection.timeline.find((entry) => entry.type === "proposal")
    ?? projection.timeline.find((entry) => entry.type === "task" && entry.score !== null)
    ?? null;

  const pickUp = (task: BacklogTaskV1) => {
    setActiveTaskId(task.id);
    setAnnouncement(`Picked up ${task.title}. Choose a written placement target.`);
  };
  const place = (taskId: string, target: PlacementTargetV1, focus: HTMLElement | null) => {
    const task = tasks.get(taskId);
    if (!task) return;
    const attempt = resolvePlacement(projection, commandId, proposalRevision, taskId, target.startAt);
    onPlacement?.(attempt);
    if (attempt.target.status === "candidate") {
      setPreview(attempt.target);
      setAnnouncement(`Placed ${task.title} at ${target.timeLabel} as a local preview. Source task unchanged.`);
    } else {
      setAnnouncement(`Could not place ${task.title} at ${target.timeLabel}: ${attempt.target.label}.`);
    }
    queueMicrotask(() => focus?.focus());
  };
  const previewEvidenceAction = (payload: EvidenceActionPayload) => {
    const point = projection.capacityPoints.find(({ startAt }) => startAt === payload.startAt);
    setEvidencePreview(Object.freeze({
      actionLabel: evidenceActionLabels[payload.action],
      startAt: payload.startAt,
      timeLabel: point?.timeLabel ?? "selected time",
    }));
    onEvidenceAction?.(payload);
  };
  const onDragStart = ({ active }: DragStartEvent) => {
    const task = tasks.get(String(active.id));
    if (task) pickUp(task);
  };
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const target = over ? projection.placementTargets[String(over.id)] : undefined;
    if (target?.taskId === String(active.id)) setAnnouncement(`Target ${target.timeLabel}: ${target.label}`);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const taskId = String(active.id), target = over ? projection.placementTargets[String(over.id)] : undefined;
    const focus = typeof document === "undefined" ? null : document.getElementById(`pickup-${taskId}`);
    if (target?.taskId === taskId) place(taskId, target, focus);
    else {
      setAnnouncement("Placement cancelled. Choose a written placement target.");
      queueMicrotask(() => focus?.focus());
    }
  };

  return (
    <main aria-label="Today" className="today-surface min-h-screen max-w-full bg-[var(--surface)] text-[var(--ink)]">
      <header className="day-summary">
        <div>
          <p className="eyebrow">Today · <time dateTime={projection.date}>{projection.date}</time></p>
          <h1>Personal rhythm</h1>
          <p>{projection.visualization.summary}</p>
        </div>
        <div className="gate-status" data-gate-state={projection.focusGate.state}>
          <strong>{projection.focusGate.label}</strong>
          {projection.focusGate.nextBoundaryAt && <span>Next boundary <time dateTime={projection.focusGate.nextBoundaryAt}>{projection.focusGate.nextBoundaryLabel}</time></span>}
        </div>
      </header>

      <DndContext id={`today-placement-${projection.revision}`} sensors={dragEnabled ? sensors : []} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div data-testid="today-shell" className="today-shell min-w-0 max-w-full motion-reduce:transition-none">
          <aside aria-labelledby="task-rail-title" className="today-panel task-rail">
            <div className="section-heading">
              <div><p className="eyebrow">Open work</p><h2 id="task-rail-title">Task rail</h2></div>
              <span>{projection.backlog.length} tasks</span>
            </div>
            <ul className="task-list">
              {projection.backlog.map((task) => <TaskControl key={task.id} task={task} dragEnabled={dragEnabled} disabled={task.mutable && !projection.focusGate.allowed} onPick={pickUp} />)}
            </ul>
          </aside>

          <section aria-labelledby="timeline-title" aria-label="Full day rhythm timeline" className="today-panel rhythm-timeline" data-day-start={projection.dayStartAt} data-day-end={projection.dayEndAt}>
            <div className="section-heading">
              <div><p className="eyebrow">00:00–24:00</p><h2 id="timeline-title">Full day rhythm timeline</h2></div>
              <span>{projection.timeZone}</span>
            </div>
            <ol className="time-ruler" aria-label="Hourly time ruler">
              {Array.from({ length: 24 }, (_, hour) => <li key={hour}><time data-testid="ruler-time" dateTime={`${projection.date}T${String(hour).padStart(2, "0")}:00`}>{String(hour).padStart(2, "0")}:00</time></li>)}
            </ol>

            <section aria-labelledby="capacity-title" className="rhythm-band">
              <h3 id="capacity-title" className="sr-only">Capacity backdrop</h3>
              <MeetingWarningPanel warning={projection.meetingWarning} />
              <RhythmFingerprint visualization={projection.visualization} capacityPoints={projection.capacityPoints} onEvidenceAction={previewEvidenceAction} />
              {evidencePreview && <div className="semantic-detail" role="status" aria-label="Evidence action preview" aria-live="polite" aria-atomic="true">
                <strong>Local evidence action preview</strong>
                <p>{evidencePreview.actionLabel} requested for <time dateTime={evidencePreview.startAt}>{evidencePreview.timeLabel}</time>.</p>
                <p>No evidence, source data, or stored records changed.</p>
              </div>}
            </section>

            <section aria-labelledby="marks-title">
              <h3 id="marks-title">Schedule marks</h3>
              <ol className="timeline-list">
                {projection.timeline.map((item) => <li key={item.id} className="timeline-mark" data-kind={item.type}>
                  <div><time dateTime={item.startAt}>{item.startLabel}</time>–<time dateTime={item.endAt}>{item.endLabel}</time></div>
                  <strong>{item.title}</strong>
                  <span><span aria-hidden="true">{symbols[item.type]}</span> {item.statusLabel}</span>
                  <small>{item.sourceLabel}{item.score === null ? "" : ` · score ${item.score}`}</small>
                </li>)}
              </ol>
            </section>

            <section aria-labelledby="targets-title" className="target-section">
              <div className="section-heading"><h3 id="targets-title">Placement targets</h3><span>Native buttons always available</span></div>
              <p>{activeTaskId ? `Targets for ${tasks.get(activeTaskId)?.title ?? "selected task"}` : "Pick up a task to enable its targets."}</p>
              <ul className="target-list">
                {keyTargets.map((target) => <TargetControl key={target.key} target={target} activeTaskId={activeTaskId} onAnnounce={setAnnouncement} onPlace={(selected, control) => place(activeTaskId!, selected, control)} />)}
              </ul>
              {activeTaskId && remainingTargets.length > 0 && <details className="semantic-detail">
                <summary>Remaining {remainingTargets.length} of {activeTargets.length} evaluated 15-minute targets; key choices above</summary>
                <ul className="target-list">
                  {remainingTargets.map((target) => <TargetControl key={target.key} target={target} activeTaskId={activeTaskId} onAnnounce={setAnnouncement} onPlace={(selected, control) => place(activeTaskId, selected, control)} />)}
                </ul>
              </details>}
            </section>
          </section>

          <aside aria-labelledby="inspector-title" className="today-panel inspector">
            <p className="eyebrow">Why this time</p>
            <h2 id="inspector-title">{preview ? "Local preview" : "Proposal inspector"}</h2>
            <OptionalStateMotion stateKey={preview?.key ?? inspected?.id ?? "empty"} enabled={motionEnabled}>
            {inspected && inspected.breakdown ? <>
              <p className="score"><strong>{inspected.score}</strong><span>/100</span></p>
              <dl className="score-breakdown">
                {scoreLabels.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{inspected.breakdown![key]}</dd></div>)}
              </dl>
              <p>{inspected.confidence === null ? "Confidence unknown" : `${Math.round(inspected.confidence * 100)}% confidence`}</p>
              <div><h3>Limitations</h3>{inspected.limitations.length ? <ul>{inspected.limitations.map((item) => <li key={item}>{item}</li>)}</ul> : <p>None reported</p>}</div>
            </> : <p>Pick up a task and choose a target to inspect a local preview.</p>}
            </OptionalStateMotion>
          </aside>
        </div>
      </DndContext>

      <p className="sr-only" role="status" aria-label="Placement updates" aria-live="polite" aria-atomic="true">{announcement}</p>
    </main>
  );
}
