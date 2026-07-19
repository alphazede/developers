import type { MeetingWarningV1 } from "../../ui/projections";

export function MeetingWarningPanel({ warning }: Readonly<{ warning: MeetingWarningV1 | null }>) {
  if (warning === null) return null;
  return (
    <aside aria-labelledby="meeting-warning-title" className="meeting-warning">
      <p className="eyebrow">Observational meeting pattern</p>
      <h3 id="meeting-warning-title">{warning.wording}</h3>
      <p>{warning.explanation}</p>
      {warning.recovery && <div className="mt-2"><strong>Suggested {warning.recovery.minutes}-minute recovery buffer.</strong><p>{warning.recovery.rationale}</p></div>}
      <details className="mt-3 rounded-lg border border-[var(--line)] p-2">
        <summary>Review meeting-pattern evidence</summary>
        <dl className="grid gap-1 p-2">
          <div><dt className="font-semibold">Occurrences</dt><dd>{warning.occurrenceCount}</dd></div>
          <div><dt className="font-semibold">Distinct UTC dates</dt><dd>{warning.distinctUtcDates}</dd></div>
          <div><dt className="font-semibold">Newest evidence age</dt><dd>{warning.newestAgeDays} days</dd></div>
          <div><dt className="font-semibold">Observed weighted change</dt><dd>{warning.weightedChange === null ? "Unknown" : warning.weightedChange}</dd></div>
          <div><dt className="font-semibold">Confidence</dt><dd>{Math.round(warning.confidence * 100)}%</dd></div>
          <div><dt className="font-semibold">Confidence components</dt><dd>Count {Math.round(warning.confidenceComponents.count * 100)}%; dates {Math.round(warning.confidenceComponents.distinctDates * 100)}%; freshness {Math.round(warning.confidenceComponents.freshness * 100)}%</dd></div>
        </dl>
        <h4 className="font-semibold">Limitations</h4>
        <ul>{warning.limitations.map((limitation) => <li key={limitation}><span aria-hidden="true">△ </span>{limitation}</li>)}</ul>
      </details>
    </aside>
  );
}
