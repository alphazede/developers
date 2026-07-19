import { Temporal } from "@js-temporal/polyfill";
import { uuidV5, type Candidate } from "../../domain/schedule";

export type Proposal = Readonly<{ id:string; sourceRevision:number; revision:number; previewHash:string; candidate:Candidate; status:"preview"|"approved"|"effect-pending"|"succeeded"|"unknown"|"rejected"; effectId:string|null }>;
export type ApprovalCommand = Readonly<{ commandId:string; idempotencyKey:string; expectedRevision:number; sourceRevision:number; proposalId:string; previewHash:string; approved:boolean; googleCalendar:Readonly<{ consent:boolean; capability:boolean }> }>;
export type ApprovalReceipt = Readonly<{ commandId:string; idempotencyKey:string; proposalId:string; effectId:string; status:"effect-pending"; revision:number }>;
type StoredReceipt = Readonly<{ commandId:string; idempotencyKey:string; fingerprint:string; receipt:ApprovalReceipt }>;
export type ProposalState = Readonly<{ revision:number; sourceRevision:number; proposals:readonly Proposal[]; receipts:readonly StoredReceipt[] }>;
export type EffectIntent = Readonly<{ effectId:string; proposalId:string; marker:string; provider:"google-calendar" }>;
export type ApprovalResult = Readonly<{ ok:true; state:ProposalState; receipt:ApprovalReceipt; effectIntent?:EffectIntent }> | Readonly<{ ok:false; state:ProposalState; code:string }>;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, HASH=/^[0-9a-f]{64}$/;
const plain=(value:unknown):value is Record<string,unknown> => !!value&&typeof value==="object"&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const text=(value:unknown,max=128):value is string => typeof value==="string"&&value.length>0&&value.length<=max;
const safe=(value:unknown):value is number => typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const uuid=(value:unknown):value is string => typeof value==="string"&&UUID.test(value);
const hash=(value:unknown):value is string => typeof value==="string"&&HASH.test(value);
const canonicalInstant=(value:unknown):boolean => { if(typeof value!=="string"||value.length>40||!value.endsWith("Z"))return false; try{return Temporal.Instant.from(value).toString()===value;}catch{return false;} };
const exact=(value:Record<string,unknown>,keys:readonly string[]) => Object.keys(value).sort().join() === [...keys].sort().join();
const sha256=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))),(item)=>item.toString(16).padStart(2,"0")).join("");
const bad=(state:ProposalState,code:string):ApprovalResult=>({ok:false,state,code});
const validCandidate=(value:unknown):value is Candidate => {
  if(!plain(value)||!exact(value,["id","requestHash","taskId","startAt","endAt","score","breakdown","confidence","limitations"])||!uuid(value.id)||!hash(value.requestHash)||!text(value.taskId)||!canonicalInstant(value.startAt)||!canonicalInstant(value.endAt)||Temporal.Instant.compare(value.startAt as string,value.endAt as string)>=0||!plain(value.breakdown)||!exact(value.breakdown,["capacityFit","deadlineUrgency","goalAlignment","contextSwitch","recoverySupport"])||!Array.isArray(value.limitations)||value.limitations.length>100||value.limitations.some((item)=>!text(item,512)))return false;
  const breakdown=value.breakdown as Candidate["breakdown"],ranges:[[keyof Candidate["breakdown"],number],[keyof Candidate["breakdown"],number],[keyof Candidate["breakdown"],number],[keyof Candidate["breakdown"],number],[keyof Candidate["breakdown"],number]]=[["capacityFit",40],["deadlineUrgency",25],["goalAlignment",15],["contextSwitch",10],["recoverySupport",10]];
  if(ranges.some(([key,max])=>!Number.isInteger(breakdown[key])||breakdown[key]<0||breakdown[key]>max))return false;
  const score=Object.values(breakdown).reduce((sum,item)=>sum+item,0),confidence=value.confidence;
  return value.score===score&&(confidence===null||typeof confidence==="number"&&Number.isFinite(confidence)&&confidence>=0&&confidence<=1)&&value.limitations.includes("capacity_unknown")===(confidence===null);
};
const validProposal=(value:unknown,sourceRevision:number):value is Proposal => {
  if(!plain(value)||!exact(value,["id","sourceRevision","revision","previewHash","candidate","status","effectId"])||!uuid(value.id)||value.sourceRevision!==sourceRevision||!safe(value.revision)||!hash(value.previewHash)||!validCandidate(value.candidate)||value.id!==value.candidate.id||value.previewHash!==value.candidate.requestHash||!["preview","approved","effect-pending","succeeded","unknown","rejected"].includes(value.status as string))return false;
  return value.status==="preview"||value.status==="rejected" ? value.effectId===null : uuid(value.effectId);
};
const validReceipt=(value:unknown):value is StoredReceipt => {
  if(!plain(value)||!exact(value,["commandId","idempotencyKey","fingerprint","receipt"])||!text(value.commandId)||!text(value.idempotencyKey)||!hash(value.fingerprint)||!plain(value.receipt)||!exact(value.receipt,["commandId","idempotencyKey","proposalId","effectId","status","revision"]))return false;
  const receipt=value.receipt as unknown as ApprovalReceipt; return receipt.commandId===value.commandId&&receipt.idempotencyKey===value.idempotencyKey&&uuid(receipt.proposalId)&&uuid(receipt.effectId)&&receipt.status==="effect-pending"&&safe(receipt.revision);
};
const validState=async(state:unknown):Promise<boolean> => {
  if(!plain(state)||!exact(state,["revision","sourceRevision","proposals","receipts"])||!safe(state.revision)||!safe(state.sourceRevision)||!Array.isArray(state.proposals)||state.proposals.length>3||!Array.isArray(state.receipts)||state.receipts.length>10_000||state.proposals.some((item)=>!validProposal(item,state.sourceRevision as number))||state.receipts.some((item)=>!validReceipt(item)))return false;
  const proposals=state.proposals as readonly Proposal[],receipts=state.receipts as readonly StoredReceipt[];
  if(state.revision!==receipts.length||receipts.length>proposals.length||new Set(proposals.map((item)=>item.id)).size!==proposals.length||new Set(receipts.map((item)=>item.commandId)).size!==receipts.length||new Set(receipts.map((item)=>item.idempotencyKey)).size!==receipts.length||new Set(receipts.map((item)=>item.receipt.effectId)).size!==receipts.length||receipts.some((item,index)=>item.receipt.revision!==index+1))return false;
  for(const proposal of proposals){
    const matching=receipts.filter((item)=>item.receipt.proposalId===proposal.id);
    if(proposal.status==="preview"){if(proposal.revision!==0||proposal.effectId!==null||matching.length!==0)return false;continue;}
    if(proposal.status!=="effect-pending"||proposal.revision!==1||!proposal.effectId||matching.length!==1)return false;
    const stored=matching[0]!,expectedEffect=await uuidV5(["urn:capacity-scheduling:effect:v1",proposal.id,proposal.previewHash]);
    if(proposal.effectId!==expectedEffect||stored.receipt.effectId!==expectedEffect)return false;
    const expectedFingerprint=await commandFingerprint({commandId:stored.commandId,idempotencyKey:stored.idempotencyKey,expectedRevision:stored.receipt.revision-1,sourceRevision:state.sourceRevision as number,proposalId:proposal.id,previewHash:proposal.previewHash,approved:true,googleCalendar:{consent:true,capability:true}});
    if(stored.fingerprint!==expectedFingerprint)return false;
  }
  return true;
};
const validCommand=(value:unknown):value is ApprovalCommand => plain(value)&&exact(value,["commandId","idempotencyKey","expectedRevision","sourceRevision","proposalId","previewHash","approved","googleCalendar"])&&text(value.commandId)&&text(value.idempotencyKey)&&safe(value.expectedRevision)&&safe(value.sourceRevision)&&uuid(value.proposalId)&&hash(value.previewHash)&&typeof value.approved==="boolean"&&plain(value.googleCalendar)&&exact(value.googleCalendar,["consent","capability"])&&typeof value.googleCalendar.consent==="boolean"&&typeof value.googleCalendar.capability==="boolean";
const commandFingerprint=(command:ApprovalCommand)=>sha256(JSON.stringify([command.commandId,command.idempotencyKey,command.expectedRevision,command.sourceRevision,command.proposalId,command.previewHash,command.approved,command.googleCalendar.consent,command.googleCalendar.capability]));

export const createProposalState=(sourceRevision:number,candidates:readonly Candidate[]):ProposalState=>{
  if(!safe(sourceRevision)||!Array.isArray(candidates)||candidates.length>3||candidates.some((item)=>!validCandidate(item))||new Set(candidates.map((item)=>item.id)).size!==candidates.length)throw new RangeError("INVALID_PROPOSAL_STATE");
  const proposals=candidates.map((candidate)=>Object.freeze({id:candidate.id,sourceRevision,revision:0,previewHash:candidate.requestHash,candidate:Object.freeze({...candidate,breakdown:Object.freeze({...candidate.breakdown}),limitations:Object.freeze([...candidate.limitations])}),status:"preview" as const,effectId:null}));
  return Object.freeze({revision:0,sourceRevision,proposals:Object.freeze(proposals),receipts:Object.freeze([])});
};

export const approveProposal=async(state:ProposalState,command:ApprovalCommand):Promise<ApprovalResult>=>{
  if(!await validState(state))return bad(state,"invalid-state");
  if(!validCommand(command))return bad(state,"invalid-command");
  const identity=await commandFingerprint(command),byCommand=state.receipts.find((item)=>item.commandId===command.commandId),byKey=state.receipts.find((item)=>item.idempotencyKey===command.idempotencyKey);
  if(byCommand||byKey)return byCommand&&byKey&&byCommand.fingerprint===identity&&byKey.fingerprint===identity&&byCommand.receipt.effectId===byKey.receipt.effectId?{ok:true,state,receipt:byCommand.receipt}:bad(state,"idempotency-conflict");
  if(!command.approved)return bad(state,"approval-required");
  if(!command.googleCalendar.consent||!command.googleCalendar.capability)return bad(state,"google-calendar-unavailable");
  if(command.expectedRevision!==state.revision||command.sourceRevision!==state.sourceRevision)return bad(state,"stale-revision");
  const proposal=state.proposals.find((item)=>item.id===command.proposalId); if(!proposal)return bad(state,"unknown-proposal");
  if(proposal.previewHash!==command.previewHash)return bad(state,"altered-preview");
  if(proposal.status!=="preview")return bad(state,"proposal-not-preview");
  const id=await uuidV5(["urn:capacity-scheduling:effect:v1",proposal.id,proposal.previewHash]),receipt:ApprovalReceipt={commandId:command.commandId,idempotencyKey:command.idempotencyKey,proposalId:proposal.id,effectId:id,status:"effect-pending",revision:state.revision+1};
  const updated:Proposal={...proposal,revision:proposal.revision+1,status:"effect-pending",effectId:id},stored:StoredReceipt={commandId:command.commandId,idempotencyKey:command.idempotencyKey,fingerprint:identity,receipt};
  const next:ProposalState=Object.freeze({revision:state.revision+1,sourceRevision:state.sourceRevision,proposals:Object.freeze(state.proposals.map((item)=>item.id===proposal.id?Object.freeze(updated):item)),receipts:Object.freeze([...state.receipts,Object.freeze(stored)])});
  return {ok:true,state:next,receipt,effectIntent:{effectId:id,proposalId:proposal.id,marker:`capacity-effect:${id}`,provider:"google-calendar"}};
};
