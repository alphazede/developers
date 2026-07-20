"use client";

import type { AccessibleVisualizationV1 } from "../../contracts/v1";
import type { CapacityPointV1 } from "../../ui/projections";
import { EvidenceDrawer, type EvidenceActionPayload } from "../evidence/evidence-drawer";
import { RhythmChart } from "./rhythm-chart";

export type RhythmFingerprintProps = Readonly<{
  visualization: AccessibleVisualizationV1;
  capacityPoints: readonly CapacityPointV1[];
  onEvidenceAction?: (payload: EvidenceActionPayload) => void;
}>;

export function RhythmFingerprint({ visualization, capacityPoints, onEvidenceAction }: RhythmFingerprintProps) {
  const known = capacityPoints.filter((point) => point.capacity !== null).length;
  const unknown = capacityPoints.length - known;

  return (
    <div className="min-w-0 max-w-full" aria-labelledby="rhythm-fingerprint-title">
      <div className="section-heading">
        <div><p className="eyebrow">Evidence-backed capacity</p><h3 id="rhythm-fingerprint-title">Rhythm fingerprint</h3></div>
        <span><span aria-hidden="true">●</span> {known} known · <span aria-hidden="true">◌</span> {unknown} unknown</span>
      </div>
      <p>{visualization.summary}</p>
      <p><span aria-hidden="true">▨ </span>Confidence is shown as a labeled patterned band; gaps marked <span aria-hidden="true">◌</span> “unknown” remain gaps.</p>

      <details className="semantic-detail" data-testid="rhythm-evidence-disclosure">
        <summary>Exact capacity evidence and complete table ({capacityPoints.length} points)</summary>
        <ul className="capacity-list">
          {capacityPoints.map((point) => (
            <li
              key={point.startAt}
              data-capacity-status={point.status}
              className={point.status === "unknown" ? "border-dashed" : "border-double"}
              style={point.status === "unknown" ? { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 8px, rgb(95 105 95 / 10%) 8px 10px)" } : undefined}
            >
              <strong><span aria-hidden="true">{point.status === "known" ? "●" : "◌"} </span><time dateTime={point.startAt}>{point.timeLabel}</time>: {point.statusLabel}</strong>
              <span><span aria-hidden="true">▨ </span>Confidence band {Math.round(point.confidence * 100)}%</span>
              <span><span aria-hidden="true"># </span>Effective sample size {point.components.effectiveSampleSize}</span>
              <span><span aria-hidden="true">▥ </span>Date coverage {Math.round(point.components.dateScore * 100)}%</span>
              <span><span aria-hidden="true">↻ </span>Freshness {Math.round(point.components.freshnessScore * 100)}%</span>
              <span><span aria-hidden="true">△ </span>Limitations: {point.limitations.join(", ") || "None reported"}</span>
              <EvidenceDrawer point={point} onAction={onEvidenceAction} />
            </li>
          ))}
        </ul>
        <table aria-label="Rhythm evidence table">
          <thead><tr>{visualization.table.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
          <tbody>{visualization.table.rows.map((row, index) => <tr key={`${row[0]}-${index}`}>{row.map((cell, cellIndex) => cellIndex === 0 ? <th key={cellIndex} scope="row">{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </details>

      <RhythmChart visualization={visualization} capacityPoints={capacityPoints} />
    </div>
  );
}
