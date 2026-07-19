import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { evaluateTarget, mergeIntervals, recommend, roundRatio, type Candidate, type ScheduleInterval, type SchedulerInput } from "../../../src/domain/schedule";

const origin="2026-07-23T12:00:00Z";
const at=(minutes:number)=>Temporal.Instant.from(origin).add({minutes}).toString();
const base=():SchedulerInput=>({
  schemaVersion:1,sourceRevision:4,now:at(0),horizonEnd:at(120),
  task:{id:"task-a",source:"github",immutable:true,projectRef:"p"},durationMinutes:30,
  intent:{schemaVersion:1,taskId:"task-a",requiredCapacity:80,goalAlignment:50},deadlineAt:at(60),permission:true,
  capacity:Array.from({length:8},(_,index)=>({id:`capacity-${index}`,startAt:at(index*15),capacity:80,confidence:index===1?0.87654:0.95})),
  intervals:[],softRecovery:[],
});
const target=async(input:SchedulerInput,start=0):Promise<Candidate>=>{const result=await evaluateTarget(input,at(start));expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.rejection);return result.candidate;};
const referenceUuidV5=(parts:readonly string[])=>{
  const namespace=Buffer.from("6ba7b8119dad11d180b400c04fd430c8","hex"),name=Buffer.from(JSON.stringify(parts),"utf8");
  const value=createHash("sha1").update(Buffer.concat([namespace,name])).digest().subarray(0,16);value[6]=(value[6]!&0x0f)|0x50;value[8]=(value[8]!&0x3f)|0x80;
  const hex=value.toString("hex");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

describe("Scheduler",()=>{
  it("unions containment and adjacency without shrinking coverage",()=>{
    const merged=mergeIntervals([
      {id:"outer",startAt:at(0),endAt:at(60)},
      {id:"inner",startAt:at(15),endAt:at(30)},
      {id:"adjacent",startAt:at(60),endAt:at(75)},
    ]);
    expect(merged).toEqual([{id:"outer",startAt:at(0),endAt:at(75),kind:"hard",projectRef:null}]);
  });

  it("preserves seeded randomized union coverage and canonical DST-resolved instants",()=>{
    let seed=0x5eed1234;
    const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
    for(let run=0;run<100;run+=1){
      const intervals:ScheduleInterval[]=Array.from({length:5+Math.floor(random()*20)},(_,index)=>{
        const start=Math.floor(random()*16),length=1+Math.floor(random()*6);
        return {id:`${run}-${index}`,startAt:at(start*15),endAt:at((start+length)*15)};
      });
      const before=Array.from({length:22},(_,slot)=>intervals.some((item)=>Temporal.Instant.compare(item.startAt,at((slot+1)*15))<0&&Temporal.Instant.compare(item.endAt,at(slot*15))>0));
      const union=mergeIntervals(intervals);
      const after=Array.from({length:22},(_,slot)=>union.some((item)=>Temporal.Instant.compare(item.startAt,at((slot+1)*15))<0&&Temporal.Instant.compare(item.endAt,at(slot*15))>0));
      expect(after).toEqual(before);
    }
    expect(mergeIntervals([{id:"dst",startAt:"2026-11-01T06:00:00Z",endAt:"2026-11-01T06:15:00Z"}])[0]?.startAt).toBe("2026-11-01T06:00:00Z");
  });

  it("treats protected and approved recovery as hard while preserving touching boundaries",async()=>{
    for(const kind of ["hard","protected","approved-recovery"] as const){
      const input={...base(),intervals:[{id:`block-${kind}`,startAt:at(0),endAt:at(30),kind}]};
      expect((await evaluateTarget(input,at(0)))).toEqual({ok:false,rejection:"hard-conflict"});
      expect(await evaluateTarget(input,at(30))).toMatchObject({ok:true,candidate:{startAt:at(30)}});
    }
  });

  it("uses the exact half-up component formulas and four-decimal minimum confidence",async()=>{
    const exact=await target(base());
    expect(roundRatio(15*50,100)).toBe(8);
    expect(exact.breakdown).toEqual({capacityFit:40,deadlineUrgency:13,goalAlignment:8,contextSwitch:10,recoverySupport:10});
    expect(exact.score).toBe(81);expect(exact.confidence).toBe(0.8765);
    expect((await target({...base(),capacity:base().capacity.map((bucket)=>({...bucket,capacity:30}))})).breakdown.capacityFit).toBe(20);
    expect((await target({...base(),deadlineAt:at(30)})).breakdown.deadlineUrgency).toBe(19);
    expect((await target({...base(),deadlineAt:at(45)},15)).breakdown.deadlineUrgency).toBe(14);
  });

  it("scores only nearest task neighbors and resolves equal-distance identity bytewise",async()=>{
    const interval=(id:string,start:number,end:number,projectRef:string|null):ScheduleInterval=>({id,startAt:at(start),endAt:at(end),kind:"task",projectRef});
    const common={...base(),deadlineAt:null,intervals:[interval("left",5,25,"p"),interval("right",65,80,"other"),interval("far",0,15,"other")]};
    expect((await target(common,30)).breakdown.contextSwitch).toBe(5);
    expect((await target({...common,intervals:[interval("left",5,25,"p"),interval("right",65,80,"p")]},30)).breakdown.contextSwitch).toBe(10);
    expect((await target({...common,intervals:[interval("left",5,25,"other"),interval("right",65,80,"other")]},30)).breakdown.contextSwitch).toBe(0);
    expect((await target({...common,intervals:[interval("z",5,25,"other"),interval("a",5,25,"p")]},30)).breakdown.contextSwitch).toBe(10);
    const unknown=await target({...base(),task:{...base().task,projectRef:null}},0);
    expect(unknown.breakdown.contextSwitch).toBe(0);expect(unknown.limitations).toContain("context_unknown");
  });

  it("unions soft recovery once and never defaults it to hard",async()=>{
    const score=async(intervals:readonly ScheduleInterval[])=>(await target({...base(),softRecovery:intervals},0)).breakdown.recoverySupport;
    expect(await score([{id:"six",startAt:at(0),endAt:Temporal.Instant.from(at(0)).add({minutes:6}).toString()}])).toBe(8);
    expect(await score([{id:"a",startAt:at(0),endAt:at(15)},{id:"b",startAt:at(5),endAt:at(15)}])).toBe(5);
    expect(await score([{id:"all",startAt:at(0),endAt:at(30)}])).toBe(0);
    expect(await evaluateTarget({...base(),softRecovery:[{id:"soft",startAt:at(0),endAt:at(30)}]},at(0))).toMatchObject({ok:true});
  });

  it("keeps missing capacity and intent signals explicit",async()=>{
    const missing={...base(),intent:{...base().intent,requiredCapacity:null,goalAlignment:null},capacity:base().capacity.slice(1)};
    const candidate=await target(missing);
    expect(candidate).toMatchObject({confidence:null,breakdown:{capacityFit:0,goalAlignment:0}});
    expect(candidate.limitations).toEqual(["capacity_unknown","goal_alignment_unknown"]);
  });

  it("is permutation-stable but hashes every semantic field",async()=>{
    const enriched={...base(),intervals:[{id:"task-block",startAt:at(75),endAt:at(90),kind:"task" as const,projectRef:"p"}],softRecovery:[{id:"soft",startAt:at(30),endAt:at(45),kind:"soft-recovery" as const,projectRef:"q"}]};
    const one=await recommend(enriched),permuted=await recommend({...enriched,capacity:[...enriched.capacity].reverse(),intervals:[...enriched.intervals].reverse(),softRecovery:[...enriched.softRecovery].reverse()});
    expect(permuted).toEqual(one);expect(one.ok).toBe(true);if(!one.ok)return;
    const variants=[
      {...enriched,capacity:enriched.capacity.map((item,index)=>index===0?{...item,confidence:0.91}:item)},
      {...enriched,intervals:[{...enriched.intervals[0]!,kind:"protected" as const}]},
      {...enriched,intervals:[{...enriched.intervals[0]!,projectRef:"changed"}]},
      {...enriched,task:{...enriched.task,projectRef:"changed"}},
    ];
    const originalTarget=await evaluateTarget(enriched,at(0));expect(originalTarget.ok).toBe(true);if(!originalTarget.ok)return;
    for(const variant of variants){
      const result=await recommend(variant);expect(result.ok&&result.requestHash).not.toBe(one.requestHash);
      const changed=await evaluateTarget(variant,at(0));expect(changed.ok).toBe(true);if(changed.ok)expect(changed.candidate.id).not.toBe(originalTarget.candidate.id);
    }
  });

  it("rejects duplicate identities, duplicate bucket starts, and invalid confidence pairs",async()=>{
    const duplicateId={...base(),capacity:[{...base().capacity[0]!,id:"task-a"}]};
    expect((await recommend(duplicateId)).ok).toBe(false);
    expect((await recommend({...base(),capacity:[base().capacity[0]!,{...base().capacity[1]!,startAt:at(0)}]})).ok).toBe(false);
    expect((await recommend({...base(),capacity:[{...base().capacity[0]!,capacity:null,confidence:0.5}]})).ok).toBe(false);
    expect((await recommend({...base(),capacity:[{...base().capacity[0]!,confidence:null}]})).ok).toBe(false);
    expect((await recommend({...base(),capacity:[{...base().capacity[0]!,confidence:1.01}]})).ok).toBe(false);
    expect((await recommend({...base(),intervals:[{id:"same",startAt:at(60),endAt:at(75)}],softRecovery:[{id:"same",startAt:at(75),endAt:at(90)}]})).ok).toBe(false);
  });

  it("creates standard UUIDv5 identities and stable earliest top-three ties",async()=>{
    const input={...base(),deadlineAt:null,intent:{...base().intent,goalAlignment:null,requiredCapacity:null},capacity:[]};
    const first=await recommend(input),repeat=await recommend(input);expect(repeat).toEqual(first);expect(first.ok).toBe(true);if(!first.ok)return;
    expect(first.candidates.map((item)=>item.startAt)).toEqual([at(0),at(15),at(30)]);
    const candidate=first.candidates[0]!;
    expect(candidate.id).toBe(referenceUuidV5(["urn:capacity-scheduling:candidate:v1",first.requestHash,"task-a",candidate.startAt,candidate.endAt]));
  });

  it("shares byte-identical recommendation and exact-target evaluation for every feasible grid start",async()=>{
    for(let start=0;start<=90;start+=15){
      const input={...base(),deadlineAt:null,intervals:start===0?[]:[{id:`before-${start}`,startAt:at(0),endAt:at(start),kind:"protected" as const}]};
      const snapshot=JSON.stringify(input.task),ranked=await recommend(input),evaluated=await evaluateTarget(input,at(start));
      expect(ranked.ok).toBe(true);expect(evaluated.ok).toBe(true);if(!ranked.ok||!evaluated.ok)continue;
      expect(ranked.candidates).toContainEqual(evaluated.candidate);expect(evaluated.requestHash).toBe(ranked.requestHash);expect(JSON.stringify(input.task)).toBe(snapshot);
    }
  });

  it("returns payload-free target rejection codes with hard-first filtering",async()=>{
    expect(await evaluateTarget(base(),"2026-07-23T12:01:00Z")).toEqual({ok:false,rejection:"outside-horizon"});
    expect(await evaluateTarget(base(),at(105))).toEqual({ok:false,rejection:"duration"});
    expect(await evaluateTarget({...base(),intervals:[{id:"hard",startAt:at(0),endAt:at(30)}]},at(0))).toEqual({ok:false,rejection:"hard-conflict"});
    expect(await evaluateTarget({...base(),deadlineAt:at(15)},at(0))).toEqual({ok:false,rejection:"after-deadline"});
    expect(await evaluateTarget({...base(),permission:false} as unknown as SchedulerInput,at(0))).toEqual({ok:false,rejection:"permission"});
    expect(await evaluateTarget({...base(),deadlineAt:at(15),intervals:[{id:"hard",startAt:at(0),endAt:at(30)}]},at(0))).toEqual({ok:false,rejection:"hard-conflict"});
    expect(await evaluateTarget({...base(),deadlineAt:at(30)},at(0))).toMatchObject({ok:true});
  });

  it("emits the 100-iteration benchmark receipt without a wall-time gate",async()=>{
    for(let index=0;index<3;index+=1)await recommend(base());
    const samples:number[]=[];let candidateCount=0;
    for(let index=0;index<100;index+=1){const started=performance.now(),result=await recommend(base());samples.push(performance.now()-started);candidateCount=result.ok?result.candidates.length:0;}
    samples.sort((a,b)=>a-b);const receipt={iterations:100,candidateCount,p50:Number(samples[49]!.toFixed(3)),p95:Number(samples[94]!.toFixed(3))};
    console.info("scheduler-benchmark",JSON.stringify(receipt));expect(receipt).toMatchObject({iterations:100,candidateCount:3});
  });
});
