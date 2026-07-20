import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/connectors/github/issues.json";
import { ConnectorRegistry, type ConnectorManifest, type ReadClock } from "../../../src/application/connectors";
import { GitHubTaskAdapter, githubConnectorManifest } from "../../../src/adapters/github";

const fetchedAt="2026-07-23T15:00:00Z",freshness={schemaVersion:1 as const,fetchedAt,sourceUpdatedAt:fetchedAt,expiresAt:"2026-07-24T15:00:00Z",state:"fresh" as const};
const manifest=():ConnectorManifest=>githubConnectorManifest(1,freshness);
const clock=():ReadClock=>({now:()=>0,sleep:async()=>undefined,withTimeout:async(operation)=>operation});
type Forbidden<T> = Extract<keyof T,"create"|"update"|"complete"|"comment"|"delete"|"request"|"mutate">;
const compileTimeReadOnly:Forbidden<GitHubTaskAdapter> extends never?true:false=true;void compileTimeReadOnly;

describe("GitHubTaskAdapter",()=>{
  it("has an exact read-only capability/type/runtime surface",()=>{
    expect(manifest()).toEqual({schemaVersion:1,source:"github",mode:"github-app",capabilities:["task.connect","task.read","task.sync","task.revoke"],consentRevision:1,freshness});
    let calls=0;const adapter=new GitHubTaskAdapter(new ConnectorRegistry([manifest()]),{readPage:async()=>{calls+=1;return{status:200,value:{items:[],nextCursor:null}};}},clock());
    for(const method of ["create","update","complete","comment","delete","request","mutate"])expect(Reflect.get(adapter,method)).toBeUndefined();
    expect(()=>Reflect.get(adapter,"update")()).toThrow(TypeError);expect(calls).toBe(0);
  });

  it("normalizes exact pages into stable immutable tasks and discards assignee identities",async()=>{
    const calls:(string|null)[]=[],adapter=new GitHubTaskAdapter(new ConnectorRegistry([manifest()]),{readPage:async(cursor)=>{calls.push(cursor);return{status:200,value:fixture.pages[cursor===null?0:1]};}},clock());
    const result=await adapter.sync({consentRevision:1,fetchedAt});expect(result.ok).toBe(true);if(!result.ok)return;
    expect(calls).toEqual([null,"github-page-2"]);
    expect(result.tasks.map((task)=>task.provenance.sourceEntityId)).toEqual(["9001:alphazede/window-demo#7","9001:alphazede/window-demo#42"]);
    expect(result.tasks.map((task)=>task.id)).toEqual(["6bb58e33-696d-55db-bb8b-08ab74fa77f3","63426337-168c-54fa-9a1d-a037c85aa969"]);
    expect(result.tasks[1]).toMatchObject({source:"github",title:"Review imported follow-up",state:"open",durationMinutes:null,deadlineAt:null,priority:null,projectRef:"capacity-project",labels:["backend","scheduler"],immutable:true,provenance:{consentRevision:1,freshness:{sourceUpdatedAt:"2026-07-22T18:00:00Z",expiresAt:"2026-07-24T15:00:00Z"}}});
    expect(Object.isFrozen(result.tasks)).toBe(true);expect(Object.isFrozen(result.tasks[1])).toBe(true);expect(Object.isFrozen(result.tasks[1]!.provenance)).toBe(true);expect(Object.isFrozen(result.tasks[1]!.labels)).toBe(true);
    const serialized=JSON.stringify(result);expect(serialized).not.toMatch(/private-user|assigneeIds/);
    const permuted=await new GitHubTaskAdapter(new ConnectorRegistry([manifest()]),{readPage:async()=>({status:200,value:{items:[fixture.pages[1]!.items[0],fixture.pages[0]!.items[0]],nextCursor:null}})},clock()).sync({consentRevision:1,fetchedAt});
    expect(permuted).toEqual(result);
  });

  it("rejects hostile fields, duplicate identities, page/cursor loops, and response-byte overflow without partial output",async()=>{
    const registry=new ConnectorRegistry([manifest()]),base=fixture.pages[0]!.items[0]!;
    const sync=async(value:unknown)=>new GitHubTaskAdapter(registry,{readPage:async()=>({status:200,value})},clock()).sync({consentRevision:1,fetchedAt});
    for(const value of [
      {...fixture.pages[1],extra:true},
      {items:[{...base,extra:true}],nextCursor:null},
      {items:[base,base],nextCursor:null},
      {items:Array.from({length:101},()=>base),nextCursor:null},
      {items:[],nextCursor:"x".repeat(101)},
    ])await expect(sync(value)).resolves.toMatchObject({ok:false,error:{code:"MALFORMED_SOURCE"}});

    let calls=0;const loop=new GitHubTaskAdapter(registry,{readPage:async()=>{calls+=1;return{status:200,value:{items:[],nextCursor:"same"}};}},clock());
    await expect(loop.sync({consentRevision:1,fetchedAt})).resolves.toMatchObject({ok:false,error:{code:"MALFORMED_SOURCE"}});expect(calls).toBe(2);
    calls=0;const pages=new GitHubTaskAdapter(registry,{readPage:async()=>({status:200,value:{items:[],nextCursor:`page-${++calls}`}})},clock());
    await expect(pages.sync({consentRevision:1,fetchedAt})).resolves.toMatchObject({ok:false,error:{code:"OVERSIZED_SOURCE"}});expect(calls).toBe(20);
    const large={items:Array.from({length:100},(_,index)=>({...base,issueNumber:index+1,labels:Array.from({length:100},()=>"x".repeat(512))})),nextCursor:null};
    await expect(sync(large)).resolves.toMatchObject({ok:false,error:{code:"OVERSIZED_SOURCE"}});
  });

  it("enforces consent before reads and shares one retry/timeout-abort budget",async()=>{
    let calls=0;const registry=new ConnectorRegistry([manifest()]);
    const denied=new GitHubTaskAdapter(registry,{readPage:async()=>{calls+=1;return{status:200,value:{items:[],nextCursor:null}};}},clock());
    await expect(denied.sync({consentRevision:2,fetchedAt})).resolves.toMatchObject({ok:false,error:{code:"SCOPE_DENIED"}});expect(calls).toBe(0);
    calls=0;const retry=new GitHubTaskAdapter(registry,{readPage:async()=>++calls===1?{status:503}:{status:200,value:{items:[],nextCursor:null}}},clock());
    await expect(retry.sync({consentRevision:1,fetchedAt})).resolves.toMatchObject({ok:true});expect(calls).toBe(2);
    let aborted=false;const timeout:ReadClock={now:()=>0,sleep:async()=>undefined,withTimeout:async(_operation,_ms,onTimeout)=>{onTimeout();throw new Error("timeout");}};
    const hanging=new GitHubTaskAdapter(registry,{readPage:async(_cursor,signal)=>{signal.addEventListener("abort",()=>{aborted=true;});return new Promise(()=>undefined);}},timeout);
    await expect(hanging.sync({consentRevision:1,fetchedAt})).resolves.toMatchObject({ok:false,error:{code:"PROVIDER_UNAVAILABLE"}});expect(aborted).toBe(true);
  });
});
