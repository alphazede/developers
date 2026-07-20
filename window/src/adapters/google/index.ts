import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";

import { executeBoundedRead, systemReadClock, type AdapterError, type ConnectorRegistry, type ReadClock, type ReadReply } from "../../application/connectors";
import { normalizedCommitmentV1Schema, type NormalizedCommitmentV1 } from "../../contracts/v1";
import type { EffectIntent, ProviderReply, ReconcileReply } from "../../application/effects";
import { uuidV5 } from "../../domain/schedule";
import { AdapterBoundaryError, MAX_PROVIDER_BYTES, MAX_PROVIDER_PAGES, MAX_PROVIDER_RECORDS, MAX_PROVIDER_RECORDS_PER_PAGE, adapterFailure, boundedCursor, boundedProviderText, exactObject } from "../shared";

type CalendarReadPort=Readonly<{readPage(cursor:string|null,signal:AbortSignal):Promise<ReadReply<unknown>>}>;
type RawEvent={id:string;summary:string;start:string;end:string;status:"confirmed"|"tentative"|"cancelled";recurrence:readonly string[];recurringEventId:string|null;updated:string;attendeeIds:readonly string[]};
export type ParticipantKeyPort=(seriesRef:string,attendeeIds:readonly string[])=>string;
export type SelectedMessageAction=Readonly<{message:Readonly<{id:string;threadId:string;subject:string;selectedBodyFragment:string;internalDate:string}>;confirmation:Readonly<{confirmed:true;messageId:string;fragmentSha256:string;title:string;deadlineAt:string|null}>}>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,HASH=/^[a-f0-9]{64}$/;
const canonicalInstant=(value:unknown):value is string=>{if(typeof value!=="string"||value.length>40||!value.endsWith("Z"))return false;try{return Temporal.Instant.from(value).toString()===value;}catch{return false;}};
const errorResult=(error:AdapterError)=>Object.freeze({ok:false as const,error});
const isAdapterError=(value:unknown):value is AdapterError=>!!value&&typeof value==="object"&&"code" in value&&"source" in value;
const freshness=(source:"google-calendar"|"gmail",fetchedAt:string,sourceUpdatedAt:string)=>Object.freeze({schemaVersion:1 as const,fetchedAt,sourceUpdatedAt,expiresAt:Temporal.Instant.from(fetchedAt).add({hours:24*7}).toString(),state:"fresh" as const,source});
const normalizedFreshness=(value:ReturnType<typeof freshness>)=>{const {source:_,...result}=value;void _;return result;};

const parseEvent=(value:unknown):RawEvent=>{
  if(!exactObject(value,["id","summary","start","end","status","recurrence","recurringEventId","updated","attendeeIds"])||!boundedProviderText(value.id,256)||!boundedProviderText(value.summary)||!canonicalInstant(value.start)||!canonicalInstant(value.end)||Temporal.Instant.compare(value.start,value.end)>=0||!["confirmed","tentative","cancelled"].includes(value.status as string)||!Array.isArray(value.recurrence)||value.recurrence.length>10||value.recurrence.some((item)=>!boundedProviderText(item,256))||(value.recurringEventId!==null&&!boundedProviderText(value.recurringEventId,256))||!canonicalInstant(value.updated)||!Array.isArray(value.attendeeIds)||value.attendeeIds.length>100||value.attendeeIds.some((item)=>!boundedProviderText(item,256)))return adapterFailure("google-calendar","MALFORMED_SOURCE");
  return value as unknown as RawEvent;
};

export class GoogleCalendarAdapter{
  constructor(private readonly registry:ConnectorRegistry,private readonly read:CalendarReadPort,private readonly participantKey:ParticipantKeyPort,private readonly clock:ReadClock){}
  async sync(input:Readonly<{consentRevision:number;fetchedAt:string}>):Promise<Readonly<{ok:true;commitments:readonly NormalizedCommitmentV1[];freshness:ReturnType<typeof normalizedFreshness>}>|Readonly<{ok:false;error:AdapterError}>>{
    const denied=this.registry.require("google-calendar","calendar.read",input.consentRevision);if(denied)return errorResult(denied);
    if(!Number.isSafeInteger(input.consentRevision)||!canonicalInstant(input.fetchedAt))return errorResult({schemaVersion:1,source:"google-calendar",code:"MALFORMED_SOURCE",retriable:false});
    const started=this.clock.now(),seenCursors=new Set<string>(),seenIds=new Set<string>();let cursor:string|null=null,totalBytes=0;const events:RawEvent[]=[];
    try{
      for(let page=0;page<MAX_PROVIDER_PAGES;page+=1){
        const remaining=20_000-(this.clock.now()-started);if(remaining<=0)return errorResult({schemaVersion:1,source:"google-calendar",code:"PROVIDER_UNAVAILABLE",retriable:true});
        const reply=await executeBoundedRead("google-calendar",this.clock,(_attempt,signal)=>this.read.readPage(cursor,signal),remaining);if(isAdapterError(reply))return errorResult(reply);
        const bytes=Buffer.byteLength(JSON.stringify(reply));totalBytes+=bytes;if(totalBytes>MAX_PROVIDER_BYTES)return errorResult({schemaVersion:1,source:"google-calendar",code:"OVERSIZED_SOURCE",retriable:false});
        if(!exactObject(reply,["items","nextPageToken"])||!Array.isArray(reply.items)||reply.items.length>MAX_PROVIDER_RECORDS_PER_PAGE||!boundedCursor(reply.nextPageToken))return errorResult({schemaVersion:1,source:"google-calendar",code:"MALFORMED_SOURCE",retriable:false});
        for(const raw of reply.items){const event=parseEvent(raw);if(seenIds.has(event.id))return errorResult({schemaVersion:1,source:"google-calendar",code:"MALFORMED_SOURCE",retriable:false});seenIds.add(event.id);events.push(event);if(events.length>MAX_PROVIDER_RECORDS)return errorResult({schemaVersion:1,source:"google-calendar",code:"OVERSIZED_SOURCE",retriable:false});}
        cursor=reply.nextPageToken;if(cursor===null)break;if(seenCursors.has(cursor))return errorResult({schemaVersion:1,source:"google-calendar",code:"MALFORMED_SOURCE",retriable:false});seenCursors.add(cursor);
        if(page===MAX_PROVIDER_PAGES-1)return errorResult({schemaVersion:1,source:"google-calendar",code:"OVERSIZED_SOURCE",retriable:false});
      }
      const included=events.filter((event)=>event.status!=="cancelled").sort((a,b)=>Temporal.Instant.compare(a.updated,b.updated)||(a.id<b.id?-1:a.id>b.id?1:0));
      const sourceUpdatedAt=events.map((event)=>event.updated).sort((a,b)=>Temporal.Instant.compare(b,a))[0]??input.fetchedAt;
      const values=await Promise.all(included.map(async(event)=>{
        const seriesRef=event.recurringEventId??event.recurrence[0]??event.id,attendeeIds=[...event.attendeeIds].sort(),participantSetKey=attendeeIds.length?this.participantKey(seriesRef,attendeeIds):null;
        if(participantSetKey!==null&&!HASH.test(participantSetKey))return adapterFailure("google-calendar","MALFORMED_SOURCE");
        return normalizedCommitmentV1Schema.parse({schemaVersion:1,id:await uuidV5(["urn:capacity-scheduling:google-calendar:v1",event.id]),kind:"calendar-event",title:event.summary,startAt:event.start,endAt:event.end,deadlineAt:null,hard:true,protected:false,recurringSeriesRef:event.recurringEventId??event.recurrence[0]??null,participantSetKey,provenance:{schemaVersion:1,source:"google-calendar",sourceEntityId:event.id,consentRevision:input.consentRevision,freshness:normalizedFreshness(freshness("google-calendar",input.fetchedAt,sourceUpdatedAt)),importedAt:input.fetchedAt}});
      }));
      return Object.freeze({ok:true as const,commitments:Object.freeze(values),freshness:normalizedFreshness(freshness("google-calendar",input.fetchedAt,sourceUpdatedAt))});
    }catch(error){if(error instanceof AdapterBoundaryError)return errorResult({schemaVersion:1,source:error.source,code:error.code,retriable:false});return errorResult({schemaVersion:1,source:"google-calendar",code:"MALFORMED_SOURCE",retriable:false});}
  }
}

export class SelectedGmailAdapter{
  readonly status=Object.freeze({mode:"gmail-addon" as const,normalOAuth:false,requiredScope:"https://www.googleapis.com/auth/gmail.addons.current.message.readonly"});
  constructor(private readonly registry:ConnectorRegistry){}
  async normalize(actions:readonly SelectedMessageAction[],input:Readonly<{consentRevision:number;fetchedAt:string}>):Promise<readonly NormalizedCommitmentV1[]>{
    const denied=this.registry.require("gmail","gmail.selected-message.read",input.consentRevision);if(denied)throw new AdapterBoundaryError("gmail",denied.code);
    if(!Array.isArray(actions)||actions.length>MAX_PROVIDER_RECORDS_PER_PAGE||Buffer.byteLength(JSON.stringify(actions))>MAX_PROVIDER_BYTES||!canonicalInstant(input.fetchedAt))return adapterFailure("gmail","MALFORMED_SOURCE");
    const seen=new Set<string>(),normalized:Readonly<{internalDate:string;commitment:NormalizedCommitmentV1}>[]=[];
    for(const action of actions){
      if(!exactObject(action,["message","confirmation"])||!exactObject(action.message,["id","threadId","subject","selectedBodyFragment","internalDate"])||!exactObject(action.confirmation,["confirmed","messageId","fragmentSha256","title","deadlineAt"])||action.confirmation.confirmed!==true||!boundedProviderText(action.message.id,256)||!boundedProviderText(action.message.threadId,256)||!boundedProviderText(action.message.subject)||!boundedProviderText(action.message.selectedBodyFragment,10_000)||!canonicalInstant(action.message.internalDate)||action.confirmation.messageId!==action.message.id||typeof action.confirmation.fragmentSha256!=="string"||!HASH.test(action.confirmation.fragmentSha256)||createHash("sha256").update(action.message.selectedBodyFragment).digest("hex")!==action.confirmation.fragmentSha256||!boundedProviderText(action.confirmation.title)||(action.confirmation.deadlineAt!==null&&!canonicalInstant(action.confirmation.deadlineAt))||seen.has(action.message.id))return adapterFailure("gmail","MALFORMED_SOURCE");
      seen.add(action.message.id);const sourceFreshness=normalizedFreshness(freshness("gmail",input.fetchedAt,action.message.internalDate));
      const commitment=normalizedCommitmentV1Schema.parse({schemaVersion:1,id:await uuidV5(["urn:capacity-scheduling:gmail-selected:v1",action.message.id,action.message.threadId]),kind:"selected-email-commitment",title:action.confirmation.title,startAt:null,endAt:null,deadlineAt:action.confirmation.deadlineAt,hard:true,protected:false,recurringSeriesRef:null,participantSetKey:null,provenance:{schemaVersion:1,source:"gmail",sourceEntityId:action.message.id,consentRevision:input.consentRevision,freshness:sourceFreshness,importedAt:input.fetchedAt}});
      normalized.push({internalDate:action.message.internalDate,commitment});
    }
    return Object.freeze(normalized.sort((a,b)=>Temporal.Instant.compare(a.internalDate,b.internalDate)||(a.commitment.provenance.sourceEntityId<b.commitment.provenance.sourceEntityId?-1:1)).map((item)=>Object.freeze(item.commitment)));
  }
}

type EffectProvider=Readonly<{insert(input:Readonly<{effectId:string;privateMarker:string;signal:AbortSignal}>):Promise<unknown>;find(input:Readonly<{effectId:string;privateMarker:string;signal:AbortSignal}>):Promise<unknown>}>;
type EffectTimeout=<T>(operation:Promise<T>,milliseconds:number,onTimeout:()=>void)=>Promise<T>;
const validEffectIntent=(value:unknown):value is EffectIntent=>exactObject(value,["effectId","proposalId","marker","provider"])&&typeof value.effectId==="string"&&UUID.test(value.effectId)&&typeof value.proposalId==="string"&&UUID.test(value.proposalId)&&value.marker===`capacity-effect:${value.effectId}`&&value.provider==="google-calendar";
export class GoogleCalendarEffectAdapter{
  readonly provider="google-calendar" as const;
  constructor(private readonly port:EffectProvider,private readonly registry:ConnectorRegistry,private readonly consentRevision:number,private readonly withTimeout:EffectTimeout=systemReadClock.withTimeout){}
  async executeApprovedCalendarEffect(intent:EffectIntent):Promise<ProviderReply>{
    const denied=this.registry.require("google-calendar","calendar.event.write",this.consentRevision);if(denied)throw new AdapterBoundaryError("google-calendar",denied.code);
    if(!validEffectIntent(intent))return adapterFailure("google-calendar","UNSUPPORTED_CONTRACT");
    const controller=new AbortController();let raw:unknown;try{raw=await this.withTimeout(this.port.insert({effectId:intent.effectId,privateMarker:intent.marker,signal:controller.signal}),10_000,()=>controller.abort());}catch{return {outcome:"connection-lost"};}
    if(!exactObject(raw,raw&&typeof raw==="object"&&"outcome" in raw&&(raw as {outcome?:unknown}).outcome==="succeeded"?["outcome","marker","providerEntityId"]:["outcome"]))return {outcome:"malformed"};
    if(raw.outcome==="timeout")return {outcome:"timeout"};if(raw.outcome==="connection-lost")return {outcome:"connection-lost"};
    if(raw.outcome!=="succeeded"||raw.marker!==intent.marker||!boundedProviderText(raw.providerEntityId,256))return {outcome:"malformed"};
    return {outcome:"succeeded",marker:intent.marker,providerEntityId:raw.providerEntityId};
  }
  async reconcileEffect(effectId:string):Promise<ReconcileReply>{
    if(!UUID.test(effectId))return adapterFailure("google-calendar","UNSUPPORTED_CONTRACT");const marker=`capacity-effect:${effectId}`;
    const controller=new AbortController();let raw:unknown;try{raw=await this.withTimeout(this.port.find({effectId,privateMarker:marker,signal:controller.signal}),10_000,()=>controller.abort());}catch{return {outcome:"unknown",reason:"connection-lost"};}
    if(!exactObject(raw,raw&&typeof raw==="object"&&"outcome" in raw&&(raw as {outcome?:unknown}).outcome==="found"?["outcome","providerEntityId"]:["outcome"]))return {outcome:"unknown",reason:"malformed-response"};
    if(raw.outcome==="found"&&boundedProviderText(raw.providerEntityId,256))return {outcome:"found",providerEntityId:raw.providerEntityId};
    if(raw.outcome==="absent")return {outcome:"absent"};
    return {outcome:"unknown",reason:"malformed-response"};
  }
  async execute(intent:EffectIntent){return this.executeApprovedCalendarEffect(intent);}
  async reconcile(effectId:string,marker:string){if(marker!==`capacity-effect:${effectId}`)return adapterFailure("google-calendar","UNSUPPORTED_CONTRACT");return this.reconcileEffect(effectId);}
}
