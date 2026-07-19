import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/connectors/linear/issues.json";
import { ConnectorRegistry, type ConnectorManifest, type ReadClock } from "../../../src/application/connectors";
import { LinearTaskAdapter, linearConnectorManifest } from "../../../src/adapters/linear";
import { schedulingIntentV1Schema } from "../../../src/contracts/v1";

const fetchedAt="2026-07-23T15:00:00Z",freshness={schemaVersion:1 as const,fetchedAt,sourceUpdatedAt:fetchedAt,expiresAt:"2026-07-24T15:00:00Z",state:"fresh" as const};
const manifest=():ConnectorManifest=>linearConnectorManifest(1,freshness);
const clock=():ReadClock=>({now:()=>0,sleep:async()=>undefined,withTimeout:async(operation)=>operation});
type Forbidden<T> = Extract<keyof T,"create"|"update"|"complete"|"comment"|"delete"|"request"|"mutate">;
const compileTimeReadOnly:Forbidden<LinearTaskAdapter> extends never?true:false=true;void compileTimeReadOnly;

describe("LinearTaskAdapter",()=>{
  it("normalizes deterministically while estimate duration requires an explicit bounded rule",async()=>{
    const read={readPage:async(cursor:string|null)=>({status:200,value:fixture.pages[cursor===null?0:1]})},registry=new ConnectorRegistry([manifest()]);
    const without=await new LinearTaskAdapter(registry,read,clock()).sync({consentRevision:1,fetchedAt,estimateRule:null});expect(without.ok).toBe(true);if(!without.ok)return;
    expect(without.tasks.map((task)=>task.provenance.sourceEntityId)).toEqual(["team-window:linear-issue-3:WIN-3","team-window:linear-issue-12:WIN-12"]);
    expect(without.tasks.map((task)=>task.id)).toEqual(["34f6734e-d39d-58e6-97c6-a3b01dd1b650","b82fcc49-58f4-502c-8c0d-40b90ef9d87a"]);
    expect(without.tasks[1]).toMatchObject({source:"linear",durationMinutes:null,deadlineAt:"2026-07-24T22:00:00Z",priority:2,projectRef:"Cycle 1",immutable:true});
    const withRule=await new LinearTaskAdapter(registry,read,clock()).sync({consentRevision:1,fetchedAt,estimateRule:{minutesPerPoint:15,maximumPoints:32}});expect(withRule.ok).toBe(true);if(!withRule.ok)return;
    expect(withRule.tasks[1]!.durationMinutes).toBe(60);expect(withRule.tasks.map((task)=>task.id)).toEqual(without.tasks.map((task)=>task.id));
    expect(Object.isFrozen(withRule.tasks)).toBe(true);expect(Object.isFrozen(withRule.tasks[1])).toBe(true);
    const permuted=await new LinearTaskAdapter(registry,{readPage:async()=>({status:200,value:{items:[fixture.pages[1]!.items[0],fixture.pages[0]!.items[0]],nextCursor:null}})},clock()).sync({consentRevision:1,fetchedAt,estimateRule:null});
    expect(permuted).toEqual(without);
  });

  it("keeps source task bytes and scheduling authority separate",async()=>{
    const adapter=new LinearTaskAdapter(new ConnectorRegistry([manifest()]),{readPage:async(cursor)=>({status:200,value:fixture.pages[cursor===null?0:1]})},clock()),result=await adapter.sync({consentRevision:1,fetchedAt,estimateRule:null});expect(result.ok).toBe(true);if(!result.ok)return;
    const task=result.tasks[1]!,before=JSON.stringify(task),intent=schedulingIntentV1Schema.parse({schemaVersion:1,taskId:task.id,requiredCapacity:55,goalAlignment:60});
    expect(intent).toEqual({schemaVersion:1,taskId:task.id,requiredCapacity:55,goalAlignment:60});expect(JSON.stringify(task)).toBe(before);
    expect(task).not.toHaveProperty("requiredCapacity");expect(task).not.toHaveProperty("goalAlignment");
    for(const method of ["create","update","complete","comment","delete","request","mutate"])expect(Reflect.get(adapter,method)).toBeUndefined();
  });

  it("rejects malformed pages, invalid rules, duplicates, loops, and hostile source fields",async()=>{
    const registry=new ConnectorRegistry([manifest()]),base=fixture.pages[0]!.items[0]!;
    const sync=async(value:unknown,estimateRule:unknown=null)=>new LinearTaskAdapter(registry,{readPage:async()=>({status:200,value})},clock()).sync({consentRevision:1,fetchedAt,estimateRule:estimateRule as never});
    for(const value of [
      {...fixture.pages[1],extra:true},
      {items:[{...base,description:"private body"}],nextCursor:null},
      {items:[base,base],nextCursor:null},
      {items:Array.from({length:101},()=>base),nextCursor:null},
      {items:[],nextCursor:"x".repeat(101)},
    ])await expect(sync(value)).resolves.toMatchObject({ok:false,error:{code:"MALFORMED_SOURCE"}});
    for(const rule of [{minutesPerPoint:30,maximumPoints:32},{minutesPerPoint:15,maximumPoints:0},{minutesPerPoint:15,maximumPoints:32,extra:true}])await expect(sync({items:[],nextCursor:null},rule)).resolves.toMatchObject({ok:false,error:{code:"MALFORMED_SOURCE"}});
    let calls=0;const loop=new LinearTaskAdapter(registry,{readPage:async()=>{calls+=1;return{status:200,value:{items:[],nextCursor:"same"}};}},clock());
    await expect(loop.sync({consentRevision:1,fetchedAt,estimateRule:null})).resolves.toMatchObject({ok:false,error:{code:"MALFORMED_SOURCE"}});expect(calls).toBe(2);
  });

  it("retries once and aborts cancellation without partial tasks",async()=>{
    const registry=new ConnectorRegistry([manifest()]);let calls=0;
    const retry=new LinearTaskAdapter(registry,{readPage:async()=>++calls===1?{status:429,retryAfterSeconds:0}:{status:200,value:{items:[],nextCursor:null}}},clock());
    await expect(retry.sync({consentRevision:1,fetchedAt,estimateRule:null})).resolves.toMatchObject({ok:true,tasks:[]});expect(calls).toBe(2);
    let aborted=false;const timeout:ReadClock={now:()=>0,sleep:async()=>undefined,withTimeout:async(_operation,_ms,onTimeout)=>{onTimeout();throw new Error("timeout");}};
    const hanging=new LinearTaskAdapter(registry,{readPage:async(_cursor,signal)=>{signal.addEventListener("abort",()=>{aborted=true;});return new Promise(()=>undefined);}},timeout);
    await expect(hanging.sync({consentRevision:1,fetchedAt,estimateRule:null})).resolves.toMatchObject({ok:false,error:{code:"PROVIDER_UNAVAILABLE"}});expect(aborted).toBe(true);
  });
});
