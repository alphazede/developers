import { describe, expect, it } from "vitest";

import { GET as disabledCallback, createGoogleOAuthCallbackHandler } from "../../../src/app/api/v1/oauth/google/callback/route";
import { POST as disabledStart, createGoogleOAuthStartHandler } from "../../../src/app/api/v1/oauth/google/start/route";
import { POST as disabledSync, createGoogleSyncHandler } from "../../../src/app/api/v1/sources/google/sync/route";
import { POST as disabledRevoke, createGoogleRevokeHandler } from "../../../src/app/api/v1/sources/google/revoke/route";
import type { GoogleOAuthService } from "../../../src/server/oauth";
import type { GoogleCalendarAdapter } from "../../../src/adapters/google";
import type { ConnectorPrivacyService } from "../../../src/application/connectors";

const body=async(response:Response)=>JSON.stringify(await response.json());
describe("Google route boundaries",()=>{
  it("remain safely disabled without assembled local configuration",async()=>{
    for(const response of [await disabledStart(new Request("http://local")),await disabledCallback(new Request("http://local")),await disabledSync(new Request("http://local")),await disabledRevoke(new Request("http://local"))]){expect(response.status).toBe(503);expect(await body(response)).not.toMatch(/secret|token|verifier|ciphertext/i);}
  });

  it("injects OAuth services while keeping session binding server-side",async()=>{
    let begins=0,consumes=0;
    const service={begin:(input:unknown)=>{begins+=1;expect(input).toMatchObject({sessionId:"server-session"});return{schemaVersion:1,authorizationUrl:"https://accounts.google.com/o/oauth2/v2/auth?safe=1",state:"state",expiresAt:"2026-07-23T15:10:00Z"};},consume:async(input:unknown)=>{consumes+=1;expect(input).toMatchObject({sessionId:"server-session"});return{schemaVersion:1,source:"google-calendar",capabilities:["calendar.read"],consentRevision:1,returnPath:"/today",connectedAt:"2026-07-23T15:00:00Z"};}} as unknown as GoogleOAuthService;
    const start=createGoogleOAuthStartHandler(service,()=>"server-session"),request=new Request("http://127.0.0.1:3000/api/v1/oauth/google/start",{method:"POST",body:JSON.stringify({redirectUri:"http://127.0.0.1:3000/api/v1/oauth/google/callback",returnPath:"/today",consentRevision:1,calendarWrite:false})});
    expect((await start(request)).status).toBe(200);expect(begins).toBe(1);
    expect((await start(new Request("http://127.0.0.1:3000/api/v1/oauth/google/start",{method:"POST",body:`{"padding":"${"x".repeat(4_096)}"}`}))).status).toBe(413);expect(begins).toBe(1);
    expect((await createGoogleOAuthStartHandler(service,()=>null)(new Request("http://127.0.0.1:3000/api/v1/oauth/google/start",{method:"POST",body:JSON.stringify({redirectUri:"http://127.0.0.1:3000/api/v1/oauth/google/callback",returnPath:"/today",consentRevision:1,calendarWrite:false})}))).status).toBe(400);expect(begins).toBe(1);
    const callback=createGoogleOAuthCallbackHandler(service,()=>"server-session","http://127.0.0.1:3000/api/v1/oauth/google/callback"),response=await callback(new Request("http://127.0.0.1:3000/api/v1/oauth/google/callback?state=s&code=c"));
    expect(response.status).toBe(200);expect(consumes).toBe(1);expect(await body(response)).not.toMatch(/token|secret|verifier/i);
    expect((await callback(new Request("http://127.0.0.1:3000/api/v1/oauth/google/callback?state=s&state=duplicate&code=c"))).status).toBe(400);
    expect((await callback(new Request("http://127.0.0.1:3000/api/v1/oauth/google/callback?state=s&code=c&token=hostile"))).status).toBe(400);expect(consumes).toBe(1);
  });

  it("strictly shapes sync and revoke requests",async()=>{
    let syncs=0,revokes=0;
    const sync=createGoogleSyncHandler({sync:async()=>{syncs+=1;return{ok:true,commitments:[],freshness:{schemaVersion:1,fetchedAt:"2026-07-23T15:00:00Z",sourceUpdatedAt:null,expiresAt:null,state:"fresh"}};}} as unknown as GoogleCalendarAdapter,()=>true);
    expect((await sync(new Request("http://local/sync",{method:"POST",body:JSON.stringify({consentRevision:1,fetchedAt:"2026-07-23T15:00:00Z"})}))).status).toBe(200);
    expect((await sync(new Request("http://local/sync",{method:"POST",body:JSON.stringify({consentRevision:1,fetchedAt:"2026-07-23T15:00:00Z",token:"private"})}))).status).toBe(400);expect(syncs).toBe(1);
    expect((await sync(new Request("http://local/sync",{method:"POST",headers:{"content-length":"4097"},body:"{}"}))).status).toBe(413);
    expect((await sync(new Request("http://local/sync",{method:"POST",body:`{"padding":"${"é".repeat(4_096)}"}`}))).status).toBe(413);
    expect((await sync(new Request("http://local/sync",{method:"POST",body:'{"consentRevision":1,"consentRevision":2,"fetchedAt":"2026-07-23T15:00:00Z"}'}))).status).toBe(400);expect(syncs).toBe(1);
    const revoke=createGoogleRevokeHandler({revoke:async()=>{revokes+=1;return{schemaVersion:1,source:"google-calendar",consentRevision:2,revokedAt:"2026-07-23T15:00:00Z",localTokenDeleted:true,removed:{tasks:0,intents:0,commitments:2,observations:0,proposals:1,evidence:1,patterns:1,derived:1,effects:1,connectors:1,receipts:1},remoteRevocation:"failed"};}} as unknown as ConnectorPrivacyService,()=>true);
    const response=await revoke(new Request("http://local/revoke",{method:"POST",body:JSON.stringify({source:"google-calendar",consentRevision:2})}));expect(response.status).toBe(200);expect(revokes).toBe(1);expect(await body(response)).not.toMatch(/access-private|refresh-private|envelope|ciphertext/i);
    expect((await revoke(new Request("http://local/revoke",{method:"POST",headers:{"content-length":"hostile"},body:"{}"}))).status).toBe(400);
    expect((await revoke(new Request("http://local/revoke",{method:"POST",body:'{"source":"google-calendar","source":"gmail","consentRevision":2}'}))).status).toBe(400);expect(revokes).toBe(1);
    expect((await createGoogleSyncHandler({sync:async()=>{syncs+=1;return{ok:true,commitments:[],freshness:{}} as never;}} as unknown as GoogleCalendarAdapter,()=>false)(new Request("http://local/sync",{method:"POST"}))).status).toBe(401);expect(syncs).toBe(1);
  });
});
