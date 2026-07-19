import type { PresentedExplanation } from "../../application/explanation";

export function ExplanationPanel({ explanation }: Readonly<{ explanation: PresentedExplanation }>) {
  return <section aria-labelledby="explanation-heading" className="rounded-xl border border-neutral-200 bg-white p-6">
    <p className="m-0 text-xs font-semibold uppercase tracking-[0.12em] text-neutral-600">Recommendation evidence · score {explanation.score}</p>
    <h3 id="explanation-heading" className="mt-3 text-2xl font-semibold tracking-[-0.035em] text-neutral-950">{explanation.heading}</h3>
    <ul className="mt-4 grid gap-3 pl-5 text-sm leading-6 text-neutral-700">{explanation.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
    {explanation.source === "deterministic" && <p className="mt-4 text-sm text-neutral-600">Deterministic evidence view. Explanations never approve, change, or guarantee a proposal.</p>}
  </section>;
}
