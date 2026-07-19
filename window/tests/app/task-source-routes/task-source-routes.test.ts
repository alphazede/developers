import { describe, expect, it } from "vitest";

import { GET as disabledGitHubCallback, createGitHubOAuthCallbackHandler } from "../../../src/app/api/v1/oauth/github/callback/route";
import { POST as disabledGitHubStart, createGitHubOAuthStartHandler } from "../../../src/app/api/v1/oauth/github/start/route";
import { GET as disabledLinearCallback, createLinearOAuthCallbackHandler } from "../../../src/app/api/v1/oauth/linear/callback/route";
import { POST as disabledLinearStart, createLinearOAuthStartHandler } from "../../../src/app/api/v1/oauth/linear/start/route";
import { POST as disabledGitHubRevoke, createGitHubRevokeHandler } from "../../../src/app/api/v1/sources/github/revoke/route";
import { POST as disabledGitHubSync, createGitHubSyncHandler } from "../../../src/app/api/v1/sources/github/sync/route";
import { POST as disabledLinearRevoke, createLinearRevokeHandler } from "../../../src/app/api/v1/sources/linear/revoke/route";
import { POST as disabledLinearSync, createLinearSyncHandler } from "../../../src/app/api/v1/sources/linear/sync/route";
import type { GitHubTaskAdapter } from "../../../src/adapters/github";
import type { LinearTaskAdapter } from "../../../src/adapters/linear";
import type { ConnectorPrivacyService } from "../../../src/application/connectors";
import type { GitHubInstallationService, OneTimeOAuthService } from "../../../src/server/oauth";

const json=async(response:Response)=>JSON.stringify(await response.json());
const post=(path:string,value:string|object)=>new Request(`http://127.0.0.1:3000${path}`,{method:"POST",body:typeof value==="string"?value:JSON.stringify(value)});

describe("GitHub and Linear task-source routes",()=>{
  it("fails closed when provider composition is absent without exposing secrets",async()=>{
    const request=()=>new Request("http://local");for(const response of [await disabledGitHubStart(request()),await disabledGitHubCallback(request()),await disabledGitHubSync(request()),await disabledGitHubRevoke(request()),await disabledLinearStart(request()),await disabledLinearCallback(request()),await disabledLinearSync(request()),await disabledLinearRevoke(request())]){
      expect(response.status).toBe(503);expect(response.headers.get("cache-control")).toBe("private, no-store");expect(await json(response)).not.toMatch(/token|secret|verifier|ciphertext|installation.?id/i);
    }
  });

  it("binds exact GitHub installation route fields to the shared service and rejects escalation",async()=>{
    let begins=0,consumes=0;
    const service={
      begin:(input:unknown)=>{begins+=1;expect(input).toEqual({sessionId:"server-session",consentRevision:1});return{schemaVersion:1,authorizationUrl:"https://github.com/apps/capacity-scheduler/installations/new?safe=1",state:"state",expiresAt:"2026-07-23T15:10:00Z"};},
      consume:async(input:unknown)=>{consumes+=1;expect(input).toEqual({state:"s",sessionId:"server-session",redirectUri:"http://127.0.0.1:3000/api/v1/oauth/github/callback",installationId:9001,setupAction:"install"});return{schemaVersion:1,source:"github",capabilities:["task.connect","task.read","task.sync","task.revoke"],consentRevision:1,connectedAt:"2026-07-23T15:00:00Z"};},
    } as unknown as GitHubInstallationService;
    const start=createGitHubOAuthStartHandler(service,()=>"server-session"),started=await start(post("/api/v1/oauth/github/start",{consentRevision:1}));expect(started.status).toBe(200);expect(begins).toBe(1);
    expect((await start(post("/api/v1/oauth/github/start",`{"padding":"${"x".repeat(4_096)}"}`))).status).toBe(413);expect(begins).toBe(1);
    expect((await start(post("/api/v1/oauth/github/start",{consentRevision:1,scopes:["write"]}))).status).toBe(400);expect(begins).toBe(1);
    expect((await createGitHubOAuthStartHandler(service,()=>null)(post("/api/v1/oauth/github/start",{consentRevision:1}))).status).toBe(400);expect(begins).toBe(1);
    const callback=createGitHubOAuthCallbackHandler(service,()=>"server-session","http://127.0.0.1:3000/api/v1/oauth/github/callback"),response=await callback(new Request("http://127.0.0.1:3000/api/v1/oauth/github/callback?state=s&installation_id=9001&setup_action=install"));
    expect(response.status).toBe(200);expect(consumes).toBe(1);expect(await json(response)).not.toMatch(/token|secret|installation.?id/i);
    expect((await callback(new Request("http://127.0.0.1:3000/api/v1/oauth/github/callback?state=s&state=again&installation_id=9001&setup_action=install"))).status).toBe(400);
    expect((await callback(new Request("http://127.0.0.1:3000/api/v1/oauth/github/callback?state=s&installation_id=9001&setup_action=install&request=/graphql"))).status).toBe(400);expect(consumes).toBe(1);
  });

  it("forces Linear read access and exact callback fields through OneTimeOAuthService",async()=>{
    let begins=0,consumes=0;
    const service={
      begin:(input:unknown)=>{begins+=1;expect(input).toEqual({sessionId:"server-session",redirectUri:"http://127.0.0.1:3000/api/v1/oauth/linear/callback",returnPath:"/today",consentRevision:1,access:"read"});return{schemaVersion:1,authorizationUrl:"https://linear.app/oauth/authorize?safe=1",state:"state",expiresAt:"2026-07-23T15:10:00Z"};},
      consume:async(input:unknown)=>{consumes+=1;expect(input).toEqual({state:"s",code:"c",sessionId:"server-session",redirectUri:"http://127.0.0.1:3000/api/v1/oauth/linear/callback"});return{schemaVersion:1,source:"linear",capabilities:["task.connect","task.read","task.sync","task.revoke"],consentRevision:1,returnPath:"/today",connectedAt:"2026-07-23T15:00:00Z"};},
    } as unknown as OneTimeOAuthService;
    const start=createLinearOAuthStartHandler(service,()=>"server-session"),input={redirectUri:"http://127.0.0.1:3000/api/v1/oauth/linear/callback",returnPath:"/today",consentRevision:1};
    expect((await start(post("/api/v1/oauth/linear/start",input))).status).toBe(200);expect(begins).toBe(1);
    expect((await start(post("/api/v1/oauth/linear/start",{...input,access:"read-write"}))).status).toBe(400);expect(begins).toBe(1);
    const callback=createLinearOAuthCallbackHandler(service,()=>"server-session",input.redirectUri),response=await callback(new Request(`${input.redirectUri}?state=s&code=c`));expect(response.status).toBe(200);expect(consumes).toBe(1);expect(await json(response)).not.toMatch(/token|secret|verifier/i);
    expect((await callback(new Request(`${input.redirectUri}?state=s&code=c&code=again`))).status).toBe(400);expect((await callback(new Request(`${input.redirectUri}?state=s&code=c&scope=write`))).status).toBe(400);expect(consumes).toBe(1);
  });

  it("strictly shapes sync before adapter reads and accepts no mutation or generic request escape",async()=>{
    let githubSyncs=0,linearSyncs=0;
    const github={sync:async(input:unknown)=>{githubSyncs+=1;expect(input).toEqual({consentRevision:1,fetchedAt:"2026-07-23T15:00:00Z"});return{ok:true,tasks:[],freshness:{}};}} as unknown as GitHubTaskAdapter;
    const linear={sync:async(input:unknown)=>{linearSyncs+=1;expect(input).toEqual({consentRevision:1,fetchedAt:"2026-07-23T15:00:00Z",estimateRule:{minutesPerPoint:15,maximumPoints:32}});return{ok:true,tasks:[],freshness:{}};}} as unknown as LinearTaskAdapter;
    const gh=createGitHubSyncHandler(github,()=>true),ln=createLinearSyncHandler(linear,()=>true);
    expect((await gh(post("/api/v1/sources/github/sync",{consentRevision:1,fetchedAt:"2026-07-23T15:00:00Z"}))).status).toBe(200);expect(githubSyncs).toBe(1);
    for(const hostile of [{consentRevision:1,fetchedAt:"2026-07-23T15:00:00Z",action:"complete"},{consentRevision:1,fetchedAt:"2026-07-23T15:00:00Z",request:{method:"PATCH"}},'{"consentRevision":1,"consentRevision":2,"fetchedAt":"2026-07-23T15:00:00Z"}'])expect((await gh(post("/api/v1/sources/github/sync",hostile))).status).toBe(400);expect(githubSyncs).toBe(1);
    expect((await ln(post("/api/v1/sources/linear/sync",{consentRevision:1,fetchedAt:"2026-07-23T15:00:00Z",estimateRule:{minutesPerPoint:15,maximumPoints:32}}))).status).toBe(200);expect(linearSyncs).toBe(1);
    expect((await ln(post("/api/v1/sources/linear/sync",'{"consentRevision":1,"fetchedAt":"2026-07-23T15:00:00Z","estimateRule":{"minutesPerPoint":15,"minutesPerPoint":30,"maximumPoints":32}}'))).status).toBe(400);expect(linearSyncs).toBe(1);
    expect((await gh(post("/api/v1/sources/github/sync",`{"padding":"${"é".repeat(4_096)}"}`))).status).toBe(413);expect(githubSyncs).toBe(1);
    expect((await createGitHubSyncHandler(github,()=>false)(post("/api/v1/sources/github/sync",{consentRevision:1,fetchedAt:"2026-07-23T15:00:00Z"}))).status).toBe(401);expect(githubSyncs).toBe(1);
  });

  it("fixes revocation to the route source and returns source-isolated truthful receipts",async()=>{
    const calls:unknown[]=[],service={revoke:async(source:string,consentRevision:number)=>{calls.push([source,consentRevision]);return{schemaVersion:1,source,consentRevision,revokedAt:"2026-07-23T15:00:00Z",localTokenDeleted:true,removed:{tasks:source==="github"?3:2,intents:1,commitments:0,observations:0,proposals:1,evidence:1,patterns:1,derived:1,effects:1,connectors:1,receipts:1},remoteRevocation:"failed"};}} as unknown as ConnectorPrivacyService;
    const github=createGitHubRevokeHandler(service,()=>true),linear=createLinearRevokeHandler(service,()=>true);
    const gh=await github(post("/api/v1/sources/github/revoke",{consentRevision:2})),ln=await linear(post("/api/v1/sources/linear/revoke",{consentRevision:3}));expect(calls).toEqual([["github",2],["linear",3]]);expect(gh.status).toBe(200);expect(ln.status).toBe(200);
    expect(await json(gh)).toContain('"remoteRevocation":"failed"');expect(await json(ln)).not.toMatch(/ciphertext|access.?token|refresh.?token|bearer|secret/i);
    expect((await github(post("/api/v1/sources/github/revoke",{source:"linear",consentRevision:4}))).status).toBe(400);expect(calls).toHaveLength(2);
    expect((await linear(new Request("http://127.0.0.1:3000/api/v1/sources/linear/revoke",{method:"POST",headers:{"content-length":"4097"},body:"{}"}))).status).toBe(413);expect(calls).toHaveLength(2);
  });
});
