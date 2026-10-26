import { LocalStoreError } from "@workspace/contracts";
import type { ContentValue, LocalPersistence, LocalRecord, LocalSaveResult, OperationReference } from "@workspace/contracts";

/** Atomic groups use a versioned, reserved operation namespace retained by snapshots. */
export function batchIdentity(operationId:string): { original:string; signature:string; index:number; count:number } | null {
  const match=/^batch1~([^~]+)~([a-f0-9]{64})~(\d+)~(\d+)$/.exec(operationId);
  return match ? {original:match[1]!,signature:match[2]!,index:Number(match[3]),count:Number(match[4])}:null;
}

export class CollectionContentService {
  constructor(private readonly store:LocalPersistence) {}
  async mutate(reference:OperationReference,baseSequence:number,signature:string,prepare:(rows:readonly LocalRecord[])=>readonly {recordId:string;value:ContentValue}[]):Promise<LocalSaveResult> {
    let dispatched=false;
    try {
      if(!/^[a-f0-9]{64}$/.test(signature) || !Number.isSafeInteger(baseSequence) || baseSequence<1) throw new Error("原操作依据无效。");
      const operations=await this.store.listPending(reference);
      const prior=operations.filter(op=>batchIdentity(op.operationId)?.original===reference.operationId);
      if(prior.length) {
        const identity=batchIdentity(prior[0]!.operationId)!;
        if(identity.signature!==signature || prior.length!==identity.count || prior.some(op=>batchIdentity(op.operationId)?.signature!==signature)) throw new Error("原操作身份不能用于不同内容，请重新核对。");
        return {status:"saved-local",operationId:reference.operationId,localSequence:prior.find(op=>batchIdentity(op.operationId)?.index===0)!.localSequence};
      }
      const rows=await this.store.listRecords(reference);
      const source=rows.find(r=>r.recordId===reference.recordId);
      if(!source || source.deleted || source.localSequence!==baseSequence) throw new Error("任务已被其他操作修改，原依据已变化，请重新读取后操作。");
      const mutations=prepare(rows);
      if(!mutations.length || mutations[0]!.recordId!==reference.recordId || !this.store.commitBatch) throw new Error("当前存储不支持整体操作。");
      const changes=mutations.map((item,index)=>({...reference,recordId:item.recordId,operationId:"batch1~"+reference.operationId+"~"+signature+"~"+index+"~"+mutations.length,
        kind:item.value===null?"delete" as const:"put" as const,payloadJson:item.value===null?null:JSON.stringify(item.value)}));
      dispatched=true;
      const sequences=await this.store.commitBatch(changes,rows);
      return {status:"saved-local",operationId:reference.operationId,localSequence:sequences[0]!};
    } catch(error) {
      if(error instanceof LocalStoreError && error.outcome==="unconfirmed") return {status:"save-unconfirmed",operationId:reference.operationId,message:"整体保存结果尚待核对，请重试原操作。"};
      if(error instanceof LocalStoreError) return {status:"not-saved",reason:error.outcome==="operation-mismatch"?"operation-mismatch":"storage-unavailable",message:"本机保存失败或列表进度已变化，未部分保存；请重新读取后操作。"};
      if(dispatched) return {status:"save-unconfirmed",operationId:reference.operationId,message:"整体保存结果尚待核对，请保留原操作。"};
      return {status:"not-saved",reason:"invalid-input",message:error instanceof Error?error.message:"整体操作无效。"};
    }
  }
}
