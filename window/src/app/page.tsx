import { AccessibleTimeline } from "../components/today/accessible-timeline";
import { ExplanationPresenter } from "../application/explanation";
import { buildSourcePrivacyRows, mergeSourceManifests, syntheticPrivacyManifests } from "../components/sources/source-model";
import { SourcesPrivacySection } from "../components/sources/sources-privacy-section";
import type { ExplanationPacketV1 } from "../contracts/v1";
import { buildJordanTodayProjection } from "../runtime/today-fixture";
import { getLiveConnectorRuntime } from "../server/connectors/live-runtime";

const COMMAND_ID = "90000000-0000-4000-8000-000000000007";

export default async function Home() {
  const projection = await buildJordanTodayProjection();
  const proposal = projection.timeline.find((item) => item.type === "proposal" && item.score !== null && item.breakdown !== null);
  if (!proposal || proposal.score === null || proposal.breakdown === null) throw new Error("Explanation evidence unavailable");
  const fetchedAt = "2026-07-23T15:00:00Z";
  const evidence = [
    ["capacity-fit", "Capacity fit evidence", proposal.breakdown.capacityFit],
    ["deadline-urgency", "Deadline urgency evidence", proposal.breakdown.deadlineUrgency],
    ["goal-alignment", "Goal alignment evidence", proposal.breakdown.goalAlignment],
    ["context-switch", "Context-switch evidence", proposal.breakdown.contextSwitch],
    ["recovery-support", "Recovery support evidence", proposal.breakdown.recoverySupport],
  ] as const;
  const packet: ExplanationPacketV1 = {
    schemaVersion: 1, proposalId: proposal.id, score: proposal.score,
    evidence: evidence.map(([kind, summary, weight]) => ({ kind, summary, weight, freshness: { schemaVersion: 1, fetchedAt, sourceUpdatedAt: null, expiresAt: null, state: "fixture" } })),
    alternatives: projection.timeline.filter((item) => item.type === "proposal" && item.score !== null).slice(0, 3).map((item) => ({ startAt: item.startAt, endAt: item.endAt, score: item.score as number })),
    limitations: [...proposal.limitations], forbiddenAuthority: true,
  };
  const explanation = await new ExplanationPresenter().present(packet);
  const liveManifests = await (await getLiveConnectorRuntime())?.manifests() ?? [];
  const sourceRows = buildSourcePrivacyRows(mergeSourceManifests(syntheticPrivacyManifests(fetchedAt), liveManifests));
  return (
    <div data-testid="today-page" data-revision={projection.revision}>
      <AccessibleTimeline projection={projection} commandId={COMMAND_ID} proposalRevision={0} />
      <SourcesPrivacySection rows={sourceRows} explanation={explanation} />
    </div>
  );
}
