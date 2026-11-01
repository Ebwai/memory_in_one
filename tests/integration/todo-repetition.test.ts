import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareTodo, prepareTodoMutation, currentTodo, currentTodoRows, repeatPeriod, validateTodoConflict, todoDefinition } from "@workspace/todo-list";
import { isCompatibleDomainUpgrade } from "@workspace/contracts";
import type { JsonObject, LocalRecord } from "@workspace/contracts";
const at = "2026-11-01T03:00:00Z";
const change = (value: JsonObject, command: Parameters<typeof prepareTodoMutation>[1], time = at) => {
  const result = prepareTodoMutation(value, command, time);
  assert.equal(result.kind, "put");
  return result.kind === "put" ? result.payload : value;
};
test("notes preserve legacy data; six completions reach target, next day projects zero without mutating storage", () => {
  const original = prepareTodo("喝水", at);
  const noted = change(original, {kind:"notes",notes:"每次一杯"});
  assert.equal(original.notes, undefined);
  let task = change(noted,{kind:"repeat",frequency:"day",target:6,timezone:"Asia/Shanghai"});
  for(let count=1;count<=6;count++) {
    task=change(task,{kind:"complete",completed:true});
    assert.equal(task.repeatCount,count);
    assert.equal(task.completed,count===6);
    validateTodoConflict(task,null);
  }
  assert.equal(task.completedAt,at);
  const tomorrow=currentTodo(task,"2026-11-01T16:00:00Z");
  assert.equal(tomorrow.repeatCount,0);
  assert.equal(tomorrow.completed,false);
  assert.equal(tomorrow.completedAt,undefined);
  assert.equal(task.repeatCount,6);
  assert.equal(change(task,{kind:"complete",completed:true},"2026-11-01T16:00:00Z").repeatCount,1);
  assert.equal(tomorrow.notes,"每次一杯");
});
test("calendar week, month and timezone boundaries are stable",()=>{
  assert.equal(repeatPeriod("2026-11-01T15:59:59Z","week","Asia/Shanghai"),"2026-10-26");
  assert.equal(repeatPeriod("2026-11-01T16:00:00Z","week","Asia/Shanghai"),"2026-11-02");
  assert.equal(repeatPeriod("2026-10-31T16:00:00Z","month","Asia/Shanghai"),"2026-11");
  assert.equal(repeatPeriod("2026-10-31T16:00:00Z","month","UTC"),"2026-10");
});
test("repeat reset reopens completed ancestors and invalid counts are rejected",()=>{
  let task=change(prepareTodo("child",at),{kind:"repeat",frequency:"day",target:1,timezone:"Asia/Shanghai"});
  task=change(task,{kind:"complete",completed:true});
  const row=(recordId:string,payload:JsonObject):LocalRecord=>({workspaceId:"s",domainId:"builtin.todo",recordId,payload,deleted:false,localSequence:1});
  const rows=currentTodoRows([row("p",{...prepareTodo("parent",at),completed:true,completedAt:at}),row("c",{...task,parentId:"p"})],"2026-11-02T03:00:00Z");
  assert.equal(rows[0]!.payload!.completed,false);
  for(const target of [0,-1,1.5,1001]) assert.throws(()=>change(task,{kind:"repeat",frequency:"day",target,timezone:"UTC"}));
});
test("domain upgrades accept optional additive fields, reject removed fields, required changes and downgrades",()=>{
  const old={...todoDefinition,version:"1.0.0",schema:{...todoDefinition.schema,properties:{text:{type:"string"},createdAt:{type:"string"},completed:{type:"boolean"}}}};
  assert.equal(isCompatibleDomainUpgrade(old,todoDefinition),true);
  assert.equal(isCompatibleDomainUpgrade(todoDefinition,old),false);
  assert.equal(isCompatibleDomainUpgrade(old,{...todoDefinition,schema:{...todoDefinition.schema,required:["text","notes"]}}),false);
});
