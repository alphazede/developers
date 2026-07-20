import { describe, expect, it } from "vitest";

import { ConnectorPrivacyService, ConnectorRegistry, executeBoundedRead, type AtomicLocalRevocationPort, type ConnectorManifest, type LocalSourceRevocationReceipt, type ReadClock } from "../../../src/application/connectors";

const now="2026-07-23T15:00:00Z";
const manifest=(source:ConnectorManifest["source"],capabilities:ConnectorManifest["capabilities"],mode:ConnectorManifest["mode"],consentRevision=1,state:"fresh"|"stale"|"revoked"|"fixture"="fresh"):ConnectorManifest=>({schemaVersion:1,source,capabilities,mode,consentRevision,freshness:{schemaVersion:1,fetchedAt:now,sourceUpdatedAt:now,expiresAt:"2026-07-30T15:00:00Z",state}});
const clock=():ReadClock=>{let current=0;return{now:()=>current,sleep:async(ms)=>{current+=ms;},withTimeout:async(operation)=>operation};};

describe("ConnectorRegistry",()=>{
  it("accepts exact current and future source manifests without capability escape",()=>{
    const registry=new ConnectorRegistry([
      manifest("google-calendar",["calendar.read","calendar.event.write"],"oauth"),
      manifest("gmail",["gmail.selected-message.read"],"gmail-addon"),
      manifest("github",["task.connect","task.read","task.sync","task.revoke"],"github-app"),
      manifest("linear",["task.connect","task.read","task.sync","task.revoke"],"oauth"),
      manifest("ics",["calendar.preview","calendar.import","calendar.export"],"import"),
      manifest("microsoft",["calendar.fixture.read"],"fixture",1,"fixture"),
      manifest("strava",["activity.fixture.read"],"fixture",1,"fixture"),
      manifest("oura",["readiness.fixture.read"],"fixture",1,"fixture"),
    ]);
    expect(registry.snapshot()).toHaveLength(8);
    expect(()=>registry.register(manifest("gmail",["gmail.selected-message.read"],"gmail-addon"))).toThrow("INVALID_CONNECTOR_MANIFEST");
    expect(()=>new ConnectorRegistry([manifest("gmail",["calendar.read"] as never,"gmail-addon")])).toThrow("INVALID_CONNECTOR_MANIFEST");
    registry.update(manifest("google-calendar",["calendar.read"],"oauth",2));
    expect(()=>registry.update(manifest("google-calendar",["calendar.read","calendar.event.write"],"oauth",3))).toThrow("INVALID_CONNECTOR_UPDATE");
    expect(()=>registry.reconsent(manifest("google-calendar",["calendar.read","calendar.event.write"],"oauth",3),false)).toThrow("INVALID_CONNECTOR_RECONSENT");
    registry.reconsent(manifest("google-calendar",["calendar.read","calendar.event.write"],"oauth",3),true);
    expect(registry.require("google-calendar","calendar.event.write",3)).toBeNull();
  });

  it("isolates stale and revoked sources",()=>{
    const registry=new ConnectorRegistry([manifest("google-calendar",["calendar.read"],"oauth"),manifest("gmail",["gmail.selected-message.read"],"gmail-addon")]);
    registry.revoke("gmail",2,"2026-07-23T16:00:00Z");
    expect(registry.require("gmail","gmail.selected-message.read",2)).toMatchObject({code:"AUTH_REQUIRED"});
    expect(registry.require("google-calendar","calendar.read",1)).toBeNull();
    registry.reconnect(manifest("gmail",["gmail.selected-message.read"],"gmail-addon",3));expect(registry.require("gmail","gmail.selected-message.read",3)).toBeNull();
    expect(new ConnectorRegistry([manifest("google-calendar",["calendar.read"],"oauth",1,"stale")]).require("google-calendar","calendar.read",1)).toMatchObject({code:"STALE_SOURCE"});
  });
});

describe("bounded connector reads",()=>{
  it("retries one 429/5xx inside budget and classifies terminal status",async()=>{
    const timer=clock();let calls=0;
    await expect(executeBoundedRead("google-calendar",timer,async()=>++calls===1?{status:429,retryAfterSeconds:1}:{status:200,value:"ok"})).resolves.toBe("ok");
    expect(calls).toBe(2);expect(timer.now()).toBe(1_000);
    calls=0;await expect(executeBoundedRead("google-calendar",clock(),async()=>{calls+=1;return{status:503};})).resolves.toMatchObject({code:"PROVIDER_UNAVAILABLE"});expect(calls).toBe(2);
    calls=0;await expect(executeBoundedRead("google-calendar",clock(),async()=>{calls+=1;return{status:401};})).resolves.toMatchObject({code:"AUTH_REQUIRED"});expect(calls).toBe(1);
  });

  it("aborts a transport that never resolves",async()=>{
    let aborted=false;const timer:ReadClock={now:()=>0,sleep:async()=>undefined,withTimeout:async(_operation,_milliseconds,onTimeout)=>{onTimeout();throw new Error("timeout");}};
    const result=await executeBoundedRead("google-calendar",timer,async(_attempt,signal)=>{signal.addEventListener("abort",()=>{aborted=true;});return new Promise(()=>undefined);});
    expect(result).toMatchObject({code:"PROVIDER_UNAVAILABLE",retriable:true});expect(aborted).toBe(true);
  });
});

describe("connector revocation",()=>{
  const removed=(changes:Partial<LocalSourceRevocationReceipt["removed"]>={})=>({tasks:0,intents:0,commitments:0,observations:0,proposals:0,evidence:0,patterns:0,derived:0,effects:0,connectors:1,receipts:0,...changes});
  const receipt=(source:"google-calendar"|"github",consentRevision:number,changes:Partial<LocalSourceRevocationReceipt["removed"]>={}):LocalSourceRevocationReceipt=>({schemaVersion:1,source,consentRevision,revokedAt:"2026-07-23T16:00:00Z",localTokenDeleted:true,removed:removed(changes)});
  const envelope={schemaVersion:1 as const,keyId:"a".repeat(24),algorithm:"AES-256-GCM" as const,nonce:"AA==",ciphertext:"AA==",authTag:"AA==",createdAt:now};

  it("commits one atomic source-isolated local erasure before bounded remote revocation",async()=>{
    const events:string[]=[],state={sources:new Set(["google-calendar","github"]),tasks:new Set(["google-calendar:task","github:task"]),effects:new Set(["google-calendar:effect","github:effect"]),tokens:new Set(["google-calendar","github"])};
    const local:AtomicLocalRevocationPort={loadAuthorization:async(source)=>{events.push("load");return state.tokens.has(source)?envelope:null;},revoke:async({source,consentRevision})=>{events.push("atomic-local");const next={sources:new Set(state.sources),tasks:new Set(state.tasks),effects:new Set(state.effects),tokens:new Set(state.tokens)};next.sources.delete(source);next.tasks.delete(`${source}:task`);next.effects.delete(`${source}:effect`);next.tokens.delete(source);Object.assign(state,next);return receipt(source as "google-calendar",consentRevision,{tasks:1,effects:1});}};
    const service=new ConnectorPrivacyService(local,{revoke:async(_source,authorization,timeout,signal)=>{events.push("remote");expect(authorization).toBe(envelope);expect(timeout).toBe(10_000);expect(signal.aborted).toBe(false);return"confirmed";}},()=>"2026-07-23T16:00:00Z");
    const result=await service.revoke("google-calendar",2);expect(events).toEqual(["load","atomic-local","remote"]);expect(result).toMatchObject({localTokenDeleted:true,removed:{tasks:1,effects:1},remoteRevocation:"confirmed"});expect([...state.sources]).toEqual(["github"]);expect([...state.tasks]).toEqual(["github:task"]);expect([...state.effects]).toEqual(["github:effect"]);expect([...state.tokens]).toEqual(["github"]);expect(JSON.stringify(result)).not.toContain("ciphertext");
  });

  it("does not call remote or overclaim success when the atomic local commit fails",async()=>{
    let remoteCalls=0;const before={source:"github",token:true,tasks:2};const local:AtomicLocalRevocationPort={loadAuthorization:async()=>envelope,revoke:async()=>{throw new Error("atomic commit failed");}};
    const service=new ConnectorPrivacyService(local,{revoke:async()=>{remoteCalls+=1;return"confirmed";}},()=>"2026-07-23T16:00:00Z");await expect(service.revoke("github",2)).rejects.toThrow("atomic commit failed");expect(remoteCalls).toBe(0);expect(before).toEqual({source:"github",token:true,tasks:2});
  });

  it("reports missing authorization truthfully and aborts one never-resolving remote follow-up",async()=>{
    let remoteCalls=0,signal:AbortSignal|undefined;const timeout=async<T>(_operation:Promise<T>,milliseconds:number,onTimeout:()=>void):Promise<T>=>{expect(milliseconds).toBe(10_000);onTimeout();throw new Error("timeout");};
    const local=(authorization:typeof envelope|null):AtomicLocalRevocationPort=>({loadAuthorization:async()=>authorization,revoke:async({source,consentRevision})=>receipt(source as "google-calendar",consentRevision)});
    await expect(new ConnectorPrivacyService(local(null),{revoke:async()=>{remoteCalls+=1;return"confirmed";}},()=>"2026-07-23T16:00:00Z").revoke("google-calendar",2)).resolves.toMatchObject({remoteRevocation:"not-attempted"});expect(remoteCalls).toBe(0);
    const service=new ConnectorPrivacyService(local(envelope),{revoke:async(_source,_authorization,_timeout,inputSignal)=>{remoteCalls+=1;signal=inputSignal;return new Promise<never>(()=>undefined);}},()=>"2026-07-23T16:00:00Z",timeout);await expect(service.revoke("google-calendar",2)).resolves.toMatchObject({remoteRevocation:"failed"});expect(remoteCalls).toBe(1);expect(signal?.aborted).toBe(true);
  });
});
