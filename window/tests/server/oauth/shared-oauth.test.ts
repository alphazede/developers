import { describe, expect, it } from "vitest";

import { identifyDataKey } from "../../../src/server/security/crypto";
import { GitHubInstallationService, LINEAR_READ_SCOPE, OneTimeOAuthService, oneTimeOAuthConfiguration } from "../../../src/server/oauth";

const now=1_753_283_600_000,key=identifyDataKey(Buffer.alloc(32,4)),tokens=()=>({load:async()=>null,save:async()=>undefined,delete:async()=>false});

describe("shared one-time OAuth boundary",()=>{
  it("accepts only the exact Linear endpoint, redirect, read scope, and encrypted token source",async()=>{
    const config=oneTimeOAuthConfiguration("linear",{APP_ORIGIN:"http://127.0.0.1:3000",LINEAR_CLIENT_ID:"linear-id",LINEAR_CLIENT_SECRET:"linear-secret",LINEAR_REDIRECT_URI:"http://127.0.0.1:3000/api/v1/oauth/linear/callback"});expect(config).not.toBeNull();if(!config)return;
    let source="",saved="",exchangeInput:Record<string,unknown>|undefined,entropy=0;
    const service=new OneTimeOAuthService(config,{exchange:async(input)=>{exchangeInput=input as unknown as Record<string,unknown>;return{accessToken:"linear-private",refreshToken:null,expiresIn:3600,scope:LINEAR_READ_SCOPE};}},{load:async()=>key},{...tokens(),save:async(inputSource,envelope)=>{source=inputSource;saved=JSON.stringify(envelope);}},{now:()=>now},(bytes)=>Buffer.alloc(bytes,++entropy));
    const started=service.begin({sessionId:"session",redirectUri:config.redirectUri,returnPath:"/today",consentRevision:1,access:"read"});expect(started.authorizationUrl).toMatch(/^https:\/\/linear\.app\/oauth\/authorize\?/);expect(started.authorizationUrl).not.toMatch(/linear-secret|write/);
    const receipt=await service.consume({state:started.state,code:"code",sessionId:"session",redirectUri:config.redirectUri});expect(receipt).toMatchObject({source:"linear",capabilities:["task.connect","task.read","task.sync","task.revoke"]});expect(source).toBe("linear");expect(saved).not.toContain("linear-private");expect(exchangeInput).toMatchObject({provider:"linear",endpoint:"https://api.linear.app/oauth/token"});
    expect(()=>service.begin({sessionId:"session",redirectUri:config.redirectUri,returnPath:"/",consentRevision:2,access:"read-write"})).toThrow("OAUTH_INVALID");
    expect(()=>new OneTimeOAuthService({...config,tokenEndpoint:"https://hostile.example/token"} as never,{exchange:async()=>({})},{load:async()=>key},tokens(),{now:()=>now})).toThrow("OAUTH_DISABLED");
  });

  it("consumes state and aborts a never-resolving Linear exchange once",async()=>{
    const config=oneTimeOAuthConfiguration("linear",{APP_ORIGIN:"http://127.0.0.1:3000",LINEAR_CLIENT_ID:"id",LINEAR_CLIENT_SECRET:"secret",LINEAR_REDIRECT_URI:"http://127.0.0.1:3000/api/v1/oauth/linear/callback"})!;let calls=0,signal:AbortSignal|undefined,entropy=0;
    const service=new OneTimeOAuthService(config,{exchange:async(input)=>{calls+=1;signal=input.signal;return new Promise<never>(()=>undefined);}},{load:async()=>key},tokens(),{now:()=>now},(bytes)=>Buffer.alloc(bytes,++entropy),async<T>(_operation:Promise<T>,milliseconds:number,onTimeout:()=>void)=>{expect(milliseconds).toBe(10_000);onTimeout();throw new Error("timeout");});
    const started=service.begin({sessionId:"s",redirectUri:config.redirectUri,returnPath:"/",consentRevision:1,access:"read"});await expect(service.consume({state:started.state,code:"c",sessionId:"s",redirectUri:config.redirectUri})).rejects.toThrow("OAUTH_EXCHANGE_FAILED");expect(calls).toBe(1);expect(signal?.aborted).toBe(true);await expect(service.consume({state:started.state,code:"c",sessionId:"s",redirectUri:config.redirectUri})).rejects.toThrow("OAUTH_REPLAY");expect(calls).toBe(1);
  });
});

describe("GitHub installation exchange boundary",()=>{
  it("binds one-time state/session to a narrow installation exchange and redacts installation identity from receipt",async()=>{
    let calls=0,exchangeInput:Record<string,unknown>|undefined,saved="",entropy=0;
    const service=new GitHubInstallationService("capacity-scheduler","http://127.0.0.1:3000/api/v1/oauth/github/callback",{exchange:async(input)=>{calls+=1;exchangeInput=input as unknown as Record<string,unknown>;return{accessToken:"github-private",expiresAt:"2026-07-23T16:00:00Z"};}},{load:async()=>key},{...tokens(),save:async(_source,envelope)=>{saved=JSON.stringify(envelope);}},{now:()=>now},(bytes)=>Buffer.alloc(bytes,++entropy));
    const started=service.begin({sessionId:"s",consentRevision:1});expect(started.authorizationUrl).toMatch(/^https:\/\/github\.com\/apps\/capacity-scheduler\/installations\/new\?/);
    const receipt=await service.consume({state:started.state,sessionId:"s",redirectUri:"http://127.0.0.1:3000/api/v1/oauth/github/callback",installationId:42,setupAction:"install"});expect(calls).toBe(1);expect(exchangeInput).toMatchObject({endpoint:"github-app-installation-access-token",installationId:42});expect(receipt).toMatchObject({source:"github",capabilities:["task.connect","task.read","task.sync","task.revoke"]});expect(JSON.stringify(receipt)).not.toMatch(/42|github-private/);expect(saved).not.toContain("github-private");
    await expect(service.consume({state:started.state,sessionId:"s",redirectUri:"http://127.0.0.1:3000/api/v1/oauth/github/callback",installationId:42,setupAction:"install"})).rejects.toThrow("OAUTH_REPLAY");
  });
});
