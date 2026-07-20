import { createSign, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Temporal } from "@js-temporal/polyfill";

import { GitHubTaskAdapter } from "../../adapters/github";
import { GoogleCalendarAdapter, GoogleCalendarEffectAdapter, SelectedGmailAdapter, type SelectedMessageAction } from "../../adapters/google";
import { LinearTaskAdapter } from "../../adapters/linear";
import { MAX_PROVIDER_BYTES, boundedProviderText } from "../../adapters/shared";
import {
  ConnectorPrivacyService, ConnectorRegistry, systemReadClock, type AtomicLocalRevocationPort, type ConnectorCapability,
  type ConnectorCommand, type ConnectorManifest, type ConnectorSource, type ReadReply, type TokenRepository, type TokenSaveContext,
} from "../../application/connectors";
import { createEffectState, EffectRunner, type EffectIntent, type EffectState } from "../../application/effects";
import type { FreshnessV1, TokenEnvelopeV1 } from "../../contracts/v1";
import { localStateV1Schema } from "../../contracts/v1";
import { deriveMeetingPatternKey, DataKeyManager } from "../security/crypto";
import { SessionGuard } from "../security/session-guard";
import { GitHubInstallationService, GoogleOAuthService, OneTimeOAuthService, googleOAuthConfiguration, oneTimeOAuthConfiguration, type OneTimeOAuthExchangePort } from "../oauth";
import type { GitHubInstallationExchangePort } from "../oauth/github-installation";
import { LocalStore, type ConnectorRevocationReceipt } from "../../storage/local-store/local-store";

if (typeof window !== "undefined") throw new Error("SERVER_ONLY_CONNECTOR_RUNTIME");

const GOOGLE_EVENTS_ENDPOINT="https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_REVOKE_ENDPOINT="https://oauth2.googleapis.com/revoke";
const GITHUB_API_ORIGIN="https://api.github.com";
const LINEAR_GRAPHQL_ENDPOINT="https://api.linear.app/graphql";
const LOCAL_ORIGIN="http://127.0.0.1:3000";
const REPOSITORY=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const bounded=(value:unknown,max=512):value is string=>typeof value==="string"&&value.length>0&&value===value.trim()&&Buffer.byteLength(value)<=max;
const integer=(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const fromEnvironmentInteger=(value:string|undefined,min:number,max:number)=>value&&/^[0-9]+$/.test(value)&&integer(Number(value),min,max)?Number(value):null;
const jsonHeaders=(token:string)=>Object.freeze({accept:"application/json",authorization:`Bearer ${token}`});
type FetchLike=(input:string|URL,init?:RequestInit)=>Promise<Response>;

const boundedJson=async(response:Response):Promise<unknown>=>{
  const length=response.headers.get("content-length");if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_PROVIDER_BYTES))throw new Error("OVERSIZED_PROVIDER_RESPONSE");
  const reader=response.body?.getReader();if(!reader)return null;const chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const{done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_PROVIDER_BYTES){await reader.cancel();throw new Error("OVERSIZED_PROVIDER_RESPONSE");}chunks.push(value);}}finally{reader.releaseLock();}
  if(length!==null&&Number(length)!==total)throw new Error("PROVIDER_CONTENT_LENGTH_MISMATCH");
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
};

const tokenPayload=async(keys:DataKeyManager,envelope:TokenEnvelopeV1)=>{
  const value:unknown=JSON.parse(await keys.decrypt(envelope));if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("TOKEN_DECRYPT_FAILED");return value as Record<string,unknown>;
};

export class LocalStoreConnectorRepository implements TokenRepository{
  constructor(private readonly store:LocalStore){}
  load(source:ConnectorSource){return this.store.loadConnectorToken(source);}
  async save(source:ConnectorSource,envelope:TokenEnvelopeV1,context?:TokenSaveContext){if(!context)throw new Error("ATOMIC_CONNECT_CONTEXT_REQUIRED");await this.store.commitConnectorToken({source,envelope,...context});}
  async delete():Promise<boolean>{throw new Error("ATOMIC_REVOCATION_REQUIRED");}
}

export class LocalStoreAtomicRevocationPort implements AtomicLocalRevocationPort{
  constructor(private readonly store:LocalStore){}
  loadAuthorization(source:ConnectorSource){return this.store.loadConnectorToken(source);}
  async revoke(input:Readonly<{source:ConnectorSource;consentRevision:number;at:string;command?:ConnectorCommand}>):Promise<ConnectorRevocationReceipt>{if(!input.command)throw new Error("ATOMIC_REVOCATION_COMMAND_REQUIRED");return this.store.revokeConnectorSource({...input,...input.command});}
}

type LocalConfig=Readonly<{origin:typeof LOCAL_ORIGIN;session:string;csrf:string;statePath:string;keyPath:string}>;
type GitHubConfig=Readonly<{slug:string;appId:number;privateKey:string;redirectUri:string;repositories:readonly string[]}>;
export type LiveConnectorConfiguration=Readonly<{local:LocalConfig;google:ReturnType<typeof googleOAuthConfiguration>;linear:ReturnType<typeof oneTimeOAuthConfiguration>;github:GitHubConfig|null;gmailAddon:boolean}>;

export const liveConnectorConfiguration=(environment:Record<string,string|undefined>):LiveConnectorConfiguration|null=>{
  if(environment.CONNECTORS_ENABLED!=="1"||environment.APP_ORIGIN!==LOCAL_ORIGIN||!bounded(environment.APP_SESSION_SECRET,512)||!bounded(environment.APP_CSRF_SECRET,512)||environment.APP_SESSION_SECRET===environment.APP_CSRF_SECRET||!bounded(environment.CONNECTOR_STATE_PATH,2_048)||!isAbsolute(environment.CONNECTOR_STATE_PATH)||!bounded(environment.APP_DATA_KEY_PATH,2_048)||!isAbsolute(environment.APP_DATA_KEY_PATH))return null;
  const repositories=environment.GITHUB_REPOSITORIES?.split(",").map((value)=>value.trim()).filter(Boolean)??[],appId=fromEnvironmentInteger(environment.GITHUB_APP_ID,1,Number.MAX_SAFE_INTEGER),privateKey=environment.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n","\n").trim(),redirectUri=environment.GITHUB_REDIRECT_URI;
  const github=bounded(environment.GITHUB_APP_SLUG,100)&&appId&&bounded(privateKey,16_384)&&privateKey.includes("BEGIN")&&redirectUri===`${LOCAL_ORIGIN}/api/v1/oauth/github/callback`&&repositories.length>0&&repositories.length<=20&&new Set(repositories).size===repositories.length&&repositories.every((repository)=>REPOSITORY.test(repository))?Object.freeze({slug:environment.GITHUB_APP_SLUG,appId,privateKey,redirectUri,repositories:Object.freeze(repositories)}):null;
  return Object.freeze({local:Object.freeze({origin:LOCAL_ORIGIN,session:environment.APP_SESSION_SECRET,csrf:environment.APP_CSRF_SECRET,statePath:environment.CONNECTOR_STATE_PATH,keyPath:environment.APP_DATA_KEY_PATH}),google:googleOAuthConfiguration(environment),linear:oneTimeOAuthConfiguration("linear",environment),github,gmailAddon:environment.GMAIL_ADDON_ENABLED==="1"});
};

const connectorManifest=(source:"google-calendar"|"gmail"|"github"|"linear",connection:{capabilities:string[];consentRevision:number;freshness:FreshnessV1}):ConnectorManifest=>Object.freeze({schemaVersion:1,source,mode:source==="google-calendar"||source==="linear"?"oauth":source==="gmail"?"gmail-addon":"github-app",capabilities:Object.freeze([...connection.capabilities]) as readonly ConnectorCapability[],consentRevision:connection.consentRevision,freshness:Object.freeze({...connection.freshness})});
const registryFrom=async(store:LocalStore)=>{const state=await store.load(),manifests=(Object.keys(state.connections) as ConnectorSource[]).filter((source):source is "google-calendar"|"gmail"|"github"|"linear"=>["google-calendar","gmail","github","linear"].includes(source)).map((source)=>connectorManifest(source,state.connections[source]!));return new ConnectorRegistry(manifests);};

const oauthExchange=(fetchImpl:FetchLike):OneTimeOAuthExchangePort=>({exchange:async(input)=>{
  const body=input.provider==="google-calendar"?new URLSearchParams({code:input.code,client_id:input.clientId,client_secret:input.clientSecret,redirect_uri:input.redirectUri,grant_type:"authorization_code",code_verifier:input.verifier}):new URLSearchParams({code:input.code,client_id:input.clientId,client_secret:input.clientSecret,redirect_uri:input.redirectUri,grant_type:"authorization_code",code_verifier:input.verifier});
  const response=await fetchImpl(input.endpoint,{method:"POST",headers:{accept:"application/json","content-type":"application/x-www-form-urlencoded"},body,signal:input.signal,redirect:"error"});if(!response.ok)throw new Error("OAUTH_EXCHANGE_FAILED");const raw=await boundedJson(response);if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("OAUTH_EXCHANGE_FAILED");const value=raw as Record<string,unknown>;
  return {accessToken:value.access_token,refreshToken:value.refresh_token??null,expiresIn:value.expires_in,scope:value.scope};
}});

const githubJwt=(config:GitHubConfig,now:number)=>{const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url"),header=encode({alg:"RS256",typ:"JWT"}),payload=encode({iat:Math.floor(now/1_000)-60,exp:Math.floor(now/1_000)+540,iss:String(config.appId)}),signer=createSign("RSA-SHA256");signer.update(`${header}.${payload}`);signer.end();return`${header}.${payload}.${signer.sign(config.privateKey).toString("base64url")}`;};
const githubExchange=(config:GitHubConfig,fetchImpl:FetchLike,now:()=>number):GitHubInstallationExchangePort=>({exchange:async({installationId,signal})=>{
  const response=await fetchImpl(`${GITHUB_API_ORIGIN}/app/installations/${installationId}/access_tokens`,{method:"POST",headers:{accept:"application/vnd.github+json",authorization:`Bearer ${githubJwt(config,now())}`,"content-type":"application/json","x-github-api-version":"2026-03-10"},body:JSON.stringify({permissions:{issues:"read",metadata:"read"}}),signal,redirect:"error"});if(!response.ok)throw new Error("OAUTH_EXCHANGE_FAILED");const raw=await boundedJson(response);if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("OAUTH_EXCHANGE_FAILED");const value=raw as Record<string,unknown>;return{accessToken:value.token,expiresAt:value.expires_at};
}});

const googleReadPort=(token:string,fetchImpl:FetchLike)=>({readPage:async(cursor:string|null,signal:AbortSignal):Promise<ReadReply<unknown>>=>{
  const url=new URL(GOOGLE_EVENTS_ENDPOINT);url.search=new URLSearchParams({fields:"items(id,summary,start,end,status,recurrence,recurringEventId,updated,attendees(id,email)),nextPageToken,timeZone",maxResults:"100",singleEvents:"true",showDeleted:"true",...(cursor?{pageToken:cursor}:{})}).toString();
  const response=await fetchImpl(url,{headers:jsonHeaders(token),signal,redirect:"error"});if(!response.ok)return{status:response.status,retryAfterSeconds:response.status===429?Number(response.headers.get("retry-after")??0):undefined};const raw=await boundedJson(response);if(!raw||typeof raw!=="object"||Array.isArray(raw))return{status:200,value:raw};const value=raw as Record<string,unknown>,zone=typeof value.timeZone==="string"?value.timeZone:"UTC",allDay=(date:unknown)=>{if(typeof date!=="string")return undefined;try{const plain=Temporal.PlainDate.from(date);return Temporal.ZonedDateTime.from({timeZone:zone,year:plain.year,month:plain.month,day:plain.day,hour:0}).toInstant().toString();}catch{return undefined;}},items=Array.isArray(value.items)?value.items.map((item)=>{const event=item as Record<string,unknown>,start=event.start as Record<string,unknown>|undefined,end=event.end as Record<string,unknown>|undefined,attendees=Array.isArray(event.attendees)?event.attendees:[];return{id:event.id,summary:event.summary??"Busy",start:start?.dateTime??allDay(start?.date),end:end?.dateTime??allDay(end?.date),status:event.status,recurrence:Array.isArray(event.recurrence)?event.recurrence:[],recurringEventId:event.recurringEventId??null,updated:event.updated,attendeeIds:attendees.map((attendee)=>{const person=attendee as Record<string,unknown>;return person.id??person.email;}).filter((id):id is string=>typeof id==="string")};}):value.items;
  return{status:200,value:{items,nextPageToken:value.nextPageToken??null}};
}});

const githubReadPort=(token:string,installationId:number,repositories:readonly string[],fetchImpl:FetchLike)=>({readPage:async(cursor:string|null,signal:AbortSignal):Promise<ReadReply<unknown>>=>{
  const match=cursor?.match(/^([0-9]{1,2}):([1-9][0-9]{0,3})$/),repositoryIndex=match?Number(match[1]):0,page=match?Number(match[2]):1;if(repositoryIndex>=repositories.length)return{status:200,value:{items:[],nextCursor:null}};const repository=repositories[repositoryIndex]!;
  const url=new URL(`${GITHUB_API_ORIGIN}/repos/${repository}/issues`);url.search=new URLSearchParams({state:"all",per_page:"100",page:String(page),sort:"updated",direction:"asc"}).toString();const response=await fetchImpl(url,{headers:{...jsonHeaders(token),accept:"application/vnd.github+json","x-github-api-version":"2026-03-10"},signal,redirect:"error"});if(!response.ok)return{status:response.status,retryAfterSeconds:response.status===429?Number(response.headers.get("retry-after")??0):undefined};const raw=await boundedJson(response);if(!Array.isArray(raw))return{status:200,value:raw};
  const items=raw.filter((item)=>item&&typeof item==="object"&&!Array.isArray(item)&&!("pull_request" in item)).map((item)=>{const issue=item as Record<string,unknown>,milestone=issue.milestone as Record<string,unknown>|null,assignees=Array.isArray(issue.assignees)?issue.assignees:[];return{installationId,repositoryFullName:repository,issueNumber:issue.number,title:issue.title,state:issue.state,labels:Array.isArray(issue.labels)?issue.labels.map((label)=>typeof label==="string"?label:(label as Record<string,unknown>).name).filter((label):label is string=>typeof label==="string"):[],milestone:milestone?.title??null,assigneeIds:assignees.map((assignee)=>(assignee as Record<string,unknown>).node_id??(assignee as Record<string,unknown>).login).filter((id):id is string=>typeof id==="string"),projectReference:null,updatedAt:issue.updated_at};});
  const nextCursor=raw.length===100?`${repositoryIndex}:${page+1}`:repositoryIndex+1<repositories.length?`${repositoryIndex+1}:1`:null;return{status:200,value:{items,nextCursor}};
}});

const LINEAR_QUERY=`query CapacityTasks($after: String) { issues(first: 100, after: $after, orderBy: updatedAt) { nodes { id identifier team { id } title state { name } priority estimate cycle { name } dueDate updatedAt } pageInfo { hasNextPage endCursor } } }`;
const linearReadPort=(token:string,fetchImpl:FetchLike)=>({readPage:async(cursor:string|null,signal:AbortSignal):Promise<ReadReply<unknown>>=>{const response=await fetchImpl(LINEAR_GRAPHQL_ENDPOINT,{method:"POST",headers:{...jsonHeaders(token),"content-type":"application/json"},body:JSON.stringify({query:LINEAR_QUERY,variables:{after:cursor}}),signal,redirect:"error"});if(!response.ok)return{status:response.status,retryAfterSeconds:response.status===429?Number(response.headers.get("retry-after")??0):undefined};const raw=await boundedJson(response);if(!raw||typeof raw!=="object"||Array.isArray(raw))return{status:200,value:raw};const issues=((raw as Record<string,unknown>).data as Record<string,unknown>|undefined)?.issues as Record<string,unknown>|undefined,nodes=Array.isArray(issues?.nodes)?issues.nodes.map((item)=>{const issue=item as Record<string,unknown>;return{issueId:issue.id,identifier:issue.identifier,teamId:(issue.team as Record<string,unknown>|undefined)?.id,title:issue.title,state:(issue.state as Record<string,unknown>|undefined)?.name,priority:issue.priority??null,estimate:issue.estimate??null,cycle:(issue.cycle as Record<string,unknown>|null)?.name??null,dueDate:typeof issue.dueDate==="string"?`${issue.dueDate}T23:59:59Z`:null,updatedAt:issue.updatedAt};}):issues?.nodes,pageInfo=issues?.pageInfo as Record<string,unknown>|undefined;return{status:200,value:{items:nodes,nextCursor:pageInfo?.hasNextPage===true?pageInfo.endCursor:null}};}});

const googleEffectPort=(token:string,store:LocalStore,fetchImpl:FetchLike)=>({
  insert:async({effectId,privateMarker,signal}:{effectId:string;privateMarker:string;signal:AbortSignal})=>{const effect=await store.loadConnectorEffect(effectId),proposal=effect?(await store.load()).proposals.find((item)=>item.id===effect.proposalId):null;if(!proposal||proposal.status!=="effect-pending"&&proposal.status!=="approved")return{outcome:"malformed"};const response=await fetchImpl(GOOGLE_EVENTS_ENDPOINT,{method:"POST",headers:{...jsonHeaders(token),"content-type":"application/json"},body:JSON.stringify({summary:"Focus block",start:{dateTime:proposal.startAt},end:{dateTime:proposal.endAt},extendedProperties:{private:{capacityEffectId:privateMarker}}}),signal,redirect:"error"});if(response.status===408||response.status===504)return{outcome:"timeout"};if(!response.ok)return{outcome:"connection-lost"};const raw=await boundedJson(response);if(!raw||typeof raw!=="object"||Array.isArray(raw)||!boundedProviderText((raw as Record<string,unknown>).id,256))return{outcome:"malformed"};return{outcome:"succeeded",marker:privateMarker,providerEntityId:(raw as Record<string,unknown>).id};},
  find:async({privateMarker,signal}:{effectId:string;privateMarker:string;signal:AbortSignal})=>{const url=new URL(GOOGLE_EVENTS_ENDPOINT);url.search=new URLSearchParams({privateExtendedProperty:`capacityEffectId=${privateMarker}`,maxResults:"2",singleEvents:"true",showDeleted:"false",fields:"items(id)"}).toString();const response=await fetchImpl(url,{headers:jsonHeaders(token),signal,redirect:"error"});if(!response.ok)return{outcome:"unknown"};const raw=await boundedJson(response),items=raw&&typeof raw==="object"&&!Array.isArray(raw)&&Array.isArray((raw as Record<string,unknown>).items)?(raw as {items:unknown[]}).items:[];if(items.length===0)return{outcome:"absent"};const id=(items[0] as Record<string,unknown>)?.id;return items.length===1&&boundedProviderText(id,256)?{outcome:"found",providerEntityId:id}:{outcome:"unknown"};},
});

export type AuthorizedConnectorCommand=ConnectorCommand;
export class LiveConnectorRuntime{
  readonly store:LocalStore;readonly keys:DataKeyManager;readonly tokens:LocalStoreConnectorRepository;readonly privacy:ConnectorPrivacyService;
  readonly googleOAuth:GoogleOAuthService|null;readonly linearOAuth:OneTimeOAuthService|null;readonly githubOAuth:GitHubInstallationService|null;
  private readonly guard:SessionGuard;
  constructor(readonly config:LiveConnectorConfiguration,private readonly fetchImpl:FetchLike=fetch){
    this.store=new LocalStore(config.local.statePath);this.keys=new DataKeyManager(config.local.keyPath);this.tokens=new LocalStoreConnectorRepository(this.store);this.guard=new SessionGuard({session:config.local.session,csrf:config.local.csrf,origin:config.local.origin});const exchange=oauthExchange(fetchImpl),clock={now:()=>Date.now()};
    this.googleOAuth=config.google?new GoogleOAuthService(config.google,exchange,this.keys,this.tokens,clock):null;this.linearOAuth=config.linear?new OneTimeOAuthService(config.linear,exchange,this.keys,this.tokens,clock):null;this.githubOAuth=config.github?new GitHubInstallationService(config.github.slug,config.github.redirectUri,githubExchange(config.github,fetchImpl,clock.now),this.keys,this.tokens,clock):null;
    const remote={revoke:async(source:ConnectorSource,authorization:TokenEnvelopeV1,_timeout:10_000,signal:AbortSignal)=>{const value=await tokenPayload(this.keys,authorization),token=value.refreshToken??value.accessToken;if(!bounded(token,8_192))return"failed" as const;if(source==="linear")return"failed" as const;const response=source==="google-calendar"?await fetchImpl(GOOGLE_REVOKE_ENDPOINT,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token}),signal,redirect:"error"}):source==="github"?await fetchImpl(`${GITHUB_API_ORIGIN}/installation/token`,{method:"DELETE",headers:{...jsonHeaders(token),accept:"application/vnd.github+json","x-github-api-version":"2026-03-10"},signal,redirect:"error"}):null;return response?.ok?"confirmed" as const:"failed" as const;}};
    this.privacy=new ConnectorPrivacyService(new LocalStoreAtomicRevocationPort(this.store),remote,()=>new Date().toISOString());
  }
  sessionId(request:Request,oauthCallback=false){const origin=oauthCallback?this.config.local.origin:request.headers.get("origin")??undefined;return this.guard.requireRead({cookie:request.headers.get("cookie")??undefined,origin}).ok?this.config.local.session:null;}
  authorizeBootstrap(request:Request):ConnectorCommand|null{const header=request.headers.get("x-expected-revision"),revision=header==="0"?0:NaN,input={cookie:request.headers.get("cookie")??undefined,origin:request.headers.get("origin")??undefined,csrf:request.headers.get("x-csrf-token")??undefined,revision,currentRevision:0,commandId:request.headers.get("x-command-id")??undefined,idempotencyKey:request.headers.get("idempotency-key")??undefined};if(request.headers.get("x-bootstrap-confirm")!=="initialize-absent-store"||!this.guard.requireMutation(input).ok)return null;return Object.freeze({expectedRevision:0,commandId:input.commandId!,idempotencyKey:input.idempotencyKey!});}
  async bootstrap(input:Readonly<{profileId:string;timeZone:string}>){const state=localStateV1Schema.parse({schemaVersion:1,revision:0,profileId:input.profileId,timeZone:input.timeZone,connections:{},tasks:[],schedulingIntents:[],commitments:[],observations:[],proposals:[],events:[],commandReceipts:{}});await this.store.initialize(state);return Object.freeze({schemaVersion:1 as const,revision:0,initialized:true as const});}
  async authorizeMutation(request:Request):Promise<AuthorizedConnectorCommand|null>{const header=request.headers.get("x-expected-revision");if(!header||!/^\d+$/.test(header)||!Number.isSafeInteger(Number(header)))return null;const revision=Number(header),input={cookie:request.headers.get("cookie")??undefined,origin:request.headers.get("origin")??undefined,csrf:request.headers.get("x-csrf-token")??undefined,revision,currentRevision:revision,commandId:request.headers.get("x-command-id")??undefined,idempotencyKey:request.headers.get("idempotency-key")??undefined};if(!this.guard.requireMutation(input).ok)return null;let currentRevision:number;try{currentRevision=(await this.store.load()).revision;}catch{return null;}if(!this.guard.requireMutation({...input,currentRevision}).ok)return null;return Object.freeze({expectedRevision:revision,commandId:input.commandId!,idempotencyKey:input.idempotencyKey!});}
  private async access(source:"google-calendar"|"github"|"linear"){const envelope=await this.store.loadConnectorToken(source);if(!envelope)throw new Error("AUTH_REQUIRED");const value=await tokenPayload(this.keys,envelope);if(!bounded(value.accessToken,8_192))throw new Error("AUTH_REQUIRED");return value;}
  async googleAdapter(){const registry=await registryFrom(this.store),token=await this.access("google-calendar"),key=deriveMeetingPatternKey((await this.keys.load()).key);return new GoogleCalendarAdapter(registry,googleReadPort(token.accessToken as string,this.fetchImpl),(series,attendees)=>key.digest(series,attendees),systemReadClock);}
  async githubAdapter(){if(!this.config.github)throw new Error("GITHUB_DISABLED");const registry=await registryFrom(this.store),token=await this.access("github");if(!integer(token.installationId,1))throw new Error("AUTH_REQUIRED");return new GitHubTaskAdapter(registry,githubReadPort(token.accessToken as string,token.installationId,this.config.github.repositories,this.fetchImpl));}
  async linearAdapter(){const registry=await registryFrom(this.store),token=await this.access("linear");return new LinearTaskAdapter(registry,linearReadPort(token.accessToken as string,this.fetchImpl));}
  async gmailAdapter(){if(!this.config.gmailAddon)throw new Error("GMAIL_ADDON_DISABLED");return new SelectedGmailAdapter(await registryFrom(this.store));}
  async importSelectedGmail(actions:readonly SelectedMessageAction[],input:Readonly<{consentRevision:number;fetchedAt:string}>,command:ConnectorCommand){if(!this.config.gmailAddon)throw new Error("GMAIL_ADDON_DISABLED");const state=await this.store.load(),connection=state.connections.gmail,registry=connection?await registryFrom(this.store):new ConnectorRegistry([connectorManifest("gmail",{capabilities:["gmail.selected-message.read"],consentRevision:input.consentRevision,freshness:{schemaVersion:1,fetchedAt:input.fetchedAt,sourceUpdatedAt:null,expiresAt:null,state:"fresh"}})]),commitments=await new SelectedGmailAdapter(registry).normalize(actions,input),freshness=commitments.map((item)=>item.provenance.freshness).sort((left,right)=>(right.sourceUpdatedAt??"").localeCompare(left.sourceUpdatedAt??""))[0]??{schemaVersion:1,fetchedAt:input.fetchedAt,sourceUpdatedAt:null,expiresAt:null,state:"fresh" as const};await this.store.commitGmailSelection({...command,consentRevision:input.consentRevision,freshness,commitments});return Object.freeze({schemaVersion:1 as const,source:"gmail" as const,normalizedIds:Object.freeze(commitments.map((item)=>item.id)),freshness});}
  async googleEffectAdapter(){const registry=await registryFrom(this.store),token=await this.access("google-calendar"),connection=(await this.store.load()).connections["google-calendar"];if(!connection?.capabilities.includes("calendar.event.write"))throw new Error("GOOGLE_CALENDAR_WRITE_NOT_AUTHORIZED");return new GoogleCalendarEffectAdapter(googleEffectPort(token.accessToken as string,this.store,this.fetchImpl),registry,connection.consentRevision);}
  async executeGoogleEffect(intent:EffectIntent,command:ConnectorCommand):Promise<EffectState>{let state=await this.store.loadConnectorEffect(intent.effectId);if(!state){state=createEffectState(intent);await this.store.commitConnectorEffect({...command,state});}
    const adapter=await this.googleEffectAdapter(),runner=new EffectRunner(adapter),revision=()=>this.store.load().then((value)=>value.revision),commit=async(next:EffectState,label:string)=>{await this.store.commitConnectorEffect({expectedRevision:await revision(),commandId:randomUUID(),idempotencyKey:`effect:${intent.effectId}:${label}:${next.history.length}`,state:next});return next;};
    if(state.status==="succeeded"||state.status==="reconciliation-found"||state.status==="retry-completed")return state;
    if(state.status==="unknown"){const reconciled=await runner.reconcile(intent,state);return reconciled.providerCalled?commit(reconciled.state,"reconcile"):state;}
    if(state.status!=="effect-pending")return state;
    const preflight=await adapter.reconcile(intent.effectId,intent.marker);if(preflight.outcome==="found"){const recovered=await new EffectRunner({provider:"google-calendar",execute:async()=>({outcome:"succeeded",marker:intent.marker,providerEntityId:preflight.providerEntityId}),reconcile:async()=>preflight}).execute(intent,state);return commit(recovered.state,"preflight-found");}
    if(preflight.outcome!=="absent"){const blocked=await new EffectRunner({provider:"google-calendar",execute:async()=>({outcome:"connection-lost"}),reconcile:async()=>preflight}).execute(intent,state);return commit(blocked.state,"preflight-unknown");}
    const executed=await runner.execute(intent,state);return commit(executed.state,"execute");
  }
  async manifests(){try{return(await registryFrom(this.store)).snapshot();}catch{return Object.freeze([]);}}
}

let runtimePromise:Promise<LiveConnectorRuntime|null>|null=null;
export const createLiveConnectorRuntime=(environment:Record<string,string|undefined>,fetchImpl:FetchLike=fetch)=>{const config=liveConnectorConfiguration(environment);return config?new LiveConnectorRuntime(config,fetchImpl):null;};
export const getLiveConnectorRuntime=()=>runtimePromise??=Promise.resolve(createLiveConnectorRuntime(process.env));
export const resetLiveConnectorRuntimeForTests=()=>{runtimePromise=null;};
