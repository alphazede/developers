import { describe, expect, it } from "vitest";
import { authorizeRetry, createEffectState, EffectRunner, FakeGoogleCalendarPort, type EffectIntent, type EffectState, type ProviderReply } from "../../../src/application/effects";

const effectId="22222222-2222-4222-8222-222222222222",proposalId="11111111-1111-4111-8111-111111111111";
const intent:EffectIntent={effectId,proposalId,marker:`capacity-effect:${effectId}`,provider:"google-calendar"};
const succeed:ProviderReply={outcome:"succeeded",marker:intent.marker,providerEntityId:"google-event-123"};

describe("EffectRunner",()=>{
  it("records pending, attempted, and successful provider identity truthfully",async()=>{
    const port=new FakeGoogleCalendarPort([succeed]),runner=new EffectRunner(port),result=await runner.execute(intent,createEffectState(intent));
    expect(result).toMatchObject({providerCalled:true,state:{status:"succeeded",attempts:1,providerEntityId:"google-event-123",effectId,proposalId}});
    expect(result.state.history.map((item)=>item.status)).toEqual(["effect-pending","attempted","succeeded"]);
    expect(port).toMatchObject({executeCount:1,reconcileCount:0,transcript:["execute"]});
  });

  it.each([
    [{outcome:"timeout"},"timeout"],
    [{outcome:"connection-lost"},"connection-lost"],
    [{outcome:"malformed"},"malformed-response"],
    [{outcome:"succeeded",marker:"wrong",providerEntityId:"event"},"malformed-response"],
    [{outcome:"succeeded",marker:intent.marker,providerEntityId:""},"malformed-response"],
    [{outcome:"timeout",extra:true},"malformed-response"],
  ] as const)("maps provider reply %j to unknown %s",async(reply,reason)=>{
    const port=new FakeGoogleCalendarPort([reply as unknown as ProviderReply]),result=await new EffectRunner(port).execute(intent,createEffectState(intent));
    expect(result).toMatchObject({providerCalled:true,state:{status:"unknown",unknownReason:reason,providerEntityId:null}});
    expect(result.state.history.map((item)=>item.status)).toEqual(["effect-pending","attempted","unknown"]);expect(port.executeCount).toBe(1);
  });

  it("reports thrown execute and reconcile calls as connection-lost provider calls",async()=>{
    const executePort=new FakeGoogleCalendarPort([new Error("offline")]),unknown=await new EffectRunner(executePort).execute(intent,createEffectState(intent));
    expect(unknown).toMatchObject({providerCalled:true,state:{status:"unknown",unknownReason:"connection-lost"}});expect(executePort.executeCount).toBe(1);
    const reconcilePort=new FakeGoogleCalendarPort([], [new Error("offline")]),reconciled=await new EffectRunner(reconcilePort).reconcile(intent,unknown.state);
    expect(reconciled).toMatchObject({providerCalled:true,state:{status:"unknown",unknownReason:"connection-lost"}});expect(reconcilePort.reconcileCount).toBe(1);
  });

  it("blocks blind retry and marks found reconciliation terminal without execute",async()=>{
    const port=new FakeGoogleCalendarPort([{outcome:"timeout"}], [{outcome:"found",providerEntityId:"existing-event"}]),runner=new EffectRunner(port);
    const unknown=await runner.execute(intent,createEffectState(intent));
    expect(await runner.execute(intent,unknown.state)).toEqual({state:unknown.state,providerCalled:false});
    const found=await runner.reconcile(intent,unknown.state);
    expect(found).toMatchObject({providerCalled:true,state:{status:"reconciliation-found",providerEntityId:"existing-event",effectId}});
    expect(found.state.history.map((item)=>item.status)).toEqual(["effect-pending","attempted","unknown","reconciliation-found"]);
    expect(await runner.execute(intent,found.state)).toEqual({state:found.state,providerCalled:false});
    expect(port).toMatchObject({executeCount:1,reconcileCount:1,transcript:["execute","reconcile"]});
  });

  it("requires confirmed absence and a separate pure authorization before one identical retry",async()=>{
    const port=new FakeGoogleCalendarPort([{outcome:"timeout"},succeed],[{outcome:"absent"}]),runner=new EffectRunner(port);
    const unknown=await runner.execute(intent,createEffectState(intent)),absent=await runner.reconcile(intent,unknown.state);
    expect(absent).toMatchObject({providerCalled:true,state:{status:"confirmed-absent",attempts:1,retryAuthorized:false}});
    const authorized=authorizeRetry(intent,absent.state);expect(authorized).toMatchObject({providerCalled:false,state:{status:"retry-authorized",retryAuthorized:true,effectId}});
    const retried=await runner.execute(intent,authorized.state);
    expect(retried).toMatchObject({providerCalled:true,state:{status:"retry-completed",attempts:2,retryAuthorized:true,providerEntityId:"google-event-123",effectId}});
    expect(retried.state.history.map((item)=>item.status)).toEqual(["effect-pending","attempted","unknown","confirmed-absent","retry-authorized","attempted","retry-completed"]);
    expect(await runner.execute(intent,retried.state)).toEqual({state:retried.state,providerCalled:false});expect(port.executeCount).toBe(2);expect(port.reconcileCount).toBe(1);
  });

  it("keeps retry unknown and blocks second retry authorization",async()=>{
    const port=new FakeGoogleCalendarPort([{outcome:"timeout"},{outcome:"connection-lost"}],[{outcome:"absent"},{outcome:"absent"}]),runner=new EffectRunner(port);
    const first=await runner.execute(intent,createEffectState(intent)),absent=await runner.reconcile(intent,first.state),authorized=authorizeRetry(intent,absent.state),second=await runner.execute(intent,authorized.state);
    expect(second).toMatchObject({providerCalled:true,state:{status:"unknown",attempts:2,unknownReason:"connection-lost",retryAuthorized:true}});
    expect(authorizeRetry(intent,second.state)).toEqual({state:second.state,providerCalled:false});
    const secondAbsent=await runner.reconcile(intent,second.state);expect(secondAbsent.state.status).toBe("confirmed-absent");
    expect(authorizeRetry(intent,secondAbsent.state)).toEqual({state:secondAbsent.state,providerCalled:false});expect(port.executeCount).toBe(2);
  });

  it("fails closed on forged states and mismatched complete intents before provider calls",async()=>{
    const port=new FakeGoogleCalendarPort([succeed],[{outcome:"absent"}]),runner=new EffectRunner(port),state=createEffectState(intent),other="33333333-3333-4333-8333-333333333333";
    const forged:EffectState[]=[
      {...state,status:"retry-authorized",attempts:1,retryAuthorized:true} as EffectState,
      {...state,marker:"capacity-effect:forged"} as EffectState,
      {...state,attempts:2} as EffectState,
      {...state,history:[{...state.history[0]!,status:"attempted",attempts:1}]} as EffectState,
      {...state,provider:"google-calendar",unknownReason:"timeout"} as EffectState,
    ];
    for(const value of forged)expect((await runner.execute(intent,value)).providerCalled).toBe(false);
    expect((await runner.execute({...intent,effectId:other,marker:`capacity-effect:${other}`},state)).providerCalled).toBe(false);
    expect((await runner.execute({...intent,proposalId:other},state)).providerCalled).toBe(false);
    expect((await runner.reconcile(intent,state)).providerCalled).toBe(false);
    expect(port).toMatchObject({executeCount:0,reconcileCount:0,transcript:[]});
  });

  it("validates complete intent construction and keeps fake transcripts payload-free",async()=>{
    expect(()=>createEffectState({...intent,effectId:"bad"})).toThrow("INVALID_EFFECT_INTENT");
    expect(()=>createEffectState({...intent,marker:"wrong"})).toThrow("INVALID_EFFECT_INTENT");
    expect(()=>new EffectRunner({provider:"other"} as never)).toThrow("UNSUPPORTED_PROVIDER");
    const port=new FakeGoogleCalendarPort([{outcome:"timeout"}],[{outcome:"unknown",reason:"timeout"}]),runner=new EffectRunner(port),unknown=await runner.execute(intent,createEffectState(intent));await runner.reconcile(intent,unknown.state);
    const transcript=JSON.stringify(port.transcript);expect(transcript).not.toContain(effectId);expect(transcript).not.toContain(proposalId);expect(transcript).not.toContain("capacity-effect");
  });
});
