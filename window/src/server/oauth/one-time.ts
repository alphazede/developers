import { createHash, randomBytes } from "node:crypto";

import type { ConnectorCapability, ConnectorCommand, ConnectorSource, TokenRepository } from "../../application/connectors";
import { encryptToken, type DataKeyManager } from "../security/crypto";

export type OneTimeOAuthProvider="google-calendar"|"linear";
export type OneTimeOAuthAccess="read"|"read-write";
const GOOGLE_AUTHORIZATION_ENDPOINT="https://accounts.google.com/o/oauth2/v2/auth",GOOGLE_TOKEN_ENDPOINT="https://oauth2.googleapis.com/token",LINEAR_AUTHORIZATION_ENDPOINT="https://linear.app/oauth/authorize",LINEAR_TOKEN_ENDPOINT="https://api.linear.app/oauth/token";
type AuthorizationEndpoint=typeof GOOGLE_AUTHORIZATION_ENDPOINT|typeof LINEAR_AUTHORIZATION_ENDPOINT;
type TokenEndpoint=typeof GOOGLE_TOKEN_ENDPOINT|typeof LINEAR_TOKEN_ENDPOINT;
type Definition=Readonly<{authorizationEndpoint:AuthorizationEndpoint;tokenEndpoint:TokenEndpoint;redirectPath:string;variants:Readonly<Record<OneTimeOAuthAccess,Readonly<{scopes:readonly string[];capabilities:readonly ConnectorCapability[]}>|null>>}>;
export const GOOGLE_CALENDAR_READ_SCOPE="https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_CALENDAR_WRITE_SCOPE="https://www.googleapis.com/auth/calendar.events";
export const LINEAR_READ_SCOPE="read";
const DEFINITIONS:Readonly<Record<OneTimeOAuthProvider,Definition>>=Object.freeze({
  "google-calendar":{authorizationEndpoint:GOOGLE_AUTHORIZATION_ENDPOINT,tokenEndpoint:GOOGLE_TOKEN_ENDPOINT,redirectPath:"/api/v1/oauth/google/callback",variants:{read:{scopes:[GOOGLE_CALENDAR_READ_SCOPE],capabilities:["calendar.read"]},"read-write":{scopes:[GOOGLE_CALENDAR_READ_SCOPE,GOOGLE_CALENDAR_WRITE_SCOPE],capabilities:["calendar.read","calendar.event.write"]}}},
  linear:{authorizationEndpoint:LINEAR_AUTHORIZATION_ENDPOINT,tokenEndpoint:LINEAR_TOKEN_ENDPOINT,redirectPath:"/api/v1/oauth/linear/callback",variants:{read:{scopes:[LINEAR_READ_SCOPE],capabilities:["task.connect","task.read","task.sync","task.revoke"]},"read-write":null}},
});
const exact=(value:object,keys:readonly string[])=>Object.keys(value).sort().join()===[...keys].sort().join();
const bounded=(value:unknown,max:number):value is string=>typeof value==="string"&&value.length>0&&value===value.trim()&&Buffer.byteLength(value)<=max;
const safeRevision=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const base64url=(value:Uint8Array)=>Buffer.from(value).toString("base64url");
const digest=(value:string)=>createHash("sha256").update(value).digest();
const validReturnPath=(value:unknown):value is string=>bounded(value,200)&&value.startsWith("/")&&!value.startsWith("//")&&!value.includes("\\")&&!value.includes("\0");
type Timeout=<T>(operation:Promise<T>,milliseconds:number,onTimeout:()=>void)=>Promise<T>;
const systemTimeout:Timeout=async<T>(operation:Promise<T>,milliseconds:number,onTimeout:()=>void)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<T>((_,reject)=>{timer=setTimeout(()=>{onTimeout();reject(new Error("OAUTH_TIMEOUT"));},milliseconds);})]);}finally{if(timer!==undefined)clearTimeout(timer);}};

export class OAuthBoundaryError extends Error{constructor(readonly code:"OAUTH_DISABLED"|"OAUTH_INVALID"|"OAUTH_EXPIRED"|"OAUTH_REPLAY"|"OAUTH_EXCHANGE_FAILED"){super(code);this.name="OAuthBoundaryError";}}
export type OneTimeOAuthConfiguration=Readonly<{provider:OneTimeOAuthProvider;clientId:string;clientSecret:string;redirectUri:string;authorizationEndpoint:AuthorizationEndpoint;tokenEndpoint:TokenEndpoint}>;
export type OneTimeOAuthExchangePort=Readonly<{exchange(input:Readonly<{provider:OneTimeOAuthProvider;endpoint:TokenEndpoint;code:string;verifier:string;redirectUri:string;clientId:string;clientSecret:string;signal:AbortSignal}>):Promise<unknown>}>;
type Pending=Readonly<{sessionHash:string;redirectUri:string;returnPath:string;verifier:string;expiresAt:number;consentRevision:number;access:OneTimeOAuthAccess;command:ConnectorCommand|null}>;
type BeginInput=Readonly<{sessionId:string;redirectUri:string;returnPath:string;consentRevision:number;access:OneTimeOAuthAccess;expectedRevision?:number;commandId?:string;idempotencyKey?:string}>;
const commandFrom=(input:BeginInput):ConnectorCommand|null=>{
  const present=[input.expectedRevision,input.commandId,input.idempotencyKey].filter((value)=>value!==undefined).length;if(present===0)return null;
  if(present!==3||!safeRevision(input.expectedRevision)||!bounded(input.commandId,128)||!bounded(input.idempotencyKey,128))throw new OAuthBoundaryError("OAUTH_INVALID");
  return Object.freeze({expectedRevision:input.expectedRevision,commandId:input.commandId,idempotencyKey:input.idempotencyKey});
};

const validConfiguration=(config:OneTimeOAuthConfiguration)=>{const definition=DEFINITIONS[config.provider];return !!definition&&bounded(config.clientId,512)&&bounded(config.clientSecret,512)&&config.authorizationEndpoint===definition.authorizationEndpoint&&config.tokenEndpoint===definition.tokenEndpoint&&config.redirectUri===`http://127.0.0.1:3000${definition.redirectPath}`;};
export const oneTimeOAuthConfiguration=(provider:OneTimeOAuthProvider,environment:Record<string,string|undefined>):OneTimeOAuthConfiguration|null=>{
  const definition=DEFINITIONS[provider],prefix=provider==="google-calendar"?"GOOGLE":"LINEAR",clientId=environment[`${prefix}_CLIENT_ID`],clientSecret=environment[`${prefix}_CLIENT_SECRET`],redirectUri=environment[`${prefix}_REDIRECT_URI`];
  if(environment.APP_ORIGIN!=="http://127.0.0.1:3000"||!bounded(clientId,512)||!bounded(clientSecret,512)||redirectUri!==`${environment.APP_ORIGIN}${definition.redirectPath}`)return null;
  return Object.freeze({provider,clientId,clientSecret,redirectUri,authorizationEndpoint:definition.authorizationEndpoint,tokenEndpoint:definition.tokenEndpoint});
};

export class OneTimeOAuthService{
  private readonly pending=new Map<string,Pending>();private readonly definition:Definition;
  constructor(private readonly config:OneTimeOAuthConfiguration,private readonly exchange:OneTimeOAuthExchangePort,private readonly keys:Pick<DataKeyManager,"load">,private readonly tokens:TokenRepository,private readonly clock:Readonly<{now():number}>,private readonly entropy:(bytes:number)=>Uint8Array=(bytes)=>randomBytes(bytes),private readonly withTimeout:Timeout=systemTimeout){
    if(!validConfiguration(config))throw new OAuthBoundaryError("OAUTH_DISABLED");this.definition=DEFINITIONS[config.provider];
  }
  begin(input:BeginInput){
    for(const [state,value] of this.pending)if(this.clock.now()>value.expiresAt)this.pending.delete(state);
    if(!input)throw new OAuthBoundaryError("OAUTH_INVALID");const variant=this.definition.variants[input.access],keys=Object.keys(input),shape=exact(input,["sessionId","redirectUri","returnPath","consentRevision","access"])||exact(input,["sessionId","redirectUri","returnPath","consentRevision","access","expectedRevision","commandId","idempotencyKey"]);if(!shape||!variant||keys.length<5||!bounded(input.sessionId,512)||input.redirectUri!==this.config.redirectUri||!validReturnPath(input.returnPath)||!safeRevision(input.consentRevision)||this.pending.size>=100)throw new OAuthBoundaryError("OAUTH_INVALID");
    const command=commandFrom(input);
    const state=base64url(this.entropy(32)),verifier=base64url(this.entropy(32));if(state.length!==43||verifier.length!==43||this.pending.has(state))throw new OAuthBoundaryError("OAUTH_INVALID");
    const expiresAt=this.clock.now()+600_000;this.pending.set(state,Object.freeze({sessionHash:base64url(digest(input.sessionId)),redirectUri:input.redirectUri,returnPath:input.returnPath,verifier,expiresAt,consentRevision:input.consentRevision,access:input.access,command}));
    const query=new URLSearchParams({client_id:this.config.clientId,redirect_uri:this.config.redirectUri,response_type:"code",scope:variant.scopes.join(" "),state,code_challenge:base64url(digest(verifier)),code_challenge_method:"S256"});if(this.config.provider==="google-calendar"){query.set("access_type","offline");query.set("prompt","consent");}
    return Object.freeze({schemaVersion:1 as const,authorizationUrl:`${this.config.authorizationEndpoint}?${query}`,state,expiresAt:new Date(expiresAt).toISOString()});
  }
  async consume(input:Readonly<{state:string;code:string;sessionId:string;redirectUri:string}>){
    if(!input||!exact(input,["state","code","sessionId","redirectUri"])||!bounded(input.state,100)||!bounded(input.code,2_048)||!bounded(input.sessionId,512)||input.redirectUri!==this.config.redirectUri)throw new OAuthBoundaryError("OAUTH_INVALID");
    const pending=this.pending.get(input.state);if(!pending)throw new OAuthBoundaryError("OAUTH_REPLAY");this.pending.delete(input.state);
    if(this.clock.now()>pending.expiresAt)throw new OAuthBoundaryError("OAUTH_EXPIRED");if(pending.redirectUri!==input.redirectUri||pending.sessionHash!==base64url(digest(input.sessionId)))throw new OAuthBoundaryError("OAUTH_INVALID");
    const controller=new AbortController();let raw:unknown;try{raw=await this.withTimeout(this.exchange.exchange({provider:this.config.provider,endpoint:this.config.tokenEndpoint,code:input.code,verifier:pending.verifier,redirectUri:pending.redirectUri,clientId:this.config.clientId,clientSecret:this.config.clientSecret,signal:controller.signal}),10_000,()=>controller.abort());}catch{throw new OAuthBoundaryError("OAUTH_EXCHANGE_FAILED");}
    if(!raw||typeof raw!=="object"||Array.isArray(raw)||!exact(raw,["accessToken","refreshToken","expiresIn","scope"]))throw new OAuthBoundaryError("OAUTH_EXCHANGE_FAILED");
    const token=raw as Record<string,unknown>;if(!bounded(token.accessToken,8_192)||(token.refreshToken!==null&&!bounded(token.refreshToken,8_192))||!Number.isSafeInteger(token.expiresIn)||Number(token.expiresIn)<=0||Number(token.expiresIn)>86_400||!bounded(token.scope,2_048))throw new OAuthBoundaryError("OAUTH_EXCHANGE_FAILED");
    const variant=this.definition.variants[pending.access]!;const granted=[...new Set(token.scope.split(" ").filter(Boolean))].sort(),expected=[...variant.scopes].sort();if(JSON.stringify(granted)!==JSON.stringify(expected))throw new OAuthBoundaryError("OAUTH_EXCHANGE_FAILED");
    const now=new Date(this.clock.now()).toISOString(),key=await this.keys.load();await this.tokens.save(this.config.provider as ConnectorSource,encryptToken(JSON.stringify({accessToken:token.accessToken,refreshToken:token.refreshToken,expiresIn:token.expiresIn,scope:expected}),{...key,createdAt:now}),pending.command?{...pending.command,consentRevision:pending.consentRevision,capabilities:variant.capabilities,connectedAt:now}:undefined);
    return Object.freeze({schemaVersion:1 as const,source:this.config.provider,capabilities:Object.freeze([...variant.capabilities]),consentRevision:pending.consentRevision,returnPath:pending.returnPath,connectedAt:now});
  }
}
