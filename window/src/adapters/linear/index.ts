import { Temporal } from "@js-temporal/polyfill";

import { executeBoundedRead, systemReadClock, type AdapterError, type ConnectorCapability, type ConnectorManifest, type ConnectorRegistry, type ReadClock, type ReadReply } from "../../application/connectors";
import { normalizedTaskV1Schema, type FreshnessV1, type NormalizedTaskV1 } from "../../contracts/v1";
import { uuidV5 } from "../../domain/schedule";
import { AdapterBoundaryError, MAX_PROVIDER_BYTES, MAX_PROVIDER_PAGES, MAX_PROVIDER_RECORDS, MAX_PROVIDER_RECORDS_PER_PAGE, adapterFailure, boundedCursor, boundedProviderText, exactObject } from "../shared";

export type LinearReadPort=Readonly<{readPage(cursor:string|null,signal:AbortSignal):Promise<ReadReply<unknown>>}>;
export type LinearEstimateRule=Readonly<{minutesPerPoint:15;maximumPoints:number}>;
type RawIssue=Readonly<{issueId:string;identifier:string;teamId:string;title:string;state:string;priority:number|null;estimate:number|null;cycle:string|null;dueDate:string|null;updatedAt:string}>;
const IDENTIFIER=/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const canonicalInstant=(value:unknown):value is string=>{if(typeof value!=="string"||value.length>40||!value.endsWith("Z"))return false;try{return Temporal.Instant.from(value).toString()===value;}catch{return false;}};
const errorResult=(error:AdapterError)=>Object.freeze({ok:false as const,error});
const isAdapterError=(value:unknown):value is AdapterError=>!!value&&typeof value==="object"&&"code" in value&&"source" in value;
const sourceFreshness=(fetchedAt:string,sourceUpdatedAt:string):FreshnessV1=>Object.freeze({schemaVersion:1,fetchedAt,sourceUpdatedAt,expiresAt:Temporal.Instant.from(fetchedAt).add({hours:24}).toString(),state:"fresh"});
const freezeTask=(task:NormalizedTaskV1):NormalizedTaskV1=>{const labels=[...task.labels],freshness={...task.provenance.freshness},provenance={...task.provenance,freshness},result={...task,labels,provenance};Object.freeze(labels);Object.freeze(freshness);Object.freeze(provenance);Object.freeze(result);return result;};
const validRule=(value:unknown):value is LinearEstimateRule=>value!==null&&exactObject(value,["minutesPerPoint","maximumPoints"])&&value.minutesPerPoint===15&&Number.isSafeInteger(value.maximumPoints)&&Number(value.maximumPoints)>=1&&Number(value.maximumPoints)<=32;

export const linearConnectorManifest=(consentRevision:number,freshness:FreshnessV1):ConnectorManifest=>{const capabilities:ConnectorCapability[]=["task.connect","task.read","task.sync","task.revoke"],value={...freshness};Object.freeze(capabilities);Object.freeze(value);return Object.freeze({schemaVersion:1,source:"linear",mode:"oauth",capabilities,consentRevision,freshness:value});};

const parseIssue=(value:unknown):RawIssue=>{
  if(!exactObject(value,["issueId","identifier","teamId","title","state","priority","estimate","cycle","dueDate","updatedAt"])
    ||!boundedProviderText(value.issueId,256)||!boundedProviderText(value.identifier,128)||!IDENTIFIER.test(value.identifier)||!boundedProviderText(value.teamId,256)
    ||!boundedProviderText(value.title)||!boundedProviderText(value.state,128)
    ||(value.priority!==null&&(!Number.isSafeInteger(value.priority)||Number(value.priority)<0||Number(value.priority)>4))
    ||(value.estimate!==null&&(!Number.isSafeInteger(value.estimate)||Number(value.estimate)<0||Number(value.estimate)>100))
    ||(value.cycle!==null&&!boundedProviderText(value.cycle,256))||(value.dueDate!==null&&!canonicalInstant(value.dueDate))||!canonicalInstant(value.updatedAt))return adapterFailure("linear","MALFORMED_SOURCE");
  return value as unknown as RawIssue;
};

export class LinearTaskAdapter{
  constructor(private readonly registry:ConnectorRegistry,private readonly read:LinearReadPort,private readonly clock:ReadClock=systemReadClock){}
  async sync(input:Readonly<{consentRevision:number;fetchedAt:string;estimateRule:LinearEstimateRule|null}>):Promise<Readonly<{ok:true;tasks:readonly NormalizedTaskV1[];freshness:FreshnessV1}>|Readonly<{ok:false;error:AdapterError}>>{
    if(!exactObject(input,["consentRevision","fetchedAt","estimateRule"])||!Number.isSafeInteger(input.consentRevision)||input.consentRevision<0||!canonicalInstant(input.fetchedAt)||(input.estimateRule!==null&&!validRule(input.estimateRule)))return errorResult({schemaVersion:1,source:"linear",code:"MALFORMED_SOURCE",retriable:false});
    const denied=this.registry.require("linear","task.sync",input.consentRevision);if(denied)return errorResult(denied);
    const started=this.clock.now(),seenCursors=new Set<string>(),seenIds=new Set<string>(),seenIdentifiers=new Set<string>();let cursor:string|null=null,totalBytes=0;const issues:RawIssue[]=[];
    try{
      for(let page=0;page<MAX_PROVIDER_PAGES;page+=1){
        const remaining=20_000-(this.clock.now()-started);if(remaining<=0)return errorResult({schemaVersion:1,source:"linear",code:"PROVIDER_UNAVAILABLE",retriable:true});
        const reply=await executeBoundedRead("linear",this.clock,(_attempt,signal)=>this.read.readPage(cursor,signal),remaining);if(isAdapterError(reply))return errorResult(reply);
        totalBytes+=Buffer.byteLength(JSON.stringify(reply));if(totalBytes>MAX_PROVIDER_BYTES)return errorResult({schemaVersion:1,source:"linear",code:"OVERSIZED_SOURCE",retriable:false});
        if(!exactObject(reply,["items","nextCursor"])||!Array.isArray(reply.items)||reply.items.length>MAX_PROVIDER_RECORDS_PER_PAGE||!boundedCursor(reply.nextCursor))return errorResult({schemaVersion:1,source:"linear",code:"MALFORMED_SOURCE",retriable:false});
        for(const value of reply.items){const issue=parseIssue(value),identity=`${issue.teamId}:${issue.issueId}`,identifier=`${issue.teamId}:${issue.identifier}`;if(`${identity}:${issue.identifier}`.length>256||seenIds.has(identity)||seenIdentifiers.has(identifier))return errorResult({schemaVersion:1,source:"linear",code:"MALFORMED_SOURCE",retriable:false});seenIds.add(identity);seenIdentifiers.add(identifier);issues.push(issue);if(issues.length>MAX_PROVIDER_RECORDS)return errorResult({schemaVersion:1,source:"linear",code:"OVERSIZED_SOURCE",retriable:false});}
        cursor=reply.nextCursor;if(cursor===null)break;if(seenCursors.has(cursor))return errorResult({schemaVersion:1,source:"linear",code:"MALFORMED_SOURCE",retriable:false});seenCursors.add(cursor);if(page===MAX_PROVIDER_PAGES-1)return errorResult({schemaVersion:1,source:"linear",code:"OVERSIZED_SOURCE",retriable:false});
      }
      const sourceUpdatedAt=issues.map((issue)=>issue.updatedAt).sort((left,right)=>Temporal.Instant.compare(right,left))[0]??input.fetchedAt,freshness=sourceFreshness(input.fetchedAt,sourceUpdatedAt),rule=input.estimateRule;
      const tasks=await Promise.all(issues.sort((left,right)=>Temporal.Instant.compare(left.updatedAt,right.updatedAt)||left.identifier.localeCompare(right.identifier)).map(async(issue)=>freezeTask(normalizedTaskV1Schema.parse({
        schemaVersion:1,id:await uuidV5(["urn:capacity-scheduling:linear:v1",issue.teamId,issue.issueId]),source:"linear",sourceEntityId:`${issue.teamId}:${issue.issueId}:${issue.identifier}`,
        title:issue.title,state:issue.state,durationMinutes:rule&&issue.estimate&&issue.estimate<=rule.maximumPoints?issue.estimate*rule.minutesPerPoint:null,deadlineAt:issue.dueDate,priority:issue.priority,projectRef:issue.cycle,labels:[],immutable:true,
        provenance:{schemaVersion:1,source:"linear",sourceEntityId:`${issue.teamId}:${issue.issueId}:${issue.identifier}`,consentRevision:input.consentRevision,freshness,importedAt:input.fetchedAt},
      }))));
      return Object.freeze({ok:true as const,tasks:Object.freeze(tasks),freshness});
    }catch(error){if(error instanceof AdapterBoundaryError)return errorResult({schemaVersion:1,source:"linear",code:error.code,retriable:false});return errorResult({schemaVersion:1,source:"linear",code:"MALFORMED_SOURCE",retriable:false});}
  }
}
