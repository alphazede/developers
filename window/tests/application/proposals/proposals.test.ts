import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approveProposal, createProposalState, type ApprovalCommand, type ProposalState } from "../../../src/application/proposals";
import type { Candidate } from "../../../src/domain/schedule";

const proposalId="11111111-1111-4111-8111-111111111111",requestHash="a".repeat(64);
const candidate:Candidate={id:proposalId,requestHash,taskId:"task-a",startAt:"2026-07-23T12:00:00Z",endAt:"2026-07-23T12:30:00Z",score:70,breakdown:{capacityFit:40,deadlineUrgency:10,goalAlignment:8,contextSwitch:5,recoverySupport:7},confidence:0.9,limitations:[]};
const command=(changes:Partial<ApprovalCommand>={}):ApprovalCommand=>({commandId:"command-a",idempotencyKey:"key-a",expectedRevision:0,sourceRevision:2,proposalId,previewHash:requestHash,approved:true,googleCalendar:{consent:true,capability:true},...changes});
const uuidV5=(parts:readonly string[])=>{const namespace=Buffer.from("6ba7b8119dad11d180b400c04fd430c8","hex"),value=createHash("sha1").update(Buffer.concat([namespace,Buffer.from(JSON.stringify(parts))])).digest().subarray(0,16);value[6]=(value[6]!&15)|80;value[8]=(value[8]!&63)|128;const hex=value.toString("hex");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;};

describe("ProposalService",()=>{
  it("rejects malformed candidates at creation",()=>{
    const malformed:Candidate[]=[
      {...candidate,id:"not-a-uuid"},
      {...candidate,requestHash:"A".repeat(64)},
      {...candidate,startAt:"2026-07-23T12:00:00.000Z"},
      {...candidate,endAt:candidate.startAt},
      {...candidate,score:69},
      {...candidate,breakdown:{...candidate.breakdown,capacityFit:41}},
      {...candidate,confidence:2},
      {...candidate,confidence:null},
      {...candidate,limitations:[""]},
    ];
    for(const value of malformed)expect(()=>createProposalState(2,[value])).toThrow("INVALID_PROPOSAL_STATE");
    expect(()=>createProposalState(-1,[candidate])).toThrow("INVALID_PROPOSAL_STATE");
    expect(()=>createProposalState(2,[candidate,candidate])).toThrow("INVALID_PROPOSAL_STATE");
  });

  it("copies immutable previews and issues one standard stable UUIDv5 effect",async()=>{
    const state=createProposalState(2,[candidate]);expect(Object.isFrozen(state)).toBe(true);expect(Object.isFrozen(state.proposals[0]?.candidate.breakdown)).toBe(true);
    const first=await approveProposal(state,command());expect(first.ok).toBe(true);if(!first.ok)return;
    const expected=uuidV5(["urn:capacity-scheduling:effect:v1",proposalId,requestHash]);
    expect(first.effectIntent).toEqual({effectId:expected,proposalId,marker:`capacity-effect:${expected}`,provider:"google-calendar"});
    expect(first.receipt.effectId).toBe(expected);expect(first.state).not.toBe(state);expect(state.proposals[0]?.status).toBe("preview");
    const duplicate=await approveProposal(first.state,command());expect(duplicate).toEqual({ok:true,state:first.state,receipt:first.receipt});
    expect(duplicate.ok&&"effectIntent" in duplicate).toBe(false);
  });

  it("treats command and idempotency key as independent conflict identities",async()=>{
    const first=await approveProposal(createProposalState(2,[candidate]),command());expect(first.ok).toBe(true);if(!first.ok)return;
    expect(await approveProposal(first.state,command({idempotencyKey:"changed"}))).toMatchObject({ok:false,code:"idempotency-conflict"});
    expect(await approveProposal(first.state,command({commandId:"changed"}))).toMatchObject({ok:false,code:"idempotency-conflict"});
    expect(await approveProposal(first.state,command({commandId:"other",idempotencyKey:"other",expectedRevision:1}))).toMatchObject({ok:false,code:"proposal-not-preview"});
  });

  it("accepts the exact reachable revision sequence for separate previews",async()=>{
    const second:Candidate={...candidate,id:"33333333-3333-4333-8333-333333333333",requestHash:"b".repeat(64),taskId:"task-b"};
    const first=await approveProposal(createProposalState(2,[candidate,second]),command());expect(first.ok).toBe(true);if(!first.ok)return;
    const secondCommand=command({commandId:"command-b",idempotencyKey:"key-b",expectedRevision:1,proposalId:second.id,previewHash:second.requestHash});
    const approved=await approveProposal(first.state,secondCommand);expect(approved.ok).toBe(true);if(!approved.ok)return;
    expect(approved.state).toMatchObject({revision:2,proposals:[{revision:1,status:"effect-pending"},{revision:1,status:"effect-pending"}]});
    expect(await approveProposal(approved.state,secondCommand)).toEqual({ok:true,state:approved.state,receipt:approved.receipt});
  });

  it("fails closed for false, stringly, revoked, unsupported, stale, altered, and unknown commands",async()=>{
    const state=createProposalState(2,[candidate]);
    const cases:[unknown,string][]=[
      [{...command(),approved:false},"approval-required"],
      [{...command(),approved:"true"},"invalid-command"],
      [{...command(),googleCalendar:{consent:false,capability:true}},"google-calendar-unavailable"],
      [{...command(),googleCalendar:{consent:true,capability:false}},"google-calendar-unavailable"],
      [{...command(),expectedRevision:1},"stale-revision"],
      [{...command(),sourceRevision:3},"stale-revision"],
      [{...command(),previewHash:"b".repeat(64)},"altered-preview"],
      [{...command(),proposalId:"22222222-2222-4222-8222-222222222222"},"unknown-proposal"],
      [{...command(),commandId:""},"invalid-command"],
      [{...command(),expectedRevision:1.5},"invalid-command"],
      [{...command(),googleCalendar:{consent:true,capability:true,extra:true}},"invalid-command"],
    ];
    for(const [value,code] of cases){const result=await approveProposal(state,value as ApprovalCommand);expect(result).toMatchObject({ok:false,code,state});expect("effectIntent" in result).toBe(false);}
  });

  it("rejects adversarial complete-state forgeries without throwing or minting intent",async()=>{
    const state=createProposalState(2,[candidate]);
    const forged:unknown[]=[
      {...state,revision:-1},
      {...state,sourceRevision:"2"},
      {...state,proposals:[{...state.proposals[0]!,status:"effect-pending",effectId:null}]},
      {...state,proposals:[{...state.proposals[0]!,previewHash:"b".repeat(64)}]},
      {...state,proposals:[{...state.proposals[0]!,candidate:{...candidate,score:0}}]},
      {...state,proposals:[state.proposals[0]!,state.proposals[0]!]},
      {...state,receipts:[{commandId:"x",idempotencyKey:"y",fingerprint:"a".repeat(64),receipt:{commandId:"x",idempotencyKey:"y",proposalId,effectId:"22222222-2222-4222-8222-222222222222",status:"effect-pending",revision:1}}]},
      {...state,extra:true},
    ];
    for(const value of forged){await expect(approveProposal(value as ProposalState,command())).resolves.toMatchObject({ok:false,code:"invalid-state"});}
  });

  it("rejects transition-invalid stored approvals before idempotent replay",async()=>{
    const approved=await approveProposal(createProposalState(2,[candidate]),command());expect(approved.ok).toBe(true);if(!approved.ok)return;
    const state=approved.state,proposal=state.proposals[0]!,stored=state.receipts[0]!,otherEffect="33333333-3333-4333-8333-333333333333";
    const forged:ProposalState[]=[
      {...state,revision:0},
      {...state,revision:2},
      {...state,receipts:[{...stored,receipt:{...stored.receipt,revision:999}}]},
      {...state,receipts:[{...stored,receipt:{...stored.receipt,revision:0}}]},
      {...state,proposals:[{...proposal,revision:0}]},
      {...state,proposals:[{...proposal,revision:2}]},
      {...state,proposals:[{...proposal,status:"approved"}]},
      {...state,proposals:[{...proposal,status:"succeeded"}]},
      {...state,proposals:[{...proposal,effectId:otherEffect}],receipts:[{...stored,receipt:{...stored.receipt,effectId:otherEffect}}]},
      {...state,receipts:[{...stored,fingerprint:"b".repeat(64)}]},
      {...state,receipts:[]},
    ];
    for(const value of forged){
      const replay=await approveProposal(value,command());expect(replay).toMatchObject({ok:false,code:"invalid-state"});expect("effectIntent" in replay).toBe(false);
    }
  });
});
