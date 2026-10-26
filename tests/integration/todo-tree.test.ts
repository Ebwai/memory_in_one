import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CollectionContentService, ConflictService, DomainRegistry, SyncEngine, WorkspaceInitialization } from "@workspace/core";
import { FileExtensionPrograms, HttpSyncRemote, HttpWorkspaceLocation, SqliteLocalStore } from "@workspace/adapters";
import { startWorkspaceServer } from "@workspace/server/initialization";
import { canonical } from "@workspace/contracts";
import type { LocalRecord, WorkspaceIdentity, SyncRemote } from "@workspace/contracts";
import { groupTodoTree, prepareTodoTree, todoDefinition, todoConflictPolicy, todoSubtreeBasis, validateTodoTree } from "@workspace/todo-list";
import type { TodoCommand } from "@workspace/todo-list";

const at="2026-10-26T10:00:00.000Z";
const token="tree-owner-secret-012345678901234567890123";
const policy=(domain:string)=>domain==="builtin.todo"?todoConflictPolicy:domain==="system.domains"?{attributes:{enabled:["enabled"]},validate:()=>undefined}:undefined;
const scope=(identity:WorkspaceIdentity,recordId="parent")=>({workspaceId:identity.workspaceId,domainId:"builtin.todo",recordId});
async function fixture(run:(a:SqliteLocalStore,b:SqliteLocalStore,remote:HttpSyncRemote,identity:WorkspaceIdentity,dir:string)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),"workspace-tree-"));
  const server=await startWorkspaceServer({directory:join(dir,"authority"),token});
  const initialized=await new WorkspaceInitialization(new HttpWorkspaceLocation(server.url,token),randomUUID,()=>at).create({creationId:"tree-create",name:"层级测试"});
  if(initialized.status!=="created")throw new Error("initialization failed");
  const a=await SqliteLocalStore.open({databasePath:join(dir,"a.sqlite")}),b=await SqliteLocalStore.open({databasePath:join(dir,"b.sqlite")});
  try {
    const registry=new DomainRegistry(initialized.workspace.workspaceId,a,new FileExtensionPrograms(join(dir,"programs")));
    await registry.register(todoDefinition,"register");await registry.setEnabled("builtin.todo",true,"enable");
    for(const recordId of ["parent","child","leaf","other"])await a.commit({...scope(initialized.workspace,recordId),operationId:"create-"+recordId,kind:"put",payloadJson:JSON.stringify({text:recordId,completed:false,createdAt:at})},null);
    await run(a,b,new HttpSyncRemote(server.url,token),initialized.workspace,dir);
  } finally {
    await a.close();await b.close();await server.close();
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(dir.split(/[/\\]/).at(-1)?.startsWith("workspace-tree-"));
    await rm(dir,{recursive:true,force:true});
  }
}
async function mutate(store:SqliteLocalStore,identity:WorkspaceIdentity,recordId:string,command:TodoCommand,operationId=randomUUID()) {
  const reference={...scope(identity,recordId),operationId};
  const record=(await store.readRecord(reference))!;
  const signature=createHash("sha256").update(canonical({recordId,command,at})).digest("hex");
  return new CollectionContentService(store).mutate(reference,record.localSequence,signature,rows=>prepareTodoTree(rows,recordId,command,at));
}
async function nested(store:SqliteLocalStore,identity:WorkspaceIdentity) {
  assert.equal((await mutate(store,identity,"child",{kind:"move",targetId:"parent",position:"inside"})).status,"saved-local");
  assert.equal((await mutate(store,identity,"leaf",{kind:"move",targetId:"child",position:"inside"})).status,"saved-local");
}

test("recursive hierarchy, sibling order, completion gate, ancestor restoration and intact subtree moves",async()=>fixture(async(a,_b,_remote,identity)=>{
  await nested(a,identity);
  assert.equal((await mutate(a,identity,"parent",{kind:"complete",completed:true})).status,"not-saved");
  assert.equal((await mutate(a,identity,"parent",{kind:"move",targetId:"leaf",position:"inside"})).status,"not-saved");
  for(const id of ["leaf","child","parent"])assert.equal((await mutate(a,identity,id,{kind:"complete",completed:true})).status,"saved-local");
  let tree=groupTodoTree(await a.listRecords(scope(identity)),"2026-10-26");
  assert.equal(tree.completedRoots,1);assert.equal(tree.completed.length,3);
  assert.equal((await mutate(a,identity,"leaf",{kind:"complete",completed:false})).status,"saved-local");
  tree=groupTodoTree(await a.listRecords(scope(identity)),"2026-10-26");
  assert.equal(tree.completedRoots,0);
  assert.ok(tree.unfinished.filter(r=>["parent","child","leaf"].includes(r.recordId)).every(r=>r.status==="unfinished"));
  await mutate(a,identity,"child",{kind:"move",targetId:"other",position:"inside"});
  assert.equal((await a.readRecord(scope(identity,"leaf")))?.payload?.parentId,"child");
  assert.equal((await a.readRecord(scope(identity,"child")))?.payload?.parentId,"other");
  await mutate(a,identity,"child",{kind:"move",targetId:null,position:"after"});
  assert.equal((await a.readRecord(scope(identity,"child")))?.payload?.parentId,undefined);
  await mutate(a,identity,"other",{kind:"move",targetId:"parent",position:"before"});
  tree=groupTodoTree(await a.listRecords(scope(identity)),"2026-10-26");
  assert.ok(tree.unfinished.findIndex(r=>r.recordId==="other")<tree.unfinished.findIndex(r=>r.recordId==="parent"));
}));

test("deep hierarchy has no fixed depth and completed descendants stay under unfinished parent",()=>{
  const rows:LocalRecord[]=Array.from({length:300},(_,i)=>({workspaceId:"deep",domainId:"builtin.todo",recordId:String(i),localSequence:i+1,deleted:false,
    payload:{text:String(i),completed:i===299,createdAt:at,...(i?{parentId:String(i-1)}:{}),...(i===299?{completedAt:at}:{})}}));
  validateTodoTree(rows.map(r=>({recordId:r.recordId,value:r.payload})));
  const tree=groupTodoTree(rows,"2026-10-26");
  assert.equal(tree.unfinished.length,300);assert.equal(tree.completed.length,0);assert.equal(tree.unfinished.at(-1)?.depth,299);
  assert.equal(tree.unfinished.at(-1)?.status,"completed");
});

test("subtree delete freezes all descendant versions and duplicate retry does not repeat deletion",async()=>fixture(async(a,_b,_r,identity)=>{
  await nested(a,identity);
  const old=todoSubtreeBasis(await a.listRecords(scope(identity)),"parent");
  await mutate(a,identity,"leaf",{kind:"text",text:"changed"});
  assert.equal((await mutate(a,identity,"parent",{kind:"delete",confirmed:true,subtreeBasis:old})).status,"not-saved");
  const basis=todoSubtreeBasis(await a.listRecords(scope(identity)),"parent");
  const reference={...scope(identity),operationId:"delete-tree"},record=(await a.readRecord(reference))!;
  const signature=createHash("sha256").update("delete-tree").digest("hex");
  const service=new CollectionContentService(a);
  const prepare=(rows:readonly LocalRecord[])=>prepareTodoTree(rows,"parent",{kind:"delete",confirmed:true,subtreeBasis:basis},at);
  assert.equal((await service.mutate(reference,record.localSequence,signature,prepare)).status,"saved-local");
  const operations=(await a.listPending(scope(identity))).length;
  assert.equal((await service.mutate(reference,record.localSequence,signature,prepare)).status,"saved-local");
  assert.equal((await a.listPending(scope(identity))).length,operations);
  for(const id of ["parent","child","leaf"])assert.equal((await a.readRecord(scope(identity,id)))?.deleted,true);
  assert.equal((await a.readRecord(scope(identity,"other")))?.deleted,false);
}));

test("failure on a descendant rolls back the whole subtree and its pending operations",async()=>fixture(async(a,_b,_r,identity,dir)=>{
  await nested(a,identity);
  const before=await a.listRecords(scope(identity)),count=(await a.listPending(scope(identity))).length;
  const db=new DatabaseSync(join(dir,"a.sqlite"));
  try {db.exec("CREATE TRIGGER fail_tree BEFORE INSERT ON pending_operations WHEN NEW.kind='delete' AND NEW.record_id='leaf' BEGIN SELECT RAISE(ABORT,'fail'); END");}finally{db.close();}
  const result=await mutate(a,identity,"parent",{kind:"delete",confirmed:true,subtreeBasis:todoSubtreeBasis(before,"parent")});
  assert.equal(result.status,"not-saved");assert.deepEqual(await a.listRecords(scope(identity)),before);
  assert.equal((await a.listPending(scope(identity))).length,count);
}));

test("atomic HTTP sync, lost receipt retry, recursive deletion propagation and single-write authority guard",async()=>fixture(async(a,b,remote,identity)=>{
  const ea=new SyncEngine(identity,a,remote,policy),eb=new SyncEngine(identity,b,remote,policy);
  await ea.run();await eb.run();await nested(a,identity);
  let lost=true;
  const uncertain:SyncRemote={inspect:()=>remote.inspect(),pull:(...args)=>remote.pull(...args),upload:async request=>{
    const result=await remote.upload(request);if(request.batch && lost){lost=false;throw new Error("lost");}return result;
  }};
  await new SyncEngine(identity,a,uncertain,policy).upload();
  await ea.run();await eb.run();
  assert.equal((await a.syncSummary(identity.workspaceId)).pending,0);
  assert.equal((await b.readRecord(scope(identity,"leaf")))?.payload?.parentId,"child");
  const authority=(await remote.pull(identity.workspaceId,identity.authorityId,0)).versions;
  const parent=authority.flatMap(v=>[v,...(v.related??[])]).filter(v=>v.recordId==="parent").at(-1)!;
  const rejected=await remote.upload({...scope(identity),authorityId:identity.authorityId,operationId:"bypass",baseRevision:parent.revision,value:{...parent.value!,completed:true,completedAt:at},changed:["completion"],resolution:false});
  assert.equal(rejected.status,"rejected");
  const basis=todoSubtreeBasis(await a.listRecords(scope(identity)),"parent");
  await mutate(a,identity,"parent",{kind:"delete",confirmed:true,subtreeBasis:basis});
  await ea.run();await eb.run();
  for(const id of ["parent","child","leaf"])assert.equal((await b.readRecord(scope(identity,id)))?.deleted,true);
  assert.equal((await b.readRecord(scope(identity,"other")))?.deleted,false);
  const page=await remote.pull(identity.workspaceId,identity.authorityId,0);
  assert.ok(page.versions.some(v=>v.value===null && v.related?.length===2));
}));

test("subtree delete versus remote child edit resolves as one whole group",async()=>{
  for(const keepDelete of [true,false])await fixture(async(a,b,remote,identity)=>{
    const ea=new SyncEngine(identity,a,remote,policy),eb=new SyncEngine(identity,b,remote,policy);
    await ea.run();await nested(a,identity);await ea.run();await eb.run();
    const rows=await a.listRecords(scope(identity));
    await mutate(a,identity,"parent",{kind:"delete",confirmed:true,subtreeBasis:todoSubtreeBasis(rows,"parent")});
    await mutate(b,identity,"leaf",{kind:"text",text:"另一端子目标编辑"});await eb.run();
    await ea.upload();
    const conflicts=await a.listConflicts(scope(identity));
    assert.equal(conflicts.length,1);const conflict=conflicts[0]!;
    assert.ok(conflict.atomicGroup);assert.equal(conflict.atomicGroup.sequences.length,3);
    await new ConflictService(a,todoConflictPolicy).saveChoice(conflict,conflict.generation,randomUUID(),keepDelete?{kind:"delete"}:{kind:"restore",value:conflict.comparison.remote!.value!},true);
    if(keepDelete) {
      let lost=true;
      const flaky:SyncRemote={inspect:()=>remote.inspect(),pull:(...args)=>remote.pull(...args),upload:async request=>{const result=await remote.upload(request);if(request.resolution && lost){lost=false;throw new Error("lost resolution reply");}return result;}};
      const resolver=new SyncEngine(identity,a,flaky,policy);
      assert.equal((await resolver.resolve()).length,1);
    }
    assert.deepEqual(await ea.resolve(),[]);
    assert.equal((await a.syncSummary(identity.workspaceId)).pending,0);
    for(const id of ["parent","child","leaf"])assert.equal((await a.readRecord(scope(identity,id)))?.deleted,keepDelete);
    if(!keepDelete)assert.equal((await a.readRecord(scope(identity,"leaf")))?.payload?.text,"另一端子目标编辑");
    await ea.pull();await eb.run();
    for(const id of ["parent","child","leaf"])assert.equal((await b.readRecord(scope(identity,id)))?.deleted,keepDelete);
  });
});

test("new remote descendant invalidates the frozen deletion scope and can restore the entire group",async()=>fixture(async(a,b,remote,identity)=>{
  const ea=new SyncEngine(identity,a,remote,policy),eb=new SyncEngine(identity,b,remote,policy);
  await ea.run();await nested(a,identity);await ea.run();await eb.run();
  await mutate(a,identity,"parent",{kind:"delete",confirmed:true,subtreeBasis:todoSubtreeBasis(await a.listRecords(scope(identity)),"parent")});
  await mutate(b,identity,"other",{kind:"move",targetId:"child",position:"inside"});await eb.run();
  await ea.upload();
  const conflict=(await a.listConflicts(scope(identity)))[0]!;
  assert.ok(conflict?.atomicGroup);
  await new ConflictService(a,todoConflictPolicy).saveChoice(conflict,conflict.generation,randomUUID(),{kind:"restore",value:conflict.comparison.remote!.value!},true);
  assert.deepEqual(await ea.resolve(),[]);await ea.pull();
  assert.equal((await a.syncSummary(identity.workspaceId)).pending,0);
  assert.equal((await a.readRecord(scope(identity,"other")))?.payload?.parentId,"child");
  assert.equal(groupTodoTree(await a.listRecords(scope(identity)),"2026-10-26").unfinished.length,4);
}));

test("MCP applies the same parent completion gate and explicitly confirms whole-subtree deletion",async()=>fixture(async(a,_b,remote,identity,_dir)=>{
  const engine=new SyncEngine(identity,a,remote,policy);await engine.run();await nested(a,identity);await engine.run();
  // The isolated test remote exposes its public URL through the transport itself.
  const endpoint=(remote as unknown as {base:string}).base;
  const call=async(method:string,body:object,credential=token)=>{
    const response=await fetch(new URL("v1/mcp/"+method,endpoint),{method:"POST",headers:{authorization:"Bearer "+credential},body:JSON.stringify(body)});
    return {code:response.status,body:await response.json() as any};
  };
  const grant=(await call("grant-create",{name:"层级验证",domains:["builtin.todo"],actions:["read","complete","delete"]})).body;
  assert.ok(grant.credential);
  const root=(await call("get",{domainId:"builtin.todo",recordId:"parent"},grant.credential)).body.record;
  const completion=(await call("write",{domainId:"builtin.todo",recordId:"parent",revision:root.revision,action:"complete",operationId:"complete-parent"},grant.credential)).body;
  assert.notEqual(completion.status,"accepted");
  const input={domainId:"builtin.todo",recordId:"parent",revision:root.revision,action:"delete",operationId:"delete-tree"};
  const pending=(await call("write",input,grant.credential)).body;
  assert.equal(pending.status,"pending-confirmation");assert.match(pending.object,/全部 2 条子待办/);
  assert.equal((await call("owner-confirmation",{operationId:pending.operationId,accepted:true})).code,200);
  const deleted=(await call("write",input,grant.credential)).body;
  assert.equal(deleted.status,"accepted",JSON.stringify(deleted));assert.equal(deleted.version.related.length,2);
  await engine.pull();
  assert.equal((await a.readRecord(scope(identity,"leaf")))?.deleted,true);
}));

test("old services are checked for atomic capability before any compound mutation is sent",async()=>{
  const paths:string[]=[];
  const server=createServer((request,response)=>{paths.push(request.url??"");request.resume();response.writeHead(404);response.end("{}");});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const address=server.address();if(!address || typeof address==="string")throw new Error("port");
    const remote=new HttpSyncRemote("http://127.0.0.1:"+address.port,token);
    await assert.rejects(remote.upload({workspaceId:"w",authorityId:"a",domainId:"builtin.todo",recordId:"r",operationId:"op",baseRevision:0,value:{text:"r",createdAt:at,completed:false},changed:["text"],resolution:false,batch:[]}));
    assert.deepEqual(paths,["/v1/sync/capabilities"]);
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test("remote subtree deletion preserves an active child editor and restores the whole tree explicitly",async()=>fixture(async(a,b,remote,identity)=>{
  const ea=new SyncEngine(identity,a,remote,policy),eb=new SyncEngine(identity,b,remote,policy);
  await ea.run();await nested(a,identity);await ea.run();await eb.run();
  const child=(await a.readRecord(scope(identity,"leaf")))!;
  await a.saveEditor({...child,baseSequence:child.localSequence,operationId:"protect-child",value:{...child.payload!,text:"尚未提交的子目标输入"}});
  await mutate(b,identity,"parent",{kind:"delete",confirmed:true,subtreeBasis:todoSubtreeBasis(await b.listRecords(scope(identity)),"parent")});await eb.run();
  await assert.rejects(ea.pull());
  const conflict=(await a.listConflicts(scope(identity)))[0]!;
  assert.ok(conflict.atomicGroup);assert.equal(conflict.editorValue?.text,"尚未提交的子目标输入");
  for(const id of ["parent","child","leaf"])assert.equal((await a.readRecord(scope(identity,id)))?.deleted,false);
  await new ConflictService(a,todoConflictPolicy).saveChoice(conflict,conflict.generation,randomUUID(),{kind:"restore",value:conflict.editorValue!},true);
  assert.deepEqual(await ea.resolve(),[]);
  await ea.pull();await eb.run();
  for(const id of ["parent","child","leaf"])assert.equal((await b.readRecord(scope(identity,id)))?.deleted,false);
  assert.equal((await b.readRecord(scope(identity,"leaf")))?.payload?.text,"尚未提交的子目标输入");
}));
