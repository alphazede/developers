import { Temporal } from "@js-temporal/polyfill";

export type SchedulerError = Readonly<{ code: "invalid-input" | "invalid-interval" | "invalid-permission"; message: string }>;
export type SchedulingIntentV1 = Readonly<{ schemaVersion: 1; taskId: string; requiredCapacity: number | null; goalAlignment: number | null }>;
export type ScheduleInterval = Readonly<{ id: string; startAt: string; endAt: string; kind?: "hard" | "protected" | "approved-recovery" | "soft-recovery" | "task"; projectRef?: string | null }>;
export type CapacityBucket = Readonly<{ id: string; startAt: string; capacity: number | null; confidence: number | null }>;
export type SchedulerInput = Readonly<{
  schemaVersion: 1; sourceRevision: number; now: string; horizonEnd: string;
  task: Readonly<{ id: string; source: "github" | "linear" | "local" | "fixture"; immutable: true; projectRef: string | null }>;
  durationMinutes: number; intent: SchedulingIntentV1; deadlineAt: string | null; permission: true;
  capacity: readonly CapacityBucket[]; intervals: readonly ScheduleInterval[]; softRecovery: readonly ScheduleInterval[];
}>;
export type Candidate = Readonly<{
  id: string; requestHash: string; taskId: string; startAt: string; endAt: string; score: number;
  breakdown: Readonly<{ capacityFit: number; deadlineUrgency: number; goalAlignment: number; contextSwitch: number; recoverySupport: number }>;
  confidence: number | null; limitations: readonly string[];
}>;
export type SchedulerResult = Readonly<{ ok: true; requestHash: string; candidates: readonly Candidate[] }> | Readonly<{ ok: false; error: SchedulerError }>;
export type TargetRejectionCode = "outside-horizon" | "duration" | "hard-conflict" | "after-deadline" | "permission";
export type TargetEvaluation = Readonly<{ ok: true; requestHash: string; candidate: Candidate }> | Readonly<{ ok: false; rejection: TargetRejectionCode }>;

const MAX_INTERVALS = 2_000, MAX_STARTS = 2_976, MINUTE = 60_000, QUARTER = 15 * MINUTE;
const URL_NAMESPACE = Uint8Array.from([0x6b,0xa7,0xb8,0x11,0x9d,0xad,0x11,0xd1,0x80,0xb4,0x00,0xc0,0x4f,0xd4,0x30,0xc8]);
const fail = (code: SchedulerError["code"], message: string): SchedulerResult => ({ ok: false, error: { code, message } });
const bytes = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = (value: unknown, max = 128): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const instant = (value: unknown): Temporal.Instant | undefined => {
  if (typeof value !== "string" || value.length > 40 || !value.endsWith("Z")) return undefined;
  try { const result = Temporal.Instant.from(value); return result.toString() === value ? result : undefined; } catch { return undefined; }
};
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : plain(value) ? `{${Object.keys(value).sort(bytes).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = async (algorithm: "SHA-1" | "SHA-256", value: Uint8Array) => new Uint8Array(await crypto.subtle.digest(algorithm, value.slice().buffer as ArrayBuffer));
const hex = (value: Uint8Array) => Array.from(value, (item) => item.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string) => hex(await digest("SHA-256", new TextEncoder().encode(value)));
export const uuidV5 = async (parts: readonly string[]): Promise<string> => {
  const name = new TextEncoder().encode(JSON.stringify(parts)), material = new Uint8Array(URL_NAMESPACE.length + name.length);
  material.set(URL_NAMESPACE); material.set(name, URL_NAMESPACE.length);
  const value = (await digest("SHA-1", material)).slice(0, 16); value[6] = (value[6]! & 0x0f) | 0x50; value[8] = (value[8]! & 0x3f) | 0x80;
  const encoded = hex(value); return `${encoded.slice(0,8)}-${encoded.slice(8,12)}-${encoded.slice(12,16)}-${encoded.slice(16,20)}-${encoded.slice(20)}`;
};
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
export const roundRatio = (numerator: number, denominator: number) => Math.floor((2 * numerator + denominator) / (2 * denominator));
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

type CheckedInterval = { id: string; startAt: string; endAt: string; start: number; end: number; kind: NonNullable<ScheduleInterval["kind"]>; projectRef: string | null };
const checkedIntervals = (raw: unknown, allowed: Set<string>, defaultKind: CheckedInterval["kind"]): CheckedInterval[] | undefined => {
  if (!Array.isArray(raw) || raw.length > MAX_INTERVALS) return undefined;
  const seen = new Set<string>(), result: CheckedInterval[] = [];
  for (const value of raw) {
    if (!plain(value) || Object.keys(value).some((key) => !["id","startAt","endAt","kind","projectRef"].includes(key)) || !text(value.id) || seen.has(value.id)
      || (value.kind !== undefined && (typeof value.kind !== "string" || !allowed.has(value.kind))) || (value.projectRef !== undefined && value.projectRef !== null && !text(value.projectRef, 256))) return undefined;
    const start = instant(value.startAt), end = instant(value.endAt); if (!start || !end || Temporal.Instant.compare(start, end) >= 0) return undefined;
    const kind = (value.kind ?? defaultKind) as CheckedInterval["kind"]; if (!allowed.has(kind)) return undefined;
    seen.add(value.id); result.push({ id: value.id, startAt: value.startAt as string, endAt: value.endAt as string, start: Number(start.epochMilliseconds), end: Number(end.epochMilliseconds), kind, projectRef: (value.projectRef as string | null | undefined) ?? null });
  }
  return result.sort((a,b) => a.start-b.start || a.end-b.end || bytes(a.id,b.id));
};
const mergeChecked = (input: readonly CheckedInterval[]): CheckedInterval[] => {
  const result: CheckedInterval[] = [];
  for (const item of input) {
    const previous = result.at(-1);
    if (previous && item.start <= previous.end) {
      if (item.end > previous.end) result[result.length - 1] = { ...previous, end: item.end, endAt: item.endAt };
    } else result.push({ ...item });
  }
  return result;
};
export const mergeIntervals = (input: readonly ScheduleInterval[]): readonly ScheduleInterval[] => {
  const checked = checkedIntervals(input, new Set(["hard","protected","approved-recovery","soft-recovery","task"]), "hard");
  if (!checked) throw new RangeError("INVALID_INTERVAL");
  return mergeChecked(checked).map(({ id, startAt, endAt, kind, projectRef }) => ({ id, startAt, endAt, kind, projectRef }));
};
const nearestTasks = (tasks: readonly CheckedInterval[], start: number, end: number): readonly CheckedInterval[] => {
  const left = tasks.filter((item) => item.end <= start && start-item.end < QUARTER).sort((a,b) => b.end-a.end || bytes(`${a.startAt}\0${a.endAt}\0${a.id}`, `${b.startAt}\0${b.endAt}\0${b.id}`))[0];
  const right = tasks.filter((item) => item.start >= end && item.start-end < QUARTER).sort((a,b) => a.start-b.start || bytes(`${a.startAt}\0${a.endAt}\0${a.id}`, `${b.startAt}\0${b.endAt}\0${b.id}`))[0];
  return [left, right].filter((item): item is CheckedInterval => !!item);
};

type CapacityValue = { id:string; startAt:string; at:number; capacity:number|null; confidence:number|null };
type Prepared = {
  input: SchedulerInput; nowMs: number; horizonMs: number; horizonMinutes: number; duration: number;
  deadlineMs: number | undefined; requestHash: string; hardMerged: CheckedInterval[]; softMerged: CheckedInterval[];
  bucketByStart: Map<number, CapacityValue>; taskBlocks: CheckedInterval[];
};
type PreparedResult = { ok: true; value: Prepared } | { ok: false; result: SchedulerResult; target: TargetRejectionCode };

const prepare = async (input: SchedulerInput): Promise<PreparedResult> => {
  if (!plain(input) || input.schemaVersion !== 1 || !revision(input.sourceRevision) || input.permission !== true) {
    const code = input?.permission !== true ? "invalid-permission" : "invalid-input";
    return { ok:false, result:fail(code,"Expected an authorized bounded scheduling request"), target:code === "invalid-permission" ? "permission" : "outside-horizon" };
  }
  const now = instant(input.now), horizon = instant(input.horizonEnd); if (!now || !horizon) return { ok:false, result:fail("invalid-input","Expected canonical UTC boundaries"), target:"outside-horizon" };
  const nowMs = Number(now.epochMilliseconds), horizonMs = Number(horizon.epochMilliseconds), horizonMinutes = (horizonMs-nowMs)/MINUTE;
  if (nowMs%QUARTER || horizonMs<=nowMs || horizonMinutes>31*1_440 || horizonMinutes%15) return { ok:false, result:fail("invalid-input","Expected a bounded 15-minute horizon"), target:"outside-horizon" };
  if (!plain(input.task) || !text(input.task.id) || !["github","linear","local","fixture"].includes(input.task.source) || input.task.immutable !== true || (input.task.projectRef !== null && !text(input.task.projectRef,256))
    || !Number.isSafeInteger(input.durationMinutes) || input.durationMinutes<=0 || input.durationMinutes>1_440 || input.durationMinutes%15) return { ok:false, result:fail("invalid-input","Expected an immutable task and 15-minute duration"), target:"duration" };
  if (!plain(input.intent) || input.intent.schemaVersion!==1 || input.intent.taskId!==input.task.id || ![input.intent.requiredCapacity,input.intent.goalAlignment].every((value) => value===null || Number.isInteger(value) && value>=0 && value<=100)) return { ok:false, result:fail("invalid-input","Expected a local scheduling intent"), target:"outside-horizon" };
  const deadline = input.deadlineAt===null ? undefined : instant(input.deadlineAt); if (input.deadlineAt!==null && !deadline) return { ok:false, result:fail("invalid-input","Expected a canonical deadline"), target:"after-deadline" };
  const hard = checkedIntervals(input.intervals,new Set(["hard","protected","approved-recovery","task"]),"hard"), soft = checkedIntervals(input.softRecovery,new Set(["soft-recovery"]),"soft-recovery");
  if (!hard || !soft || hard.length+soft.length>MAX_INTERVALS || [...hard,...soft].some((item) => item.start<nowMs || item.end>horizonMs)) return { ok:false, result:fail("invalid-interval","Expected bounded distinct intervals"), target:"hard-conflict" };
  if (!Array.isArray(input.capacity) || input.capacity.length>MAX_STARTS) return { ok:false, result:fail("invalid-input","Expected bounded capacity buckets"), target:"outside-horizon" };
  const capacity: CapacityValue[] = [], ids = new Set([input.task.id]), starts = new Set<number>();
  for (const item of input.capacity) {
    if (!plain(item) || Object.keys(item).sort(bytes).join()!=="capacity,confidence,id,startAt" || !text(item.id) || ids.has(item.id)) return { ok:false, result:fail("invalid-input","Expected distinct capacity identities"), target:"outside-horizon" };
    const at = instant(item.startAt), known = Number.isInteger(item.capacity) && (item.capacity as number)>=0 && (item.capacity as number)<=100;
    const confidence = item.confidence; if (!at || Number(at.epochMilliseconds)%QUARTER || Number(at.epochMilliseconds)<nowMs || Number(at.epochMilliseconds)>=horizonMs || starts.has(Number(at.epochMilliseconds))
      || !(item.capacity===null && confidence===null || known && typeof confidence==="number" && Number.isFinite(confidence) && confidence>=0 && confidence<=1)) return { ok:false, result:fail("invalid-input","Expected paired 15-minute capacity buckets"), target:"outside-horizon" };
    ids.add(item.id); starts.add(Number(at.epochMilliseconds)); capacity.push({ id:item.id, startAt:item.startAt as string, at:Number(at.epochMilliseconds), capacity:item.capacity as number|null, confidence:confidence as number|null });
  }
  for (const item of [...hard,...soft]) { if (ids.has(item.id)) return { ok:false, result:fail("invalid-interval","Expected distinct interval identities"), target:"hard-conflict" }; ids.add(item.id); }
  const sortCapacity = [...capacity].sort((a,b) => a.at-b.at || bytes(a.id,b.id)), tuple = (items: readonly CheckedInterval[]) => items.map((item) => [item.startAt,item.endAt,item.id,item.kind,item.projectRef]);
  const requestHash = await sha256(canonical([1,input.sourceRevision,input.now,input.horizonEnd,[input.task.id,input.task.source,input.task.immutable,input.task.projectRef],input.durationMinutes,[input.intent.schemaVersion,input.intent.taskId,input.intent.requiredCapacity,input.intent.goalAlignment],input.deadlineAt,sortCapacity.map((item) => [item.startAt,item.capacity,item.confidence,item.id]),tuple(hard),tuple(soft)]));
  return { ok:true, value:{ input,nowMs,horizonMs,horizonMinutes,duration:input.durationMinutes*MINUTE,deadlineMs:deadline ? Number(deadline.epochMilliseconds) : undefined,requestHash,hardMerged:mergeChecked(hard),softMerged:mergeChecked(soft),bucketByStart:new Map(capacity.map((item) => [item.at,item])),taskBlocks:hard.filter((item) => item.kind==="task") } };
};

const evaluate = async (prepared: Prepared, start: number): Promise<TargetEvaluation> => {
  const {input,nowMs,horizonMs,horizonMinutes,duration,deadlineMs,requestHash,hardMerged,softMerged,bucketByStart,taskBlocks}=prepared;
  if (!Number.isSafeInteger(start) || start%QUARTER || start<nowMs || start>=horizonMs) return {ok:false,rejection:"outside-horizon"};
  const end=start+duration, window={start,end};
  if (end>horizonMs) return {ok:false,rejection:"duration"};
  if (hardMerged.some((item) => overlap(window,item)>0)) return {ok:false,rejection:"hard-conflict"};
  if (deadlineMs!==undefined && end>deadlineMs) return {ok:false,rejection:"after-deadline"};
  const covered=Array.from({length:input.durationMinutes/15},(_,index) => bucketByStart.get(start+index*QUARTER));
  const unknownCapacity=input.intent.requiredCapacity===null || covered.some((item) => !item || item.capacity===null), n=covered.length, sum=covered.reduce((total,item) => total+(item?.capacity??0),0);
  const capacityFit=unknownCapacity?0:clamp(roundRatio(40*(100*n-Math.abs(sum-input.intent.requiredCapacity!*n)),100*n),40);
  const confidence=unknownCapacity?null:Math.round(Math.min(...covered.map((item) => item!.confidence!))*10_000)/10_000;
  const deadlineUrgency=deadlineMs===undefined?0:clamp(roundRatio(25*(horizonMinutes-clamp((deadlineMs-nowMs)/MINUTE,horizonMinutes))*(horizonMinutes-clamp((start-nowMs)/MINUTE,horizonMinutes)),horizonMinutes*horizonMinutes),25);
  const goalAlignment=input.intent.goalAlignment===null?0:clamp(roundRatio(15*input.intent.goalAlignment,100),15);
  const neighbors=nearestTasks(taskBlocks,start,end), penalties=input.task.projectRef===null?0:neighbors.reduce((total,item) => total+(item.projectRef===input.task.projectRef?0:1),0), contextSwitch=input.task.projectRef===null?0:clamp(10-5*penalties,10);
  const softOverlap=softMerged.reduce((total,item) => total+overlap(window,item),0), recoverySupport=clamp(roundRatio(10*(duration-softOverlap),duration),10);
  const limitations=[unknownCapacity&&"capacity_unknown",input.intent.goalAlignment===null&&"goal_alignment_unknown",input.task.projectRef===null&&"context_unknown"].filter(Boolean) as string[];
  const startAt=Temporal.Instant.fromEpochMilliseconds(start).toString(), endAt=Temporal.Instant.fromEpochMilliseconds(end).toString();
  const id=await uuidV5(["urn:capacity-scheduling:candidate:v1",requestHash,input.task.id,startAt,endAt]);
  const breakdown={capacityFit,deadlineUrgency,goalAlignment,contextSwitch,recoverySupport};
  return {ok:true,requestHash,candidate:{id,requestHash,taskId:input.task.id,startAt,endAt,score:Object.values(breakdown).reduce((a,b)=>a+b,0),breakdown,confidence,limitations}};
};

export const evaluateTarget = async (input: SchedulerInput, startAt: string): Promise<TargetEvaluation> => {
  if (!plain(input) || input.permission !== true) return {ok:false,rejection:"permission"};
  const prepared=await prepare(input); if (!prepared.ok) return {ok:false,rejection:prepared.target};
  const start=instant(startAt); if (!start) return {ok:false,rejection:"outside-horizon"};
  return evaluate(prepared.value,Number(start.epochMilliseconds));
};

export const recommend = async (input: SchedulerInput): Promise<SchedulerResult> => {
  const prepared=await prepare(input); if (!prepared.ok) return prepared.result;
  const candidates: Candidate[]=[];
  for (let start=prepared.value.nowMs; start<prepared.value.horizonMs; start+=QUARTER) {
    const result=await evaluate(prepared.value,start); if (result.ok) candidates.push(result.candidate);
  }
  return {ok:true,requestHash:prepared.value.requestHash,candidates:candidates.sort((a,b)=>b.score-a.score || bytes(a.startAt,b.startAt) || bytes(a.id,b.id)).slice(0,3)};
};
