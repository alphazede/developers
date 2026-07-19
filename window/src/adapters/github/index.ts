import { Temporal } from "@js-temporal/polyfill";

import { executeBoundedRead, systemReadClock, type AdapterError, type ConnectorCapability, type ConnectorManifest, type ConnectorRegistry, type ReadClock, type ReadReply } from "../../application/connectors";
import { normalizedTaskV1Schema, type FreshnessV1, type NormalizedTaskV1 } from "../../contracts/v1";
import { uuidV5 } from "../../domain/schedule";
import { AdapterBoundaryError, MAX_PROVIDER_BYTES, MAX_PROVIDER_PAGES, MAX_PROVIDER_RECORDS, MAX_PROVIDER_RECORDS_PER_PAGE, adapterFailure, boundedCursor, boundedProviderText, exactObject } from "../shared";

export type GitHubReadPort=Readonly<{readPage(cursor:string|null,signal:AbortSignal):Promise<ReadReply<unknown>>}>;
type RawIssue=Readonly<{installationId:number;repositoryFullName:string;issueNumber:number;title:string;state:string;labels:readonly string[];milestone:string|null;projectReference:string|null;updatedAt:string}>;
const REPOSITORY=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const canonicalInstant=(value:unknown):value is string=>{if(typeof value!=="string"||value.length>40||!value.endsWith("Z"))return false;try{return Temporal.Instant.from(value).toString()===value;}catch{return false;}};
const errorResult=(error:AdapterError)=>Object.freeze({ok:false as const,error});
const isAdapterError=(value:unknown):value is AdapterError=>!!value&&typeof value==="object"&&"code" in value&&"source" in value;
const sourceFreshness=(fetchedAt:string,sourceUpdatedAt:string):FreshnessV1=>Object.freeze({schemaVersion:1,fetchedAt,sourceUpdatedAt,expiresAt:Temporal.Instant.from(fetchedAt).add({hours:24}).toString(),state:"fresh"});
const freezeTask=(task:NormalizedTaskV1):NormalizedTaskV1=>{const labels=[...task.labels],freshness={...task.provenance.freshness},provenance={...task.provenance,freshness},result={...task,labels,provenance};Object.freeze(labels);Object.freeze(freshness);Object.freeze(provenance);Object.freeze(result);return result;};

export const githubConnectorManifest=(consentRevision:number,freshness:FreshnessV1):ConnectorManifest=>{const capabilities:ConnectorCapability[]=["task.connect","task.read","task.sync","task.revoke"],value={...freshness};Object.freeze(capabilities);Object.freeze(value);return Object.freeze({schemaVersion:1,source:"github",mode:"github-app",capabilities,consentRevision,freshness:value});};

const parseIssue=(value:unknown):RawIssue=>{
  if(!exactObject(value,["installationId","repositoryFullName","issueNumber","title","state","labels","milestone","assigneeIds","projectReference","updatedAt"])
    ||!Number.isSafeInteger(value.installationId)||Number(value.installationId)<=0
    ||!boundedProviderText(value.repositoryFullName,256)||!REPOSITORY.test(value.repositoryFullName)
    ||!Number.isSafeInteger(value.issueNumber)||Number(value.issueNumber)<=0||Number(value.issueNumber)>1_000_000_000
    ||!boundedProviderText(value.title)||!boundedProviderText(value.state,128)
    ||!Array.isArray(value.labels)||value.labels.length>100||value.labels.some((label)=>!boundedProviderText(label,128))
    ||(value.milestone!==null&&!boundedProviderText(value.milestone,256))
    ||!Array.isArray(value.assigneeIds)||value.assigneeIds.length>100||value.assigneeIds.some((id)=>!boundedProviderText(id,256))
    ||(value.projectReference!==null&&!boundedProviderText(value.projectReference,256))
    ||!canonicalInstant(value.updatedAt))return adapterFailure("github","MALFORMED_SOURCE");
  const {installationId,repositoryFullName,issueNumber,title,state,labels,milestone,projectReference,updatedAt}=value;
  return {installationId:Number(installationId),repositoryFullName,issueNumber:Number(issueNumber),title,state,labels:[...labels],milestone,projectReference,updatedAt};
};

export class GitHubTaskAdapter{
  constructor(private readonly registry:ConnectorRegistry,private readonly read:GitHubReadPort,private readonly clock:ReadClock=systemReadClock){}
  async sync(input:Readonly<{consentRevision:number;fetchedAt:string}>):Promise<Readonly<{ok:true;tasks:readonly NormalizedTaskV1[];freshness:FreshnessV1}>|Readonly<{ok:false;error:AdapterError}>>{
    if(!exactObject(input,["consentRevision","fetchedAt"])||!Number.isSafeInteger(input.consentRevision)||input.consentRevision<0||!canonicalInstant(input.fetchedAt))return errorResult({schemaVersion:1,source:"github",code:"MALFORMED_SOURCE",retriable:false});
    const denied=this.registry.require("github","task.sync",input.consentRevision);if(denied)return errorResult(denied);
    const started=this.clock.now(),seenCursors=new Set<string>(),seenIdentities=new Set<string>();let cursor:string|null=null,totalBytes=0;const issues:RawIssue[]=[];
    try{
      for(let page=0;page<MAX_PROVIDER_PAGES;page+=1){
        const remaining=20_000-(this.clock.now()-started);if(remaining<=0)return errorResult({schemaVersion:1,source:"github",code:"PROVIDER_UNAVAILABLE",retriable:true});
        const reply=await executeBoundedRead("github",this.clock,(_attempt,signal)=>this.read.readPage(cursor,signal),remaining);if(isAdapterError(reply))return errorResult(reply);
        totalBytes+=Buffer.byteLength(JSON.stringify(reply));if(totalBytes>MAX_PROVIDER_BYTES)return errorResult({schemaVersion:1,source:"github",code:"OVERSIZED_SOURCE",retriable:false});
        if(!exactObject(reply,["items","nextCursor"])||!Array.isArray(reply.items)||reply.items.length>MAX_PROVIDER_RECORDS_PER_PAGE||!boundedCursor(reply.nextCursor))return errorResult({schemaVersion:1,source:"github",code:"MALFORMED_SOURCE",retriable:false});
        for(const value of reply.items){const issue=parseIssue(value),identity=`${issue.installationId}:${issue.repositoryFullName}#${issue.issueNumber}`;if(identity.length>256||seenIdentities.has(identity))return errorResult({schemaVersion:1,source:"github",code:"MALFORMED_SOURCE",retriable:false});seenIdentities.add(identity);issues.push(issue);if(issues.length>MAX_PROVIDER_RECORDS)return errorResult({schemaVersion:1,source:"github",code:"OVERSIZED_SOURCE",retriable:false});}
        cursor=reply.nextCursor;if(cursor===null)break;if(seenCursors.has(cursor))return errorResult({schemaVersion:1,source:"github",code:"MALFORMED_SOURCE",retriable:false});seenCursors.add(cursor);if(page===MAX_PROVIDER_PAGES-1)return errorResult({schemaVersion:1,source:"github",code:"OVERSIZED_SOURCE",retriable:false});
      }
      const sourceUpdatedAt=issues.map((issue)=>issue.updatedAt).sort((left,right)=>Temporal.Instant.compare(right,left))[0]??input.fetchedAt,freshness=sourceFreshness(input.fetchedAt,sourceUpdatedAt);
      const tasks=await Promise.all(issues.sort((left,right)=>Temporal.Instant.compare(left.updatedAt,right.updatedAt)||left.issueNumber-right.issueNumber||left.repositoryFullName.localeCompare(right.repositoryFullName)).map(async(issue)=>freezeTask(normalizedTaskV1Schema.parse({
        schemaVersion:1,id:await uuidV5(["urn:capacity-scheduling:github:v1",String(issue.installationId),issue.repositoryFullName,String(issue.issueNumber)]),source:"github",sourceEntityId:`${issue.installationId}:${issue.repositoryFullName}#${issue.issueNumber}`,
        title:issue.title,state:issue.state,durationMinutes:null,deadlineAt:null,priority:null,projectRef:issue.projectReference??issue.milestone,labels:[...new Set(issue.labels)].sort(),immutable:true,
        provenance:{schemaVersion:1,source:"github",sourceEntityId:`${issue.installationId}:${issue.repositoryFullName}#${issue.issueNumber}`,consentRevision:input.consentRevision,freshness,importedAt:input.fetchedAt},
      }))));
      return Object.freeze({ok:true as const,tasks:Object.freeze(tasks),freshness});
    }catch(error){if(error instanceof AdapterBoundaryError)return errorResult({schemaVersion:1,source:"github",code:error.code,retriable:false});return errorResult({schemaVersion:1,source:"github",code:"MALFORMED_SOURCE",retriable:false});}
  }
}
