import { Temporal } from "@js-temporal/polyfill";

export type RhythmObservation = Readonly<{
  id: string; observedAt: string; localTime: string; value: number; reliability: number; immutable: boolean;
  signal: "self-report" | "task-outcome" | "readiness" | "activity" | "meeting-after";
  correction?: string | null; deleted?: boolean;
  provenance: Readonly<{ schemaVersion: 1; source: "local" | "fixture" | "google-calendar" | "gmail" | "github" | "linear" | "microsoft" | "strava" | "oura" | "ics"; sourceEntityId: string; consentRevision: number; freshness: Readonly<{ schemaVersion: 1; fetchedAt: string; sourceUpdatedAt: string | null; expiresAt: string | null; state: "fresh" | "stale" | "revoked" | "fixture" }>; importedAt: string }>;
}>;
export type RhythmInput = Readonly<{ observations: readonly RhythmObservation[]; now: string; timeZone: string; configVersion: string; sourceConsents: Readonly<Record<string, Readonly<{ revision: number; active: boolean }>>>; buckets: readonly (number | string)[] }>;
export type RhythmFailure = Readonly<{ ok: false; error: Readonly<{ code: "invalid-input" | "invalid-observation" | "invalid-instant" | "invalid-zone" | "invalid-bucket" | "future-evidence"; message: string }> }>;
export type RhythmEstimate = Readonly<{ bucketMinutes: number; status: "known" | "unknown"; capacity: number | null; confidence: number; confidenceBand: "low" | "medium" | "high"; totalCount: number; contributingCount: number; distinctLocalDates: number; newestAgeDays: number | null; weights: Readonly<{ sum: number; sumSquares: number }>; weightedMean: number | null; components: Readonly<{ effectiveSampleSize: number; sampleScore: number; dateScore: number; freshnessScore: number }>; precision: Readonly<{ weights: 12; means: 12; effectiveSampleSize: 4; confidence: 4 }>; limitations: readonly string[] }>;
export type RhythmSuccess = Readonly<{ ok: true; cache: "hit" | "miss"; key: string; value: readonly RhythmEstimate[] }>;
export type RhythmResult = RhythmSuccess | RhythmFailure;
export type RhythmCache = Readonly<{ maxEntries: number; entries: Map<string, readonly RhythmEstimate[]> }>;

type Consent = Readonly<{ revision: number; active: boolean }>;
type ValidObservation = Readonly<{ observation: RhythmObservation; instant: Temporal.Instant; minute: number; ageDays: number; date: string; recency: number; value: number; identity: string }>;

const MAX_OBSERVATIONS = 10_000, MAX_BUCKETS = 48, MAX_TEXT = 512, MAX_ID = 128, MAX_SOURCE_ENTITY = 256, MAX_CONSENTS = 20;
const signals = new Set(["self-report", "task-outcome", "readiness", "activity", "meeting-after"]);
const sources = new Set(["local", "fixture", "google-calendar", "gmail", "github", "linear", "microsoft", "strava", "oura", "ics"]);
const freshnessStates = new Set(["fresh", "stale", "revoked", "fixture"]);
const round = (value: number, decimals: number): number => Number(value.toFixed(decimals));
const failure = (code: RhythmFailure["error"]["code"], message: string): RhythmFailure => ({ ok: false, error: { code, message } });
const plainRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = (value: unknown, max = MAX_TEXT): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const safeRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const canonicalInstant = (value: unknown): Temporal.Instant | undefined => {
  if (!text(value, 40)) return undefined;
  try { const parsed = Temporal.Instant.from(value); return parsed.toString() === value && value.endsWith("Z") ? parsed : undefined; } catch { return undefined; }
};
const minute = (value: unknown): number | undefined => {
  if (!text(value, 18)) return undefined;
  try { const time = Temporal.PlainTime.from(value); return time.second === 0 && time.millisecond === 0 && time.microsecond === 0 && time.nanosecond === 0 ? time.hour * 60 + time.minute : undefined; } catch { return undefined; }
};
const bucket = (value: unknown): number | undefined => typeof value === "number" ? Number.isInteger(value) && value >= 0 && value < 1_440 ? value : undefined : minute(value);
const compareBytes = (left: string, right: string): number => {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plainRecord(value)) return `{${Object.entries(value).sort(([a], [b]) => compareBytes(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
const sha256 = async (value: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (item) => item.toString(16).padStart(2, "0")).join("");

const validateConsents = (value: unknown): Record<string, Consent> | undefined => {
  if (!plainRecord(value) || Object.keys(value).length > MAX_CONSENTS) return undefined;
  const result: Record<string, Consent> = Object.create(null) as Record<string, Consent>;
  for (const [source, consent] of Object.entries(value)) {
    if (!text(source, MAX_ID) || !plainRecord(consent) || !safeRevision(consent.revision) || typeof consent.active !== "boolean" || Object.keys(consent).length !== 2) return undefined;
    result[source] = { revision: consent.revision, active: consent.active };
  }
  return result;
};
const validateObservation = (value: unknown, now: Temporal.Instant, timeZone: string): ValidObservation | RhythmFailure => {
  if (!plainRecord(value) || Object.keys(value).some((key) => !["id", "observedAt", "localTime", "value", "reliability", "immutable", "signal", "correction", "deleted", "provenance"].includes(key))) return failure("invalid-observation", "Expected immutable validated observation values");
  const observation = value as RhythmObservation, instant = canonicalInstant(observation.observedAt), localMinute = minute(observation.localTime), provenance = observation.provenance;
  if (!text(observation.id, MAX_ID) || !instant || localMinute === undefined || !Number.isFinite(observation.value) || !Number.isFinite(observation.reliability) || observation.reliability < 0 || observation.reliability > 1 || observation.immutable !== true || !signals.has(observation.signal) || (observation.correction !== undefined && observation.correction !== null && !text(observation.correction)) || (observation.deleted !== undefined && typeof observation.deleted !== "boolean") || !plainRecord(provenance) || provenance.schemaVersion !== 1 || !sources.has(provenance.source) || !text(provenance.sourceEntityId, MAX_SOURCE_ENTITY) || !safeRevision(provenance.consentRevision) || !canonicalInstant(provenance.importedAt) || !plainRecord(provenance.freshness)) return failure("invalid-observation", "Expected immutable validated observation values");
  const freshness = provenance.freshness;
  if (freshness.schemaVersion !== 1 || !canonicalInstant(freshness.fetchedAt) || (freshness.sourceUpdatedAt !== null && !canonicalInstant(freshness.sourceUpdatedAt)) || (freshness.expiresAt !== null && !canonicalInstant(freshness.expiresAt)) || !freshnessStates.has(freshness.state) || Object.keys(freshness).length !== 5 || Object.keys(provenance).length !== 6) return failure("invalid-observation", "Expected immutable validated observation values");
  if (Temporal.Instant.compare(instant, now) > 0) return failure("future-evidence", "Future evidence is invalid");
  const ageDays = Number(instant.until(now).total({ unit: "days" }));
  return { observation, instant, minute: localMinute, ageDays, date: instant.toZonedDateTimeISO(timeZone).toPlainDate().toString(), recency: 2 ** (-ageDays / 14), value: Math.max(-1, Math.min(1, observation.value)), identity: canonical(observation) };
};

export const createRhythmCache = (maxEntries: number): RhythmCache => {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("Expected a positive cache size");
  return { maxEntries, entries: new Map() };
};

export const estimatePersonalRhythm = async (input: RhythmInput, cache?: RhythmCache): Promise<RhythmResult> => {
  if (!plainRecord(input) || !Array.isArray(input.observations) || !Array.isArray(input.buckets) || input.observations.length > MAX_OBSERVATIONS || input.buckets.length > MAX_BUCKETS || !text(input.configVersion) || !text(input.timeZone, 64)) return failure("invalid-input", "Expected bounded rhythm input");
  const now = canonicalInstant(input.now);
  if (!now) return failure("invalid-instant", "Expected a canonical UTC now instant");
  try { if (Temporal.ZonedDateTime.from(`2000-01-01T00:00[${input.timeZone}]`).timeZoneId !== input.timeZone || /^[+-]/.test(input.timeZone)) return failure("invalid-zone", "Expected an IANA time zone"); } catch { return failure("invalid-zone", "Expected an IANA time zone"); }
  const requested = input.buckets.map(bucket);
  if (requested.some((item) => item === undefined) || new Set(requested).size !== requested.length) return failure("invalid-bucket", "Expected unique minute-of-day buckets");
  const consents = validateConsents(input.sourceConsents);
  if (!consents) return failure("invalid-input", "Expected bounded rhythm input");
  const inspected: ValidObservation[] = [], ids = new Set<string>();
  for (const raw of input.observations) {
    const checked = validateObservation(raw, now, input.timeZone);
    if ("ok" in checked) return checked;
    if (ids.has(checked.observation.id)) return failure("invalid-observation", "Expected distinct observation ids");
    ids.add(checked.observation.id); inspected.push(checked);
  }
  inspected.sort((a, b) => compareBytes(a.identity, b.identity));
  const buckets = requested as number[];
  const key = await sha256(canonical({ observations: inspected.map(({ observation }) => observation), now: input.now, timeZone: input.timeZone, configVersion: input.configVersion, sourceConsents: consents, buckets }));
  const cached = cache?.entries.get(key);
  if (cached) return { ok: true, cache: "hit", key, value: cached };
  const estimates = buckets.map((target): RhythmEstimate => {
    let sum = 0, sumSquares = 0, weighted = 0, newest = Infinity, count = 0;
    const dates = new Set<string>();
    for (const item of inspected) {
      const { observation } = item, consent = consents[observation.provenance.source];
      const distance = Math.min(Math.abs(item.minute - target), 1_440 - Math.abs(item.minute - target)), kernel = Math.max(0, 1 - distance / 120);
      if (observation.deleted || observation.provenance.freshness.state === "revoked" || !consent?.active || consent.revision !== observation.provenance.consentRevision || observation.reliability === 0 || kernel === 0) continue;
      const weight = round(observation.reliability * item.recency * kernel, 12);
      if (weight === 0) continue;
      count += 1; sum += weight; sumSquares += weight ** 2; weighted += item.value * weight; newest = Math.min(newest, item.ageDays); dates.add(item.date);
    }
    const ess = sumSquares === 0 ? 0 : sum ** 2 / sumSquares, mean = sum === 0 ? null : weighted / sum;
    const sampleScore = Math.min(1, ess / 12), dateScore = Math.min(1, dates.size / 5), freshnessScore = newest === Infinity ? 0 : Math.max(0, 1 - newest / 14), confidence = round((sampleScore + dateScore + freshnessScore) / 3, 4);
    const limitations = [ess < 4 && "insufficient-effective-sample-size", dates.size < 2 && "insufficient-distinct-local-dates", newest === Infinity ? "no-contributing-evidence" : newest > 14 && "stale-evidence"].filter(Boolean) as string[];
    const known = limitations.length === 0;
    return { bucketMinutes: target, status: known ? "known" : "unknown", capacity: known && mean !== null ? Math.max(0, Math.min(100, Math.round(50 + 40 * mean))) : null, confidence, confidenceBand: confidence < .55 ? "low" : confidence < .8 ? "medium" : "high", totalCount: inspected.length, contributingCount: count, distinctLocalDates: dates.size, newestAgeDays: newest === Infinity ? null : round(newest, 12), weights: { sum: round(sum, 12), sumSquares: round(sumSquares, 12) }, weightedMean: mean === null ? null : round(mean, 12), components: { effectiveSampleSize: round(ess, 4), sampleScore: round(sampleScore, 4), dateScore: round(dateScore, 4), freshnessScore: round(freshnessScore, 4) }, precision: { weights: 12, means: 12, effectiveSampleSize: 4, confidence: 4 }, limitations };
  });
  if (cache) { cache.entries.set(key, estimates); while (cache.entries.size > cache.maxEntries) cache.entries.delete(cache.entries.keys().next().value!); }
  return { ok: true, cache: "miss", key, value: estimates };
};
