import { Temporal } from "@js-temporal/polyfill";

import type { FreshnessV1, TokenEnvelopeV1 } from "../../contracts/v1";
import type { PrivacyRemovedV1 } from "../privacy";

export const connectorErrorCodes = ["AUTH_REQUIRED", "SCOPE_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "MALFORMED_SOURCE", "OVERSIZED_SOURCE", "STALE_SOURCE", "UNSUPPORTED_CONTRACT"] as const;
export type ConnectorErrorCode = typeof connectorErrorCodes[number];
export type ConnectorSource = "google-calendar" | "gmail" | "github" | "linear" | "ics" | "microsoft" | "strava" | "oura";
export type ConnectorCapability = "calendar.read" | "calendar.event.write" | "gmail.selected-message.read" | "task.connect" | "task.read" | "task.sync" | "task.revoke" | "calendar.preview" | "calendar.import" | "calendar.export" | "calendar.fixture.read" | "activity.fixture.read" | "readiness.fixture.read";
export type ConnectorMode = "oauth"|"gmail-addon"|"github-app"|"import"|"fixture";
export type ConnectorManifest = Readonly<{ schemaVersion:1; source:ConnectorSource; capabilities:readonly ConnectorCapability[]; consentRevision:number; freshness:FreshnessV1; mode:ConnectorMode }>;
export type AdapterError = Readonly<{ schemaVersion:1; code:ConnectorErrorCode; source:ConnectorSource; retriable:boolean }>;
export type ConnectorCommand=Readonly<{expectedRevision:number;commandId:string;idempotencyKey:string}>;
export type TokenSaveContext=ConnectorCommand&Readonly<{consentRevision:number;capabilities:readonly ConnectorCapability[];connectedAt:string}>;
export type TokenRepository = Readonly<{load(source:ConnectorSource):Promise<TokenEnvelopeV1|null>;save(source:ConnectorSource,envelope:TokenEnvelopeV1,context?:TokenSaveContext):Promise<void>;delete(source:ConnectorSource):Promise<boolean>}>;
export type LocalSourceRevocationReceipt=Readonly<{schemaVersion:1;source:ConnectorSource;consentRevision:number;revokedAt:string;localTokenDeleted:boolean;removed:PrivacyRemovedV1}>;
export type AtomicLocalRevocationPort=Readonly<{loadAuthorization(source:ConnectorSource):Promise<TokenEnvelopeV1|null>;revoke(input:Readonly<{source:ConnectorSource;consentRevision:number;at:string;command?:ConnectorCommand}>):Promise<LocalSourceRevocationReceipt>}>;

const definitions:Record<ConnectorSource,Readonly<{mode:ConnectorMode;capabilities:readonly ConnectorCapability[]}>>={
  "google-calendar":{mode:"oauth",capabilities:["calendar.read","calendar.event.write"]},gmail:{mode:"gmail-addon",capabilities:["gmail.selected-message.read"]},
  github:{mode:"github-app",capabilities:["task.connect","task.read","task.sync","task.revoke"]},linear:{mode:"oauth",capabilities:["task.connect","task.read","task.sync","task.revoke"]},
  ics:{mode:"import",capabilities:["calendar.preview","calendar.import","calendar.export"]},microsoft:{mode:"fixture",capabilities:["calendar.fixture.read"]},
  strava:{mode:"fixture",capabilities:["activity.fixture.read"]},oura:{mode:"fixture",capabilities:["readiness.fixture.read"]},
};
const exact=(value:object,keys:readonly string[])=>Object.keys(value).sort().join()===[...keys].sort().join();
const canonicalInstant=(value:unknown):value is string=>{if(typeof value!=="string"||value.length>40||!value.endsWith("Z"))return false;try{return Temporal.Instant.from(value).toString()===value;}catch{return false;}};
const safeRevision=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const validFreshness=(value:unknown):value is FreshnessV1=>!!value&&typeof value==="object"&&!Array.isArray(value)&&exact(value,["schemaVersion","fetchedAt","sourceUpdatedAt","expiresAt","state"])
  &&(value as FreshnessV1).schemaVersion===1&&canonicalInstant((value as FreshnessV1).fetchedAt)&&((value as FreshnessV1).sourceUpdatedAt===null||canonicalInstant((value as FreshnessV1).sourceUpdatedAt))&&((value as FreshnessV1).expiresAt===null||canonicalInstant((value as FreshnessV1).expiresAt))&&["fresh","stale","revoked","fixture"].includes((value as FreshnessV1).state);
const validManifest=(value:unknown):value is ConnectorManifest=>{
  if(!value||typeof value!=="object"||Array.isArray(value)||!exact(value,["schemaVersion","source","capabilities","consentRevision","freshness","mode"]))return false;
  const item=value as ConnectorManifest,definition=definitions[item.source];if(item.schemaVersion!==1||!definition||!safeRevision(item.consentRevision)||!validFreshness(item.freshness)||item.mode!==definition.mode||!Array.isArray(item.capabilities)||new Set(item.capabilities).size!==item.capabilities.length||item.capabilities.some((capability)=>!definition.capabilities.includes(capability)))return false;
  if(item.source==="google-calendar")return item.capabilities[0]==="calendar.read"&&(item.capabilities.length===1||item.capabilities.length===2&&item.capabilities[1]==="calendar.event.write");
  return JSON.stringify(item.capabilities)===JSON.stringify(definition.capabilities);
};
const connectorError=(source:ConnectorSource,code:ConnectorErrorCode,retriable=false):AdapterError=>Object.freeze({schemaVersion:1,source,code,retriable});

export class ConnectorRegistry{
  private readonly manifests=new Map<ConnectorSource,ConnectorManifest>();
  constructor(initial:readonly ConnectorManifest[]=[]){for(const manifest of initial)this.register(manifest);}
  register(manifest:ConnectorManifest){if(!validManifest(manifest)||this.manifests.has(manifest.source))throw new RangeError("INVALID_CONNECTOR_MANIFEST");this.manifests.set(manifest.source,Object.freeze({...manifest,capabilities:Object.freeze([...manifest.capabilities]),freshness:Object.freeze({...manifest.freshness})}));}
  update(manifest:ConnectorManifest){const current=this.manifests.get(manifest.source);if(!current||!validManifest(manifest)||manifest.consentRevision<=current.consentRevision||manifest.capabilities.some((capability)=>!current.capabilities.includes(capability)))throw new RangeError("INVALID_CONNECTOR_UPDATE");this.manifests.set(manifest.source,Object.freeze({...manifest,capabilities:Object.freeze([...manifest.capabilities]),freshness:Object.freeze({...manifest.freshness})}));}
  reconsent(manifest:ConnectorManifest,confirmed:boolean){const current=this.manifests.get(manifest.source);if(confirmed!==true||!current||!validManifest(manifest)||manifest.consentRevision<=current.consentRevision)throw new RangeError("INVALID_CONNECTOR_RECONSENT");this.manifests.set(manifest.source,Object.freeze({...manifest,capabilities:Object.freeze([...manifest.capabilities]),freshness:Object.freeze({...manifest.freshness})}));}
  reconnect(manifest:ConnectorManifest){const current=this.manifests.get(manifest.source);if(!current||current.freshness.state!=="revoked")throw new RangeError("INVALID_CONNECTOR_RECONNECT");this.reconsent(manifest,true);}
  get(source:ConnectorSource){return this.manifests.get(source)??null;}
  require(source:ConnectorSource,capability:ConnectorCapability,consentRevision:number):AdapterError|null{const manifest=this.manifests.get(source);if(!manifest||manifest.freshness.state==="revoked")return connectorError(source,"AUTH_REQUIRED");if(manifest.freshness.state==="stale")return connectorError(source,"STALE_SOURCE");if(manifest.consentRevision!==consentRevision||!manifest.capabilities.includes(capability))return connectorError(source,"SCOPE_DENIED");return null;}
  revoke(source:ConnectorSource,consentRevision:number,at:string){const current=this.manifests.get(source);if(!current||!safeRevision(consentRevision)||consentRevision<=current.consentRevision||!canonicalInstant(at))throw new RangeError("INVALID_CONNECTOR_REVOCATION");this.manifests.set(source,Object.freeze({...current,capabilities:Object.freeze([]),consentRevision,freshness:Object.freeze({...current.freshness,fetchedAt:at,sourceUpdatedAt:null,expiresAt:null,state:"revoked" as const})}));}
  snapshot(){return Object.freeze([...this.manifests.values()].sort((a,b)=>a.source<b.source?-1:a.source>b.source?1:0));}
}

export type ReadClock=Readonly<{now():number;sleep(milliseconds:number):Promise<void>;withTimeout<T>(operation:Promise<T>,milliseconds:number,onTimeout:()=>void):Promise<T>}>;
export type ReadReply<T>=Readonly<{status:number;value?:T;retryAfterSeconds?:number}>;
export const systemReadClock:ReadClock={now:()=>Date.now(),sleep:(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds)),withTimeout:async<T>(operation:Promise<T>,milliseconds:number,onTimeout:()=>void)=>{
  let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<T>((_,reject)=>{timer=setTimeout(()=>{onTimeout();reject(new Error("READ_TIMEOUT"));},milliseconds);})]);}finally{if(timer!==undefined)clearTimeout(timer);}
}};
export const executeBoundedRead=async<T>(source:ConnectorSource,clock:ReadClock,transport:(attempt:number,signal:AbortSignal)=>Promise<ReadReply<T>>,totalBudgetMs=20_000):Promise<T|AdapterError>=>{
  if(!Number.isSafeInteger(totalBudgetMs)||totalBudgetMs<=0||totalBudgetMs>20_000)throw new RangeError("INVALID_READ_BUDGET");
  const started=clock.now();
  for(let attempt=0;attempt<2;attempt+=1){
    const remaining=totalBudgetMs-(clock.now()-started);if(remaining<=0)return connectorError(source,"PROVIDER_UNAVAILABLE",true);
    const controller=new AbortController();let reply:ReadReply<T>;try{reply=await clock.withTimeout(transport(attempt,controller.signal),remaining,()=>controller.abort());}catch{return connectorError(source,"PROVIDER_UNAVAILABLE",true);}
    if(!reply||typeof reply!=="object"||!Number.isInteger(reply.status))return connectorError(source,"MALFORMED_SOURCE");
    if(reply.status>=200&&reply.status<300&&"value" in reply)return reply.value as T;
    if(reply.status===401)return connectorError(source,"AUTH_REQUIRED");
    if(reply.status===403)return connectorError(source,"SCOPE_DENIED");
    const retryable=reply.status===429||reply.status>=500&&reply.status<=599;
    if(retryable&&attempt===0){
      const delay=reply.retryAfterSeconds===undefined?0:reply.retryAfterSeconds*1_000;
      if(!Number.isFinite(delay)||delay<0||delay>10_000||clock.now()-started+delay>=totalBudgetMs)return connectorError(source,reply.status===429?"RATE_LIMITED":"PROVIDER_UNAVAILABLE",true);
      await clock.sleep(delay);continue;
    }
    if(reply.status===429)return connectorError(source,"RATE_LIMITED",true);
    if(reply.status>=500&&reply.status<=599)return connectorError(source,"PROVIDER_UNAVAILABLE",true);
    return connectorError(source,"MALFORMED_SOURCE");
  }
  return connectorError(source,"PROVIDER_UNAVAILABLE",true);
};

export class ConnectorPrivacyService{
  constructor(private readonly local:AtomicLocalRevocationPort,private readonly remote:Readonly<{revoke(source:ConnectorSource,authorization:TokenEnvelopeV1,timeoutMs:10_000,signal:AbortSignal):Promise<"confirmed"|"failed">}>,private readonly now:()=>string,private readonly withTimeout:ReadClock["withTimeout"]=systemReadClock.withTimeout){}
  async revoke(source:ConnectorSource,consentRevision:number,command?:ConnectorCommand){
    const at=this.now();if(!definitions[source]||!safeRevision(consentRevision)||!canonicalInstant(at))throw new RangeError("INVALID_CONNECTOR_REVOCATION");
    let authorization:TokenEnvelopeV1|null=null;try{authorization=await this.local.loadAuthorization(source);}catch{authorization=null;}
    const receipt=await this.local.revoke({source,consentRevision,at,command});if(!validLocalRevocationReceipt(receipt,source,consentRevision,at))throw new RangeError("INVALID_LOCAL_REVOCATION_RECEIPT");
    let remoteRevocation:"confirmed"|"failed"|"not-attempted"="not-attempted";if(authorization){const controller=new AbortController();try{remoteRevocation=await this.withTimeout(this.remote.revoke(source,authorization,10_000,controller.signal),10_000,()=>controller.abort());}catch{remoteRevocation="failed";}}
    return Object.freeze({...receipt,remoteRevocation});
  }
}

const validLocalRevocationReceipt=(value:unknown,source:ConnectorSource,consentRevision:number,at:string):value is LocalSourceRevocationReceipt=>{
  if(!value||typeof value!=="object"||Array.isArray(value)||!exact(value,["schemaVersion","source","consentRevision","revokedAt","localTokenDeleted","removed"]))return false;
  const receipt=value as LocalSourceRevocationReceipt,removed=receipt.removed;if(receipt.schemaVersion!==1||receipt.source!==source||receipt.consentRevision!==consentRevision||receipt.revokedAt!==at||typeof receipt.localTokenDeleted!=="boolean"||!removed||typeof removed!=="object"||Array.isArray(removed)||!exact(removed,["tasks","intents","commitments","observations","proposals","evidence","patterns","derived","effects","connectors","receipts"]))return false;
  return Object.values(removed).every((count)=>typeof count==="number"&&Number.isSafeInteger(count)&&count>=0);
};
