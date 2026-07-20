import { describe, expect, it } from "vitest";

import { decryptToken, identifyDataKey } from "../../../src/server/security/crypto";
import { GMAIL_ADDON_SELECTED_SCOPE, GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE, GoogleOAuthService, googleOAuthConfiguration } from "../../../src/server/oauth";

const redirect="http://127.0.0.1:3000/api/v1/oauth/google/callback";
const config={clientId:"client-id",clientSecret:"server-secret",redirectUri:redirect};
const setup=(now=1_753_283_600_000,scope=`${GOOGLE_CALENDAR_READ_SCOPE} ${GOOGLE_CALENDAR_WRITE_SCOPE}`)=>{
  let calls=0,exchangeInput:unknown,saved:unknown,current=now;const key=identifyDataKey(Buffer.alloc(32,7));
  const service=new GoogleOAuthService(config,{exchange:async(input)=>{calls+=1;exchangeInput=input;return{accessToken:"access-private",refreshToken:"refresh-private",expiresIn:3600,scope};}},{load:async()=>key},{load:async()=>null,save:async(_source,envelope)=>{saved=envelope;},delete:async()=>false},{now:()=>current},(bytes)=>Buffer.alloc(bytes,++calls));
  return{service,key,getCalls:()=>calls,getExchange:()=>exchangeInput,getSaved:()=>saved,setNow:(value:number)=>{current=value;}};
};

describe("GoogleOAuthService",()=>{
  it("requires exact local configuration and never selects a broad Gmail scope",()=>{
    expect(googleOAuthConfiguration({APP_ORIGIN:"http://127.0.0.1:3000",GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",GOOGLE_REDIRECT_URI:redirect})).toEqual({clientId:"id",clientSecret:"secret",redirectUri:redirect});
    expect(googleOAuthConfiguration({APP_ORIGIN:"http://localhost:3000",GOOGLE_CLIENT_ID:"id",GOOGLE_CLIENT_SECRET:"secret",GOOGLE_REDIRECT_URI:redirect})).toBeNull();
    const {service}=setup(),started=service.begin({sessionId:"session-a",redirectUri:redirect,returnPath:"/settings/sources",consentRevision:1,calendarWrite:true});
    expect(started.authorizationUrl).toContain(encodeURIComponent(GOOGLE_CALENDAR_READ_SCOPE));expect(started.authorizationUrl).toContain(encodeURIComponent(GOOGLE_CALENDAR_WRITE_SCOPE));
    expect(started.authorizationUrl).not.toContain("gmail.readonly");expect(started.authorizationUrl).not.toContain(encodeURIComponent(GMAIL_ADDON_SELECTED_SCOPE));expect(started.authorizationUrl).not.toContain("server-secret");
  });

  it("binds state, PKCE, session, redirect, TTL, and single consume",async()=>{
    const fixture=setup(),started=fixture.service.begin({sessionId:"session-a",redirectUri:redirect,returnPath:"/today",consentRevision:2,calendarWrite:true});
    const receipt=await fixture.service.consume({state:started.state,code:"one-time-code",sessionId:"session-a",redirectUri:redirect});
    expect(receipt).toMatchObject({source:"google-calendar",capabilities:["calendar.read","calendar.event.write"],consentRevision:2,returnPath:"/today"});
    expect(JSON.stringify(receipt)).not.toMatch(/access-private|refresh-private|server-secret|verifier/);
    const exchange=fixture.getExchange() as {verifier:string;clientSecret:string};expect(exchange.verifier).toHaveLength(43);expect(exchange.clientSecret).toBe("server-secret");
    const envelope=fixture.getSaved() as Parameters<typeof decryptToken>[0],plaintext=decryptToken(envelope,fixture.key.key);expect(plaintext).toContain("refresh-private");expect(JSON.stringify(envelope)).not.toContain("refresh-private");
    await expect(fixture.service.consume({state:started.state,code:"again",sessionId:"session-a",redirectUri:redirect})).rejects.toThrow("OAUTH_REPLAY");
  });

  it("consumes hostile state before failed session/scope exchange and never retries",async()=>{
    const fixture=setup(),started=fixture.service.begin({sessionId:"session-a",redirectUri:redirect,returnPath:"/today",consentRevision:1,calendarWrite:true});
    await expect(fixture.service.consume({state:started.state,code:"code",sessionId:"wrong",redirectUri:redirect})).rejects.toThrow("OAUTH_INVALID");
    await expect(fixture.service.consume({state:started.state,code:"code",sessionId:"session-a",redirectUri:redirect})).rejects.toThrow("OAUTH_REPLAY");
    const wrong=setup(1_753_283_600_000,`${GOOGLE_CALENDAR_READ_SCOPE} https://www.googleapis.com/auth/gmail.readonly`),other=wrong.service.begin({sessionId:"s",redirectUri:redirect,returnPath:"/",consentRevision:1,calendarWrite:false});
    await expect(wrong.service.consume({state:other.state,code:"code",sessionId:"s",redirectUri:redirect})).rejects.toThrow("OAUTH_EXCHANGE_FAILED");
    const expired=setup(),expiring=expired.service.begin({sessionId:"s",redirectUri:redirect,returnPath:"/",consentRevision:1,calendarWrite:true});expired.setNow(1_753_284_200_001);
    await expect(expired.service.consume({state:expiring.state,code:"code",sessionId:"s",redirectUri:redirect})).rejects.toThrow("OAUTH_EXPIRED");
  });

  it("aborts a never-resolving exchange at 10 seconds and consumes state without retry",async()=>{
    let exchanges=0,signal:AbortSignal|undefined,entropy=0;const key=identifyDataKey(Buffer.alloc(32,7));
    const service=new GoogleOAuthService(config,{exchange:async(input)=>{exchanges+=1;signal=input.signal;return new Promise<never>(()=>undefined);}},{load:async()=>key},{load:async()=>null,save:async()=>undefined,delete:async()=>false},{now:()=>1_753_283_600_000},(bytes)=>Buffer.alloc(bytes,++entropy),async<T>(_operation:Promise<T>,milliseconds:number,onTimeout:()=>void)=>{expect(milliseconds).toBe(10_000);onTimeout();throw new Error("timeout");});
    const started=service.begin({sessionId:"s",redirectUri:redirect,returnPath:"/today",consentRevision:1,calendarWrite:false});
    await expect(service.consume({state:started.state,code:"code",sessionId:"s",redirectUri:redirect})).rejects.toThrow("OAUTH_EXCHANGE_FAILED");expect(exchanges).toBe(1);expect(signal?.aborted).toBe(true);
    await expect(service.consume({state:started.state,code:"code",sessionId:"s",redirectUri:redirect})).rejects.toThrow("OAUTH_REPLAY");expect(exchanges).toBe(1);
  });
});
