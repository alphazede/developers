"use client";

import { useEffect, useRef, useState } from "react";

import type { PresentedExplanation } from "../../application/explanation";
import { ExplanationPanel } from "../privacy/explanation-panel";
import type { SourceAction, SourcePrivacyRow } from "./source-model";

type Pending = Readonly<{ action: SourceAction; returnTo: HTMLButtonElement }>;

export function SourcesPrivacySection({ rows, explanation }: Readonly<{ rows: readonly SourcePrivacyRow[]; explanation: PresentedExplanation }>) {
  const [pending, setPending] = useState<Pending | null>(null), [announcement, setAnnouncement] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (pending) confirmRef.current?.focus(); }, [pending]);
  const close = (message?: string) => {
    const returnTo = pending?.returnTo;
    setPending(null); if (message) setAnnouncement(message);
    requestAnimationFrame(() => returnTo?.focus());
  };
  const review = (action: SourceAction, event: React.MouseEvent<HTMLButtonElement>) => setPending({ action, returnTo: event.currentTarget });
  const privacyAction = (id: string, label: string, scope: string, event: React.MouseEvent<HTMLButtonElement>) => review({ id, label, scope, enabled: true }, event);
  return <section aria-labelledby="sources-privacy-heading" className="bg-white px-4 py-24 text-neutral-950 sm:px-6 lg:px-8" data-testid="sources-privacy">
    <div className="mx-auto max-w-[75rem]">
      <div className="max-w-3xl">
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-neutral-600">Your data, source by source</p>
        <h2 id="sources-privacy-heading" className="mt-3 text-4xl font-semibold leading-none tracking-[-0.045em] sm:text-5xl">Sources &amp; privacy</h2>
        <p className="mt-4 max-w-2xl text-base leading-7 text-neutral-600">See exactly what each source can do, what is retained, and what remains a local or synthetic preview.</p>
      </div>
      <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => <article key={row.source} className="min-w-0 rounded-xl border border-neutral-200 bg-neutral-100 p-6">
          <div className="flex items-start justify-between gap-3"><h3 className="m-0 text-xl font-semibold tracking-[-0.025em]">{row.name}</h3><span className="shrink-0 rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs font-semibold">● {row.status}</span></div>
          <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-4 text-sm leading-6">
            <p className="m-0"><strong>Access:</strong> {row.access}</p>
            <p className="mt-3"><strong>Freshness:</strong> {row.freshness}</p>
            <p className="mt-3"><strong>Retained:</strong> {row.retained}</p>
            <p className="mt-3"><strong>Limits:</strong> {row.limits}</p>
            <div className="mt-3"><strong>Capabilities:</strong><ul className="mt-1 pl-5">{row.capabilities.map((capability) => <li key={capability}><code className="break-all text-xs">{capability}</code></li>)}</ul></div>
          </div>
          <div className="mt-4 grid gap-2">{row.actions.map((action) => <div key={action.id}>
            <button type="button" disabled={!action.enabled} aria-label={action.enabled ? `Preview ${action.label}` : `${action.label} unavailable`} onClick={(event) => review(action, event)} className="min-h-11 w-full rounded-lg border border-neutral-950 bg-neutral-950 px-4 py-2 text-sm font-semibold text-white disabled:border-neutral-300 disabled:bg-neutral-200 disabled:text-neutral-600">{action.enabled ? "Preview" : "Unavailable"} {action.label}</button>
            {!action.enabled && <p className="mt-1 text-xs text-neutral-600">{action.disabledReason}</p>}
          </div>)}</div>
        </article>)}
      </div>
      <div className="mt-12 grid gap-4 lg:grid-cols-2">
        <ExplanationPanel explanation={explanation} />
        <section aria-labelledby="privacy-controls-heading" className="rounded-xl border border-neutral-200 bg-neutral-100 p-6">
          <h3 id="privacy-controls-heading" className="m-0 text-2xl font-semibold tracking-[-0.035em]">Privacy controls</h3>
          <p className="mt-3 text-sm leading-6 text-neutral-700">Raw confirmed source data is retained for 30 days unless pinned; daily rhythm curves for 90 days; proposal, approval, and effect receipts for 30 days; OAuth tokens only while connected.</p>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={(event) => privacyAction("privacy-export", "data export", "Show the fields a redacted export would contain", event)} className="min-h-11 rounded-lg border border-neutral-950 bg-neutral-950 px-4 py-2 text-sm font-semibold text-white">Preview data export</button>
            <button type="button" onClick={(event) => privacyAction("privacy-forget", "pattern forgetting", "Show what forgetting private recurring-meeting patterns would remove", event)} className="min-h-11 rounded-lg border border-neutral-400 bg-white px-4 py-2 text-sm font-semibold text-neutral-950">Preview pattern forgetting</button>
            <button type="button" onClick={(event) => privacyAction("privacy-delete", "profile deletion", "Show what deleting the profile, source data, tokens, and effect authority would remove", event)} className="min-h-11 rounded-lg border border-red-800 bg-white px-4 py-2 text-sm font-semibold text-red-900 sm:col-span-2">Preview profile deletion</button>
          </div>
        </section>
      </div>
    </div>
    <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    {pending && <div role="dialog" aria-modal="true" aria-labelledby="privacy-confirm-title" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.12em] text-neutral-600">Preview only</p>
        <h3 id="privacy-confirm-title" className="mt-3 text-2xl font-semibold tracking-[-0.035em]">Preview {pending.action.label}</h3>
        <p className="mt-4 leading-7 text-neutral-700">{pending.action.scope}. This control has no data-changing callback.</p>
        {pending.action.id === "privacy-delete" && <p className="mt-3 font-semibold text-red-900">Export or back up your data first. Deletion removes token and effect authority.</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => close()} className="min-h-11 rounded-lg border border-neutral-400 bg-white px-4 py-2 font-semibold">Cancel</button>
          <button ref={confirmRef} type="button" onClick={() => close("Preview acknowledged. No data changed; no receipt or effect occurred.")} className="min-h-11 rounded-lg border border-neutral-950 bg-neutral-950 px-4 py-2 font-semibold text-white">Acknowledge preview</button>
        </div>
      </div>
    </div>}
  </section>;
}
