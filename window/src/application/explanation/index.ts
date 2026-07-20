import { z } from "zod";

import { explanationPacketV1Schema, type ExplanationPacketV1 } from "../../contracts/v1";

const ALLOWED_KINDS = new Set(["capacity-fit", "deadline-urgency", "goal-alignment", "context-switch", "recovery-support", "meeting-pattern"]);
const PROHIBITED = /\b(feasible|feasibility|permission|approve(?:d|s|al)?|authori[sz](?:e|ed|ation)|mutat(?:e|ion)|write|delete|diagnos(?:e|is|tic)|medical|stress(?:ed|ful)?|caus(?:e|al|ation)|toxic|guarantee(?:d|s)?|personality|bad person|anxious|anxiety|depressed|disease|diseased|illness|sick|condition|healthy|unhealthy|burnout|burned out|exhausted|overwhelmed|lazy|difficult person)\b/i;
const agentOutputSchema = z.object({
  schemaVersion: z.literal(1),
  heading: z.string().min(1).max(80),
  bullets: z.array(z.string().min(1).max(280)).min(1).max(6),
}).strict();

export type ExplanationAgentInput = Readonly<{
  schemaVersion: 1;
  score: number;
  evidence: readonly Readonly<{ kind: string; weight: number; freshness: Readonly<{ state: string; fetchedAt: string }> }>[];
  alternatives: readonly Readonly<{ startAt: string; endAt: string; score: number }>[];
}>;
export type ExplanationAgent = Readonly<{
  explain(input: ExplanationAgentInput, signal: AbortSignal): Promise<unknown>;
}>;
export type PresentedExplanation = Readonly<{
  schemaVersion: 1;
  score: number;
  heading: string;
  bullets: readonly string[];
  source: "agent" | "deterministic";
}>;
type Timeout = <T>(operation: Promise<T>, milliseconds: number, onTimeout: () => void) => Promise<T>;

const systemTimeout: Timeout = async <T>(operation: Promise<T>, milliseconds: number, onTimeout: () => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error("EXPLANATION_TIMEOUT")); }, milliseconds);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const fallback = (packet: ExplanationPacketV1): PresentedExplanation => freeze({
  schemaVersion: 1,
  score: packet.score,
  heading: "Why this time was suggested",
  bullets: [
    ...packet.evidence.filter((item) => ALLOWED_KINDS.has(item.kind)).slice(0, 5).map((item) =>
      `Evidence data: ${item.kind} contributed ${item.weight} points; freshness is ${item.freshness.state}.`,
    ),
    ...(packet.limitations.length > 0 ? [`Limitations recorded: ${packet.limitations.length}. Review the underlying evidence before acting.`] : []),
  ].slice(0, 6),
  source: "deterministic",
});

export class ExplanationPresenter {
  constructor(private readonly agent?: ExplanationAgent, private readonly withTimeout: Timeout = systemTimeout) {}

  async present(input: ExplanationPacketV1): Promise<PresentedExplanation> {
    const parsed = explanationPacketV1Schema.safeParse(input);
    if (!parsed.success || parsed.data.evidence.some((item) => !ALLOWED_KINDS.has(item.kind))) throw new RangeError("INVALID_EXPLANATION_PACKET");
    const packet = parsed.data;
    if (!this.agent) return fallback(packet);
    const safeInput: ExplanationAgentInput = freeze({
      schemaVersion: 1,
      score: packet.score,
      evidence: packet.evidence.map(({ kind, weight, freshness }) => ({ kind, weight, freshness: { state: freshness.state, fetchedAt: freshness.fetchedAt } })),
      alternatives: packet.alternatives.map((item) => ({ ...item })),
    });
    const controller = new AbortController();
    try {
      const output = agentOutputSchema.safeParse(await this.withTimeout(this.agent.explain(safeInput, controller.signal), 12_000, () => controller.abort()));
      if (!output.success || PROHIBITED.test(`${output.data.heading} ${output.data.bullets.join(" ")}`)) return fallback(packet);
      return freeze({ schemaVersion: 1, score: packet.score, heading: output.data.heading, bullets: output.data.bullets, source: "agent" });
    } catch {
      return fallback(packet);
    }
  }
}
