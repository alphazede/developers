import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import calendarFixture from "../../../fixtures/connectors/google/calendar-pages.json";
import gmailFixture from "../../../fixtures/connectors/google/selected-gmail.json";
import { ConnectorRegistry, type ConnectorManifest, type ReadClock } from "../../../src/application/connectors";
import { GoogleCalendarAdapter, GoogleCalendarEffectAdapter, SelectedGmailAdapter, type SelectedMessageAction } from "../../../src/adapters/google";
import { AdapterBoundaryError } from "../../../src/adapters/shared";
import { authorizeRetry, createEffectState, EffectRunner, type EffectIntent } from "../../../src/application/effects";

const fetchedAt="2026-07-23T15:00:00Z",freshness={schemaVersion:1 as const,fetchedAt,sourceUpdatedAt:fetchedAt,expiresAt:"2026-07-30T15:00:00Z",state:"fresh" as const};
const manifest=(source:"google-calendar"|"gmail",write=false):ConnectorManifest=>source==="gmail"?{schemaVersion:1,source,mode:"gmail-addon",capabilities:["gmail.selected-message.read"],consentRevision:1,freshness}:{schemaVersion:1,source,mode:"oauth",capabilities:["calendar.read",...(write?["calendar.event.write" as const]:[])],consentRevision:1,freshness};
const timer=():ReadClock=>({now:()=>0,sleep:async()=>undefined,withTimeout:async(operation)=>operation});

describe("GoogleCalendarAdapter",()=>{
  it("normalizes bounded pages deterministically and HMACs participants once",async()=>{
    const calls:(string|null)[]=[];let participants:string[][]=[];
    const adapter=new GoogleCalendarAdapter(new ConnectorRegistry([manifest("google-calendar")]),{readPage:async(cursor)=>{calls.push(cursor);return{status:200,value:calendarFixture.pages[cursor===null?0:1]};}},(series,ids)=>{participants=[...participants,[...ids]];return createHmac("sha256","local-only-key").update(`${series}|${ids.join("|")}`).digest("hex");},timer());
    const result=await adapter.sync({consentRevision:1,fetchedAt});expect(result.ok).toBe(true);if(!result.ok)return;
    expect(calls).toEqual([null,"page-2"]);expect(result.commitments.map((item)=>item.provenance.sourceEntityId)).toEqual(["event-a","event-b"]);
    expect(result.commitments[1]).toMatchObject({title:"Planning review",participantSetKey:expect.stringMatching(/^[a-f0-9]{64}$/),provenance:{freshness:{expiresAt:"2026-07-30T15:00:00Z"}}});
    expect(participants).toEqual([["person-a","person-b"]]);const json=JSON.stringify(result);expect(json).not.toMatch(/person-a|person-b|attendeeIds/);
  });

  it("rejects hostile fields, looping cursors, page overflow, scope, stale, and retry failures locally",async()=>{
    const registry=new ConnectorRegistry([manifest("google-calendar")]),sync=async(value:unknown)=>new GoogleCalendarAdapter(registry,{readPage:async()=>({status:200,value})},()=>"a".repeat(64),timer()).sync({consentRevision:1,fetchedAt});
    await expect(sync({...calendarFixture.pages[1],extra:true})).resolves.toMatchObject({ok:false,error:{code:"MALFORMED_SOURCE"}});
    await expect(sync({items:Array.from({length:101},()=>calendarFixture.pages[0]!.items[0]),nextPageToken:null})).resolves.toMatchObject({ok:false,error:{code:"MALFORMED_SOURCE"}});
    const looping=new GoogleCalendarAdapter(registry,{readPage:async()=>({status:200,value:{items:[],nextPageToken:"same"}})},()=>"a".repeat(64),timer());
    await expect(looping.sync({consentRevision:1,fetchedAt})).resolves.toMatchObject({ok:false,error:{code:"MALFORMED_SOURCE"}});
    await expect(new GoogleCalendarAdapter(registry,{readPage:async()=>({status:503})},()=>"a".repeat(64),timer()).sync({consentRevision:1,fetchedAt})).resolves.toMatchObject({ok:false,error:{code:"PROVIDER_UNAVAILABLE"}});
    await expect(new GoogleCalendarAdapter(registry,{readPage:async()=>({status:200,value:{items:[],nextPageToken:null}})},()=>"a".repeat(64),timer()).sync({consentRevision:2,fetchedAt})).resolves.toMatchObject({ok:false,error:{code:"SCOPE_DENIED"}});
  });
});

describe("SelectedGmailAdapter",()=>{
  it("accepts only confirmed add-on selections and discards raw text",async()=>{
    const adapter=new SelectedGmailAdapter(new ConnectorRegistry([manifest("gmail")]));expect(adapter.status).toEqual({mode:"gmail-addon",normalOAuth:false,requiredScope:"https://www.googleapis.com/auth/gmail.addons.current.message.readonly"});
    const action=structuredClone(gmailFixture) as SelectedMessageAction,result=await adapter.normalize([action],{consentRevision:1,fetchedAt});
    expect(result[0]).toMatchObject({kind:"selected-email-commitment",title:"Send confirmed summary",deadlineAt:"2026-07-24T22:00:00Z",provenance:{source:"gmail",sourceEntityId:"message-1"}});
    const serialized=JSON.stringify(result);expect(serialized).not.toContain(action.message.selectedBodyFragment);expect(serialized).not.toContain(action.message.subject);expect(serialized).not.toContain("fragmentSha256");
  });

  it("rejects implicit, altered, duplicate, oversized, and normal-OAuth-shaped input without retaining body",async()=>{
    const adapter=new SelectedGmailAdapter(new ConnectorRegistry([manifest("gmail")])) ,action=structuredClone(gmailFixture) as SelectedMessageAction;
    const hostile:unknown[]=[{message:action.message},{...action,confirmation:{...action.confirmation,confirmed:false}},{...action,message:{...action.message,selectedBodyFragment:"altered"}},{...action,message:{...action.message,mailboxQuery:"all"}},[action,action]];
    for(const value of hostile){try{await adapter.normalize(Array.isArray(value)&&value.length===2?value as SelectedMessageAction[]:[value as SelectedMessageAction],{consentRevision:1,fetchedAt});throw new Error("accepted");}catch(error){expect(error).toBeInstanceOf(AdapterBoundaryError);expect(JSON.stringify(error)).not.toContain(action.message.selectedBodyFragment);}}
  });
});

describe("GoogleCalendarEffectAdapter",()=>{
  const intent:EffectIntent={effectId:"22222222-2222-4222-8222-222222222222",proposalId:"11111111-1111-4111-8111-111111111111",marker:"capacity-effect:22222222-2222-4222-8222-222222222222",provider:"google-calendar"};
  const registry=()=>new ConnectorRegistry([manifest("google-calendar",true)]);
  it("reconciles persisted unknown state after restart and lets only EffectRunner authorize one confirmed-absent retry",async()=>{
    const inserts:unknown[]=[],finds:unknown[]=[];let attempt=0;
    const port={insert:async(value:unknown)=>{inserts.push(value);return++attempt===1?{outcome:"timeout"}:{outcome:"succeeded",marker:intent.marker,providerEntityId:"event-1"};},find:async(value:unknown)=>{finds.push(value);return{outcome:"absent"};}};
    const first=await new EffectRunner(new GoogleCalendarEffectAdapter(port as never,registry(),1)).execute(intent,createEffectState(intent));expect(first.state.status).toBe("unknown");
    const restartedRunner=new EffectRunner(new GoogleCalendarEffectAdapter(port as never,registry(),1)),absent=await restartedRunner.reconcile(intent,structuredClone(first.state));expect(absent.state.status).toBe("confirmed-absent");
    const blocked=await restartedRunner.execute(intent,absent.state);expect(blocked.providerCalled).toBe(false);expect(inserts).toHaveLength(1);
    const authorized=authorizeRetry(intent,absent.state),retried=await restartedRunner.execute(intent,authorized.state);expect(retried.state).toMatchObject({status:"retry-completed",providerEntityId:"event-1"});expect(inserts).toHaveLength(2);expect(finds).toHaveLength(1);
    expect(JSON.stringify(inserts)).not.toContain(intent.proposalId);expect(inserts[0]).toMatchObject({effectId:intent.effectId,privateMarker:intent.marker,signal:expect.any(AbortSignal)});
  });

  it("finds an accepted unknown effect without another insert and blocks forged intent",async()=>{
    let inserts=0;const adapter=new GoogleCalendarEffectAdapter({insert:async()=>{inserts+=1;return{outcome:"connection-lost"};},find:async()=>({outcome:"found",providerEntityId:"existing"})},registry(),1);
    expect(await adapter.execute(intent)).toEqual({outcome:"connection-lost"});expect(await adapter.reconcile(intent.effectId,intent.marker)).toEqual({outcome:"found",providerEntityId:"existing"});expect(inserts).toBe(1);
    await expect(adapter.execute({...intent,marker:"forged"})).rejects.toMatchObject({code:"UNSUPPORTED_CONTRACT"});expect(inserts).toBe(1);
  });

  it("enforces write consent and aborts each never-resolving provider call after 10 seconds without a blind retry",async()=>{
    let inserts=0,finds=0,insertSignal:AbortSignal|undefined,findSignal:AbortSignal|undefined;
    const timeout=async<T>(_operation:Promise<T>,milliseconds:number,onTimeout:()=>void):Promise<T>=>{expect(milliseconds).toBe(10_000);onTimeout();throw new Error("timeout");};
    const provider={insert:async(input:{signal:AbortSignal})=>{inserts+=1;insertSignal=input.signal;return new Promise<never>(()=>undefined);},find:async(input:{signal:AbortSignal})=>{finds+=1;findSignal=input.signal;return new Promise<never>(()=>undefined);}};
    const denied=new GoogleCalendarEffectAdapter(provider as never,new ConnectorRegistry([manifest("google-calendar")]),1,timeout);
    await expect(denied.execute(intent)).rejects.toMatchObject({code:"SCOPE_DENIED"});expect(inserts).toBe(0);
    const adapter=new GoogleCalendarEffectAdapter(provider as never,registry(),1,timeout);
    expect(await adapter.execute(intent)).toEqual({outcome:"connection-lost"});expect(inserts).toBe(1);expect(insertSignal?.aborted).toBe(true);
    expect(await adapter.reconcile(intent.effectId,intent.marker)).toEqual({outcome:"unknown",reason:"connection-lost"});expect(finds).toBe(1);expect(findSignal?.aborted).toBe(true);expect(inserts).toBe(1);
  });
});
