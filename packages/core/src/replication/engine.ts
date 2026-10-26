import { batchIdentity } from "../operations/collection-content-service.js";
import type { AuthorityVersion, ConflictPersistence, ConflictPolicy, ContentValue, Delivery, JsonObject, LocalPersistence, ReplicaPersistence, SyncRemote, UploadRequest, WorkspaceIdentity } from "@workspace/contracts";
import { canonical } from "@workspace/contracts";
import { ConflictService } from "../records/conflict-service.js";
import { ConcurrentContent } from "../records/concurrent-content.js";

export type ReplicaStore = ReplicaPersistence & ConflictPersistence & LocalPersistence;

export function changedAttributes(before: ContentValue, value: ContentValue, policy?: ConflictPolicy): readonly string[] {
  if (!before || !value) return Object.keys(policy?.attributes ?? {});
  return Object.entries(policy?.attributes ?? {}).filter(([, keys]) => keys.some((key) => Object.hasOwn(before, key) !== Object.hasOwn(value, key) || canonical(before[key]) !== canonical(value[key]))).map(([key]) => key);
}
function rebase(delivery: Delivery): ContentValue {
  const value = delivery.operation.payloadJson === null ? null : JSON.parse(delivery.operation.payloadJson) as JsonObject;
  if (!delivery.parent || !value || !delivery.before || !delivery.parent.value) return value;
  const result = { ...delivery.parent.value };
  for (const key of new Set([...Object.keys(value), ...Object.keys(delivery.before)])) {
    if (Object.hasOwn(value, key) === Object.hasOwn(delivery.before, key) && canonical(value[key]) === canonical(delivery.before[key])) continue;
    if (Object.hasOwn(value, key)) result[key] = value[key]!; else delete result[key];
  }
  return result;
}

export class SyncEngine {
  constructor(private readonly identity: WorkspaceIdentity, private readonly store: ReplicaStore, private readonly remote: SyncRemote,
    private readonly policy: (domainId: string) => ConflictPolicy | undefined) {}
  async verify(): Promise<void> {
    const found = await this.remote.inspect();
    if (!found || found.workspaceId !== this.identity.workspaceId || found.authorityId !== this.identity.authorityId) throw new Error("统一位置身份不匹配，本机内容与原绑定保留。");
  }
  async upload(): Promise<readonly string[]> {
    await this.verify();
    const errors: string[] = [];
    const blocked = new Set<string>();
    const initial = await this.store.deliveries(this.identity.workspaceId);
    const grouped = new Set<string>();
    for (const original of initial) {
      const identity = batchIdentity(original.operation.operationId);
      if (identity) {
        if (grouped.has(identity.original)) continue;
        grouped.add(identity.original);
        const members = initial.filter(d => batchIdentity(d.operation.operationId)?.original === identity.original).sort((a,b) => batchIdentity(a.operation.operationId)!.index-batchIdentity(b.operation.operationId)!.index);
        const message = await this.uploadGroup(members);
        if (message) errors.push(message);
        continue;
      }
      const operation = original.operation;
      const key = operation.domainId + "/" + operation.recordId;
      if (blocked.has(key) || (await this.store.readConflict(operation))?.status === "pending") continue;
      const delivery = (await this.store.deliveries(this.identity.workspaceId)).find((item) => item.operation.localSequence === operation.localSequence);
      if (!delivery) continue;
      try {
        const policy = this.policy(operation.domainId);
        const base = delivery.parent ?? delivery.base;
        const value = rebase(delivery);
        const request: UploadRequest = delivery.request ?? { workspaceId: operation.workspaceId, domainId: operation.domainId, recordId: operation.recordId,
          authorityId: this.identity.authorityId, operationId: operation.operationId, baseRevision: base?.revision ?? 0, value,
          changed: changedAttributes(delivery.before, operation.payloadJson === null ? null : JSON.parse(operation.payloadJson) as JsonObject, policy), resolution: false };
        await this.store.freezeUpload(operation.localSequence, request);
        const result = await this.remote.upload(request);
        if (result.status === "accepted") await this.store.acknowledge(operation.localSequence, result.version);
        else if (result.status === "conflict") {
          const local = await this.store.readRecord(operation);
          if (!local) throw new Error("本机原内容暂不可读，请保留原同步操作。");
          // Retain the latest local outcome, including edits made during upload.
          const localValue = local.deleted ? null : local.payload;
          await new ConflictService(this.store, policy).retain({ workspaceId: operation.workspaceId, domainId: operation.domainId, recordId: operation.recordId,
            base: result.base, local: { baseRevision: request.baseRevision, value: localValue, changed: [...request.changed, ...changedAttributes(request.value, localValue, policy)] },
            remote: result.version, remoteChanged: result.version.changed }, local.localSequence);
          blocked.add(key);
        } else {
          await this.store.deliveryError(operation.localSequence, result.message); errors.push(result.message); blocked.add(key);
        }
      } catch (error) {
        const message = error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : "同步结果待确认，本机成果保留。";
        await this.store.deliveryError(operation.localSequence, message, true); errors.push(message); blocked.add(key);
      }
    }
    return errors;
  }

  private async uploadGroup(original: readonly Delivery[]): Promise<string | null> {
    const first=original[0]!;
    const identity=batchIdentity(first.operation.operationId)!;
    const all=await this.store.deliveries(this.identity.workspaceId);
    const members=all.filter(d=>batchIdentity(d.operation.operationId)?.original===identity.original).sort((a,b)=>batchIdentity(a.operation.operationId)!.index-batchIdentity(b.operation.operationId)!.index);
    if(!members.length)return null;
    if(members.length!==identity.count || members.some(d=>batchIdentity(d.operation.operationId)?.signature!==identity.signature)) return "整体操作材料不完整，已保留本机成果。";
    for(const d of members) if((await this.store.readConflict(d.operation))?.status==="pending")return null;
    // A prior operation for any member must be acknowledged first.
    if(members.some(d=>all.some(p=>p.operation.domainId===d.operation.domainId && p.operation.recordId===d.operation.recordId && p.operation.localSequence<d.operation.localSequence && batchIdentity(p.operation.operationId)?.original!==identity.original)))return null;
    try {
      const requests=members.map(d=>{
        const operation=d.operation,base=d.parent??d.base,policy=this.policy(operation.domainId);
        return {workspaceId:operation.workspaceId,domainId:operation.domainId,recordId:operation.recordId,authorityId:this.identity.authorityId,operationId:operation.operationId,
          baseRevision:base?.revision??0,value:rebase(d),changed:changedAttributes(d.before,operation.payloadJson===null?null:JSON.parse(operation.payloadJson) as JsonObject,policy),resolution:false} satisfies UploadRequest;
      });
      const request=members[0]!.request??{...requests[0]!,batch:requests.slice(1)};
      await this.store.freezeUpload(members[0]!.operation.localSequence,request);
      for(let i=1;i<members.length;++i) await this.store.freezeUpload(members[i]!.operation.localSequence,request.batch![i-1]!);
      let result=await this.remote.upload(request);
      if(result.status==="rejected" && /子待办|父事项|后代|层级|顺序/.test(result.message)) {
        let cursor=0,version:AuthorityVersion|undefined;
        for(let pageIndex=0;pageIndex<10000;++pageIndex) {
          const page=await this.remote.pull(this.identity.workspaceId,this.identity.authorityId,cursor);
          for(const entry of page.versions) for(const item of [...(entry.related??[]),entry]) if(item.domainId===request.domainId && item.recordId===request.recordId)version=item;
          cursor=page.cursor;if(!page.more)break;
        }
        if(version)result={status:"conflict",version,base:members[0]!.base,reasons:["collection-state-changed"]};
      }
      if(result.status==="accepted") {
        if(!this.store.acknowledgeBatch)throw new Error("本机尚不支持整体确认。");
        const versions=[result.version,...(result.version.related??[])];
        const entries=members.map(d=>{
          const version=versions.find(v=>v.recordId===d.operation.recordId && v.domainId===d.operation.domainId);
          if(!version)throw new Error("统一位置的整体回执不完整，原操作保留。");
          return {sequence:d.operation.localSequence,version};
        });
        await this.store.acknowledgeBatch(entries);
        return null;
      }
      const message=result.status==="rejected"?result.message:"整棵树的进度已变化，请在冲突处理中核对；本机成果保留。";
      if(result.status==="conflict") {
        const member=members.find(d=>d.operation.recordId===result.version.recordId)!;
        const local=await this.store.readRecord(result.version);
        if(local && member) {
          const pending=await this.store.deliveries(this.identity.workspaceId);
          const sequences=new Set(members.map(d=>d.operation.localSequence));
          const recordIds=new Set(members.map(d=>d.operation.recordId));
          let expanded=true;
          while(expanded) {
            expanded=false;
            for(const item of pending) {
              if(item.operation.domainId!==request.domainId || !recordIds.has(item.operation.recordId))continue;
              const key=batchIdentity(item.operation.operationId)?.original;
              for(const related of pending.filter(d=>d.operation.domainId===request.domainId && (key ? batchIdentity(d.operation.operationId)?.original===key : d.operation.recordId===item.operation.recordId))) {
                if(!sequences.has(related.operation.localSequence)) {sequences.add(related.operation.localSequence);recordIds.add(related.operation.recordId);expanded=true;}
              }
            }
          }
          const prior=await this.store.readConflict(result.version);
          if(!prior) await this.store.writeConflict({workspaceId:result.version.workspaceId,domainId:result.version.domainId,recordId:result.version.recordId,
            generation:1,status:"pending",draft:null,reasons:result.reasons,remoteHistory:[result.version],
            comparison:{...result.version,base:result.base,local:{baseRevision:member.base?.revision??0,value:local.deleted?null:local.payload,changed:request.changed},remote:result.version,remoteChanged:result.version.changed},
            atomicGroup:{request,sequences:[...sequences],records:[...recordIds]}},null,local.localSequence);
        }
      }
      for(const d of members)await this.store.deliveryError(d.operation.localSequence,message);
      return message;
    } catch(error) {
      const message=error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)?error.message:"整体同步结果待核对，本机成果保留。";
      for(const d of members) await this.store.deliveryError(d.operation.localSequence,message,true);
      return message;
    }
  }

  async resolve(): Promise<readonly string[]> {
    const errors: string[] = [];
    // All registered domains are included, including deleted records. Ordinary
    // incoming content cannot manufacture a user resolution capability.
    const domains = new Set(await this.store.replicaDomains(this.identity.workspaceId));
    domains.add("builtin.todo");
    for (const domainId of domains) for (const conflict of await this.store.listConflicts({ workspaceId: this.identity.workspaceId, domainId })) {
      if (!conflict.draft?.submitted) continue;
      if (conflict.atomicGroup) { try { await this.resolveGroup(conflict); } catch(error) {errors.push(error instanceof Error?error.message:"整体选择尚待核对。");} continue; }
      const service = new ConflictService(this.store, this.policy(domainId));
      try { await service.submit(conflict, { accept: async (scope, operationId, expectedRevision, value) => {
        const result = await this.remote.upload({ workspaceId: scope.workspaceId, domainId: scope.domainId, recordId: scope.recordId, authorityId: this.identity.authorityId,
          operationId, baseRevision: expectedRevision, value, changed: Object.keys(this.policy(domainId)?.attributes ?? {}), resolution: true });
        if (result.status === "rejected") throw new Error(result.message);
        return { status: result.status === "accepted" ? "accepted" : "changed", version: result.version };
      } }); } catch (error) { errors.push(error instanceof Error ? error.message : "冲突选择尚待核对。"); }
    }
    return errors;
  }

  private async resolveGroup(original: import("@workspace/contracts").RetainedConflict): Promise<void> {
    if(!this.store.finishBatchResolution || !original.atomicGroup || !original.draft?.submitted)throw new Error("整体冲突材料不完整。");
    let conflict=original;
    const operations=await this.store.listPending(conflict);
    let members=[...new Map(operations.filter(op=>conflict.atomicGroup!.sequences.includes(op.localSequence)).map(op=>[op.recordId,op])).values()];
    if(!members.length) {
      members=[];
      for(const recordId of conflict.atomicGroup!.records??[]) {
        const record=await this.store.readRecord({...conflict,recordId});
        if(!record)throw new Error("整体编辑保护材料尚未完整，请保留输入后重新读取。");
        members.push({...record,operationId:"protected-editor",kind:record.deleted?"delete":"put",payloadJson:record.deleted?null:JSON.stringify(record.payload)});
      }
    }
    for(const member of members) if(member.recordId!==conflict.recordId && await this.store.editor(member))throw new Error("整组还有其他未提交编辑，请先保留或明确放弃对应输入后继续。");
    const basis: import("@workspace/contracts").LocalRecord[]=[];
    for(const member of members) { const current=await this.store.readRecord(member);if(!current)throw new Error("本机整体成果暂不可读。");basis.push(current); }
    let request=conflict.draft!.atomicRequest;
    if(!request) {
      const latest=new Map<string,AuthorityVersion>();let cursor=0;
      for(let pageIndex=0;pageIndex<10000;++pageIndex) {
        const page=await this.remote.pull(this.identity.workspaceId,this.identity.authorityId,cursor);
        for(const version of page.versions) for(const item of [...(version.related??[]),version]) if(item.domainId===conflict.domainId)latest.set(item.recordId,item);
        cursor=page.cursor;if(!page.more)break;if(pageIndex===9999)throw new Error("整体比较范围过大，请稍后接续。");
      }
      const choice=conflict.draft!.choice;
      const preferRemote=choice.kind==="remote" || (choice.kind==="restore" && conflict.comparison.remote?.value!==null) || (choice.kind==="delete" && conflict.comparison.local.value!==null);
      const requests=members.map(member=>{
        const current=latest.get(member.recordId);
        if(!current)throw new Error("统一位置的整体对象已变化，请重新核对。");
        let value=preferRemote?current.value:(basis.find(r=>r.recordId===member.recordId)!.deleted?null:basis.find(r=>r.recordId===member.recordId)!.payload);
        if(member.recordId===conflict.recordId && (choice.kind==="manual" || choice.kind==="restore"))value=choice.value;
        return {workspaceId:member.workspaceId,domainId:member.domainId,recordId:member.recordId,authorityId:this.identity.authorityId,operationId:conflict.draft!.operationId+"~"+member.recordId,baseRevision:current.revision,value,
          changed:Object.keys(this.policy(conflict.domainId)?.attributes??{}),resolution:true};
      });
      request={...requests[0]!,operationId:conflict.draft!.operationId,batch:requests.slice(1)};
      const next={...conflict,generation:conflict.generation+1,draft:{...conflict.draft!,atomicRequest:request}};
      await this.store.writeConflict(next,conflict.generation);conflict=next;
    }
    const result=await this.remote.upload(request);
    if(result.status!=="accepted") {
      const {atomicRequest: _request,...draft}=conflict.draft!;
      const next={...conflict,generation:conflict.generation+1,draft:{...draft,submitted:false},
        ...(result.status==="conflict" && result.version.recordId===conflict.recordId ? {comparison:{...conflict.comparison,remote:result.version},remoteHistory:[...conflict.remoteHistory,result.version]} : {})};
      await this.store.writeConflict(next,conflict.generation);
      throw new Error(result.status==="rejected"?result.message:"整棵树的进度再次变化，原选择与本机成果保留，请重新比较。");
    }
    await this.store.finishBatchResolution(conflict,[...(result.version.related??[]),result.version],basis);
  }

  async pull(): Promise<void> {
    await this.verify();
    let cursor = await this.store.cursor(this.identity.workspaceId);
    for (let pageIndex = 0; pageIndex < 100; ++pageIndex) {
      const page = await this.remote.pull(this.identity.workspaceId, this.identity.authorityId, cursor);
      for (const version of page.versions) {
        if (version.related?.length) {
          if (!this.store.importBatch) throw new Error("本机尚不支持整体进度获取，请升级客户端。");
          const entries: { version: AuthorityVersion; expectedSequence: number | null; preserveLocal: boolean }[] = [];
          const group=[...version.related,{...version,related:undefined}];
          const alreadyKnown=(await Promise.all(group.map(member=>this.store.confirmed(member)))).every((known,i)=>known && known.revision>=group[i]!.revision);
          if(alreadyKnown) {
            for(const member of group)entries.push({version:member,expectedSequence:(await this.store.readRecord(member))?.localSequence??null,preserveLocal:true});
            await this.store.importBatch(entries,version.revision);cursor=version.revision;continue;
          }
          for (const member of [...version.related, { ...version, related: undefined }]) {
            const local = await this.store.readRecord(member);
            const pending = (await this.store.deliveries(this.identity.workspaceId)).some(d=>d.operation.domainId===member.domainId && d.operation.recordId===member.recordId);
            const conflict = await this.store.readConflict(member);
            const editor = await this.store.editor(member);
            if (editor && local) await new ConflictService(this.store,this.policy(member.domainId)).protectEditor(editor,member,local);
            if (pending && local && canonical(local.deleted ? null : local.payload)!==canonical(member.value)) {
              const base=await this.store.confirmed(member);
              await new ConcurrentContent(this.store,this.policy(member.domainId)).evaluate({...member,base,local:{baseRevision:base?.revision??0,value:local.deleted?null:local.payload,changed:changedAttributes(base?.value??null,local.deleted?null:local.payload,this.policy(member.domainId))},remote:member,remoteChanged:member.changed},local.localSequence);
            }
            entries.push({version:member,expectedSequence:local?.localSequence??null,preserveLocal:pending || !!editor || conflict?.status==="pending"});
          }
          if (entries.some(e=>e.preserveLocal)) {
            for(const entry of entries.filter(e=>e.preserveLocal)) {
              const conflict=await this.store.readConflict(entry.version);
              if(conflict?.status==="pending" && !conflict.atomicGroup) {
                const snapshot=await this.store.readRecord(version);
                const wire:UploadRequest={workspaceId:version.workspaceId,domainId:version.domainId,recordId:version.recordId,authorityId:this.identity.authorityId,operationId:"remote-group-"+version.revision,baseRevision:version.revision,value:snapshot?.deleted?null:snapshot?.payload??null,changed:version.changed,resolution:false,
                  batch:version.related.map(member=>({...member,authorityId:this.identity.authorityId,operationId:"remote-group-"+member.revision,baseRevision:member.revision,resolution:false}))};
                await this.store.writeConflict({...conflict,generation:conflict.generation+1,atomicGroup:{request:wire,sequences:[],records:entries.map(e=>e.version.recordId)}},conflict.generation);
              }
            }
            throw new Error("整棵树存在本机待同步或待处理成果，已保留完整内容；请先接续原操作，整体进度游标尚未推进。");
          }
          await this.store.importBatch(entries,version.revision);
        } else await this.receive(version);
        cursor = version.revision;
      }
      if (!page.more) return;
    }
  }
  private async receive(version: AuthorityVersion): Promise<void> {
    for (let attempt = 0; attempt < 8; ++attempt) {
      const local = await this.store.readRecord(version);
      const pending = (await this.store.deliveries(this.identity.workspaceId)).filter((entry) => entry.operation.domainId === version.domainId && entry.operation.recordId === version.recordId);
      const existing = await this.store.readConflict(version);
      const editor = await this.store.editor(version);
      const confirmedBefore = await this.store.confirmed(version);
      const possibleAcknowledgement = pending.some((entry) => entry.request && canonical(entry.request.value) === canonical(version.value));
      if (editor && local && !possibleAcknowledgement && (!confirmedBefore || version.revision > confirmedBefore.revision)) {
        await new ConflictService(this.store, this.policy(version.domainId)).protectEditor(editor, version, local);
      } else if (existing?.status === "pending") {
        await new ConflictService(this.store, this.policy(version.domainId)).retain({ ...existing.comparison, remote: version, remoteChanged: version.changed }, local!.localSequence);
      } else if (pending.length && local) {
        const first = pending[0]!;
        const base = first.request ? (first.parent?.revision === first.request.baseRevision ? first.parent : first.base?.revision === first.request.baseRevision ? first.base : null) : first.parent ?? first.base;
        // Own acknowledgements may already be ahead of this historical feed entry.
        const confirmed = await this.store.confirmed(version);
        if ((!confirmed || version.revision > confirmed.revision) && !(first.request && canonical(first.request.value) === canonical(version.value))) {
          const policy = this.policy(version.domainId);
          const value = local.deleted ? null : local.payload;
          await new ConcurrentContent(this.store, policy).evaluate({ workspaceId: version.workspaceId, domainId: version.domainId, recordId: version.recordId,
            base, local: { baseRevision: base?.revision ?? 0, value, changed: changedAttributes(base?.value ?? null, value, policy) }, remote: version, remoteChanged: version.changed }, local.localSequence);
        }
      }
      try {
        await this.store.importVersion(version, local?.localSequence ?? null, version.revision, !!pending.length || existing?.status === "pending" || (await this.store.readConflict(version))?.status === "pending");
        return;
      } catch (error) { if (attempt === 7) throw error; }
    }
  }
  async run(): Promise<readonly string[]> {
    await this.verify();
    const resolutionErrors = await this.resolve();
    const errors = [...resolutionErrors, ...await this.upload()];
    await this.pull();
    return errors;
  }
}
