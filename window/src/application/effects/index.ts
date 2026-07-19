export type EffectIntent=Readonly<{effectId:string;proposalId:string;marker:string;provider:"google-calendar"}>;
export type UnknownReason="timeout"|"connection-lost"|"malformed-response";
export type ProviderReply=Readonly<{outcome:"succeeded";marker:string;providerEntityId:string}>|Readonly<{outcome:"timeout"|"connection-lost"|"malformed"}>;
export type ReconcileReply=Readonly<{outcome:"found";providerEntityId:string}>|Readonly<{outcome:"absent"}>|Readonly<{outcome:"unknown";reason:UnknownReason}>;
export type GoogleCalendarEffectPort=Readonly<{provider:"google-calendar";execute(intent:EffectIntent):Promise<ProviderReply>;reconcile(effectId:string,marker:string):Promise<ReconcileReply>}>;
export type EffectStatus="effect-pending"|"attempted"|"succeeded"|"unknown"|"reconciliation-found"|"confirmed-absent"|"retry-authorized"|"retry-completed";
export type EffectTransition=Readonly<{status:EffectStatus;attempts:number;reason:UnknownReason|null;providerEntityId:string|null}>;
export type EffectState=Readonly<{effectId:string;proposalId:string;marker:string;provider:"google-calendar";status:EffectStatus;attempts:number;retryAuthorized:boolean;unknownReason:UnknownReason|null;providerEntityId:string|null;history:readonly EffectTransition[]}>;
export type EffectResult=Readonly<{state:EffectState;providerCalled:boolean}>;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reasons=new Set<UnknownReason>(["timeout","connection-lost","malformed-response"]),statuses=new Set<EffectStatus>(["effect-pending","attempted","succeeded","unknown","reconciliation-found","confirmed-absent","retry-authorized","retry-completed"]);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const exact=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).sort().join()===[...keys].sort().join();
const uuid=(value:unknown):value is string=>typeof value==="string"&&UUID.test(value);
const text=(value:unknown,max=256):value is string=>typeof value==="string"&&value.length>0&&value.length<=max;
const attempt=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&value<=2;
const validIntent=(value:unknown):value is EffectIntent=>plain(value)&&exact(value,["effectId","proposalId","marker","provider"])&&uuid(value.effectId)&&uuid(value.proposalId)&&value.marker===`capacity-effect:${value.effectId}`&&value.provider==="google-calendar";
const validTransition=(value:unknown):value is EffectTransition=>plain(value)&&exact(value,["status","attempts","reason","providerEntityId"])&&statuses.has(value.status as EffectStatus)&&attempt(value.attempts)&&(value.reason===null||reasons.has(value.reason as UnknownReason))&&(value.providerEntityId===null||text(value.providerEntityId));
const validHistory=(history:readonly EffectTransition[])=>{
  const first=history[0];if(!first||first.status!=="effect-pending"||first.attempts!==0||first.reason!==null||first.providerEntityId!==null)return false;
  for(let index=1;index<history.length;index+=1){
    const previous=history[index-1]!,current=history[index]!;
    const valid=
      previous.status==="effect-pending"&&current.status==="attempted"&&current.attempts===1&&current.reason===null&&current.providerEntityId===null||
      previous.status==="attempted"&&previous.attempts===1&&current.status==="succeeded"&&current.attempts===1&&current.reason===null&&text(current.providerEntityId)||
      previous.status==="attempted"&&(current.status==="unknown"&&current.attempts===previous.attempts&&!!current.reason&&current.providerEntityId===null||previous.attempts===2&&current.status==="retry-completed"&&current.attempts===2&&current.reason===null&&text(current.providerEntityId))||
      previous.status==="unknown"&&(current.status==="unknown"&&current.attempts===previous.attempts&&!!current.reason&&current.providerEntityId===null||current.status==="reconciliation-found"&&current.attempts===previous.attempts&&current.reason===null&&text(current.providerEntityId)||current.status==="confirmed-absent"&&current.attempts===previous.attempts&&current.reason===null&&current.providerEntityId===null)||
      previous.status==="confirmed-absent"&&previous.attempts===1&&current.status==="retry-authorized"&&current.attempts===1&&current.reason===null&&current.providerEntityId===null||
      previous.status==="retry-authorized"&&current.status==="attempted"&&current.attempts===2&&current.reason===null&&current.providerEntityId===null;
    if(!valid)return false;
  }
  return true;
};
const validState=(value:unknown):value is EffectState=>{
  if(!plain(value)||!exact(value,["effectId","proposalId","marker","provider","status","attempts","retryAuthorized","unknownReason","providerEntityId","history"])||!validIntent({effectId:value.effectId,proposalId:value.proposalId,marker:value.marker,provider:value.provider})||!statuses.has(value.status as EffectStatus)||!attempt(value.attempts)||typeof value.retryAuthorized!=="boolean"||(value.unknownReason!==null&&!reasons.has(value.unknownReason as UnknownReason))||(value.providerEntityId!==null&&!text(value.providerEntityId))||!Array.isArray(value.history)||value.history.length<1||value.history.length>12||value.history.some((item)=>!validTransition(item)))return false;
  const history=value.history as readonly EffectTransition[],last=history.at(-1)!;if(!validHistory(history)||history.some((item)=>item.status==="retry-authorized")!==value.retryAuthorized||last.status!==value.status||last.attempts!==value.attempts||last.reason!==value.unknownReason||last.providerEntityId!==value.providerEntityId)return false;
  if(value.status==="effect-pending")return value.attempts===0&&!value.retryAuthorized&&value.unknownReason===null&&value.providerEntityId===null;
  if(value.status==="attempted")return (value.attempts===1&&!value.retryAuthorized||value.attempts===2&&value.retryAuthorized)&&value.unknownReason===null&&value.providerEntityId===null;
  if(value.status==="succeeded")return value.attempts===1&&!value.retryAuthorized&&value.unknownReason===null&&text(value.providerEntityId);
  if(value.status==="retry-completed")return value.attempts===2&&value.retryAuthorized&&value.unknownReason===null&&text(value.providerEntityId);
  if(value.status==="unknown")return (value.attempts===1||value.attempts===2)&&!!value.unknownReason&&value.providerEntityId===null&&(value.attempts===1||value.retryAuthorized);
  if(value.status==="retry-authorized")return value.attempts===1&&value.retryAuthorized&&value.unknownReason===null&&value.providerEntityId===null;
  if(value.status==="reconciliation-found")return value.attempts>=1&&value.unknownReason===null&&text(value.providerEntityId);
  return value.status==="confirmed-absent"&&value.attempts>=1&&value.unknownReason===null&&value.providerEntityId===null;
};
export const isEffectState=(value:unknown):value is EffectState=>validState(value);
const transition=(state:EffectState,status:EffectStatus,changes:Partial<Pick<EffectState,"attempts"|"retryAuthorized"|"unknownReason"|"providerEntityId">>={}):EffectState=>{
  const next={...state,...changes,status},entry:EffectTransition={status,attempts:next.attempts,reason:next.unknownReason,providerEntityId:next.providerEntityId};
  return Object.freeze({...next,history:Object.freeze([...state.history,Object.freeze(entry)])});
};
const blocked=(state:EffectState):EffectResult=>({state,providerCalled:false});
const agreement=(intent:EffectIntent,state:EffectState)=>validIntent(intent)&&validState(state)&&intent.effectId===state.effectId&&intent.proposalId===state.proposalId&&intent.marker===state.marker&&intent.provider===state.provider;
const unknown=(state:EffectState,reason:UnknownReason):EffectResult=>({state:transition(state,"unknown",{unknownReason:reason,providerEntityId:null}),providerCalled:true});

export const createEffectState=(intent:EffectIntent):EffectState=>{
  if(!validIntent(intent))throw new RangeError("INVALID_EFFECT_INTENT");
  const entry:EffectTransition={status:"effect-pending",attempts:0,reason:null,providerEntityId:null};
  return Object.freeze({...intent,status:"effect-pending",attempts:0,retryAuthorized:false,unknownReason:null,providerEntityId:null,history:Object.freeze([Object.freeze(entry)])});
};
export const authorizeRetry=(intent:EffectIntent,state:EffectState):EffectResult=>agreement(intent,state)&&state.status==="confirmed-absent"&&state.attempts===1&&!state.retryAuthorized?{state:transition(state,"retry-authorized",{retryAuthorized:true}),providerCalled:false}:blocked(state);

export class EffectRunner{
  constructor(private readonly port:GoogleCalendarEffectPort){if(!port||port.provider!=="google-calendar"||typeof port.execute!=="function"||typeof port.reconcile!=="function")throw new RangeError("UNSUPPORTED_PROVIDER");}
  async execute(intent:EffectIntent,state:EffectState):Promise<EffectResult>{
    if(!agreement(intent,state)||state.status!=="effect-pending"&&state.status!=="retry-authorized")return blocked(state);
    const attempted=transition(state,"attempted",{attempts:state.attempts+1,unknownReason:null,providerEntityId:null});
    let reply:ProviderReply;try{reply=await this.port.execute(intent);}catch{return unknown(attempted,"connection-lost");}
    if(!plain(reply)||typeof reply.outcome!=="string")return unknown(attempted,"malformed-response");
    if(reply.outcome==="timeout"&&exact(reply,["outcome"]))return unknown(attempted,"timeout");
    if(reply.outcome==="connection-lost"&&exact(reply,["outcome"]))return unknown(attempted,"connection-lost");
    if(reply.outcome!=="succeeded"||!exact(reply,["outcome","marker","providerEntityId"])||reply.marker!==intent.marker||!text(reply.providerEntityId))return unknown(attempted,"malformed-response");
    return {state:transition(attempted,state.status==="retry-authorized"?"retry-completed":"succeeded",{unknownReason:null,providerEntityId:reply.providerEntityId}),providerCalled:true};
  }
  async reconcile(intent:EffectIntent,state:EffectState):Promise<EffectResult>{
    if(!agreement(intent,state)||state.status!=="unknown")return blocked(state);
    let reply:ReconcileReply;try{reply=await this.port.reconcile(state.effectId,state.marker);}catch{return unknown(state,"connection-lost");}
    if(!plain(reply)||typeof reply.outcome!=="string")return unknown(state,"malformed-response");
    if(reply.outcome==="found"&&exact(reply,["outcome","providerEntityId"])&&text(reply.providerEntityId))return {state:transition(state,"reconciliation-found",{unknownReason:null,providerEntityId:reply.providerEntityId}),providerCalled:true};
    if(reply.outcome==="absent"&&exact(reply,["outcome"]))return {state:transition(state,"confirmed-absent",{unknownReason:null,providerEntityId:null}),providerCalled:true};
    if(reply.outcome==="unknown"&&exact(reply,["outcome","reason"])&&reasons.has(reply.reason))return unknown(state,reply.reason);
    return unknown(state,"malformed-response");
  }
}

export class FakeGoogleCalendarPort implements GoogleCalendarEffectPort{
  readonly provider="google-calendar" as const;readonly transcript:string[]=[];executeCount=0;reconcileCount=0;
  private readonly replies:(ProviderReply|Error)[];private readonly reconciliations:(ReconcileReply|Error)[];
  constructor(replies:readonly (ProviderReply|Error)[]=[],reconciliations:readonly (ReconcileReply|Error)[]=[]){this.replies=[...replies];this.reconciliations=[...reconciliations];}
  async execute(intent:EffectIntent):Promise<ProviderReply>{void intent;this.executeCount+=1;this.transcript.push("execute");const reply=this.replies.shift()??{outcome:"malformed"};if(reply instanceof Error)throw reply;return reply;}
  async reconcile(effectId:string,marker:string):Promise<ReconcileReply>{void effectId;void marker;this.reconcileCount+=1;this.transcript.push("reconcile");const reply=this.reconciliations.shift()??{outcome:"unknown",reason:"malformed-response"};if(reply instanceof Error)throw reply;return reply;}
}
