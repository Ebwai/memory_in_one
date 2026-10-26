import { LocalStoreError } from "@workspace/contracts";
import type { AuthorityPersistence, ContentValue, DomainHandler, UploadRequest, UploadResult, WorkspaceIdentity } from "@workspace/contracts";
import { compareContent, sameValue } from "../records/merge.js";

export class AuthorityService {
  constructor(private readonly identity: WorkspaceIdentity, private readonly store: AuthorityPersistence,
    private readonly handler: (domainId: string) => Promise<DomainHandler>) {}
  async upload(input: UploadRequest): Promise<UploadResult> {
    const rejected = (message: string): UploadResult => ({ status: "rejected", message });
    if (!input || input.workspaceId !== this.identity.workspaceId || input.authorityId !== this.identity.authorityId ||
        ![input.recordId, input.operationId, input.domainId].every((id) => typeof id === "string" && !!id.trim() && id.length <= 512 && !id.startsWith("@")) ||
        !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || typeof input.resolution !== "boolean" ||
        !Array.isArray(input.changed) || !input.changed.every((key) => typeof key === "string") ||
        (input.value !== null && (typeof input.value !== "object" || Array.isArray(input.value)))) return rejected("同步请求身份或内容无效，原本机成果保留。");
    try { const receipt = await this.store.authorityReceipt(input); if (receipt) return receipt; }
    catch (error) { if (error instanceof LocalStoreError && error.outcome === "operation-mismatch") return rejected("原操作身份属于不同的内容或动作，未覆盖已有成果。"); throw error; }
    if (input.batch !== undefined) {
      if (!Array.isArray(input.batch)) return rejected("整体操作材料无效。");
      return this.uploadGroup(input);
    }
    for (let attempt = 0; attempt < 8; ++attempt) {
      const current = await this.store.authorityRead(input);
      const base = input.baseRevision ? await this.store.authorityRead(input, input.baseRevision) : null;
      let handler: DomainHandler;
      let value: ContentValue = input.value;
      try {
        handler = await this.handler(input.domainId);
        handler.validate(value, base?.value ?? current?.value ?? null, current === null);
        if (handler.policy && input.changed.some((key) => !Object.hasOwn(handler.policy!.attributes, key))) return rejected("领域未声明该属性的冲突含义。");
      } catch (error) { return rejected(error instanceof Error ? error.message : "领域不可用，未确认本机改动。"); }
      if (input.audit?.action === "delete" && current?.revision !== input.baseRevision) return current ? { status: "conflict", version: current, base, reasons: ["confirmation-progress-changed"] } : rejected("确认对象不存在。");
      if (input.resolution) {
        if (!current) return rejected("原冲突内容不存在，未创建替代内容。");
        if (current.revision !== input.baseRevision) return { status: "conflict", version: current, base, reasons: ["progress-changed"] };
      } else if (!current) {
        if (input.baseRevision !== 0 || value === null) return rejected("缺少原内容进度，不允许将旧修改转为新增。");
      } else if (current.revision !== input.baseRevision || (current.value === null && value !== null)) {
        // A tombstone is never undone by an ordinary snapshot, even if that
        // client has fetched the deletion. Only an explicit conflict choice may restore it.
        if (current.value === null && value !== null) return { status: "conflict", version: current, base, reasons: ["delete-edit"] };
        const remoteChanged = await this.store.authorityChanges(input, input.baseRevision);
        const decision = compareContent({ ...input, base, local: { baseRevision: input.baseRevision, value, changed: input.changed },
          remote: current, remoteChanged }, handler.policy);
        if (decision.status === "conflict") return { status: "conflict", version: { ...current, changed: remoteChanged }, base, reasons: decision.reasons };
        value = decision.value;
      }
      try { handler.validate(value, base?.value ?? current?.value ?? null, current === null); }
      catch { return rejected("合并结果未通过领域校验，原成果保留。"); }
      const actualChanged = Object.entries(handler.policy?.attributes ?? {}).filter(([, keys]) => keys.some((key) => !sameValue(current?.value?.[key], value?.[key]))).map(([attribute]) => attribute);
      const changed = [...new Set([...input.changed, ...actualChanged])];
      let result: UploadResult | null;
      if (handler.validateCollection && this.store.authorityList && this.store.authorityBatch) {
        const rows = await this.store.authorityList(input.workspaceId,input.domainId);
        if ((rows.find(r=>r.recordId===input.recordId)?.revision ?? 0)!==(current?.revision ?? 0)) continue;
        const merged = new Map(rows.map(r=>[r.recordId,r.value])); merged.set(input.recordId,value);
        try { handler.validateCollection([...merged].map(([recordId,value])=>({recordId,value}))); }
        catch(error) {return rejected(error instanceof Error?error.message:"层级结果无效。");}
        result = await this.store.authorityBatch(input,[{...input,value,changed}],rows,handler.guards);
      } else result = await this.store.authorityCommit(input,value,current?.revision ?? 0,changed,handler.guards);
      if (result) return result;
    }
    throw new Error("统一位置正在变化，请按原操作再次核对。");
  }

  private async uploadGroup(input: UploadRequest): Promise<UploadResult> {
    if (!this.store.authorityList || !this.store.authorityBatch) return {status:"rejected",message:"统一位置暂不支持整体操作，请升级服务后接续。"};
    if ((input.batch ?? []).some(r=>!r || r.audit)) return {status:"rejected",message:"整体操作来源材料无效。"};
    const requests = [{ ...input, batch: undefined }, ...(input.batch ?? [])];
    if (!requests.length || new Set(requests.map(r=>r.recordId)).size !== requests.length ||
        requests.some(r=>!r || r.workspaceId!==input.workspaceId || r.authorityId!==input.authorityId || r.domainId!==input.domainId || r.batch ||
          typeof r.recordId!=="string" || !r.recordId.trim() || r.recordId.startsWith("@") || r.recordId.length>512 ||
          !Number.isSafeInteger(r.baseRevision) || r.baseRevision<0 || typeof r.resolution!=="boolean" || r.resolution!==input.resolution || !Array.isArray(r.changed) ||
          !r.changed.every(k=>typeof k==="string") || (r.value!==null && (typeof r.value!=="object" || Array.isArray(r.value))))) return {status:"rejected",message:"整体操作身份或内容无效。"};
    for(let attempt=0;attempt<8;++attempt) {
      const rows=await this.store.authorityList(input.workspaceId,input.domainId);
      const handler=await this.handler(input.domainId);
      const values: UploadRequest[]=[];
      for(const request of requests) {
        const current=rows.find(r=>r.recordId===request.recordId)??null;
        const base=request.baseRevision ? await this.store.authorityRead(request,request.baseRevision):null;
        let value=request.value;
        if(request.changed.some(key=>!Object.hasOwn(handler.policy?.attributes??{},key))) return {status:"rejected",message:"领域未声明该属性的冲突含义。"};
        if(!current) {
          if(request.baseRevision!==0 || value===null) return {status:"rejected",message:"原整体操作对象不存在，请重新核对。"};
        } else if(request.resolution) {
          if(current.revision!==request.baseRevision) return {status:"conflict",version:current,base,reasons:["subtree-progress-changed"]};
        } else if(current.revision!==request.baseRevision || (current.value===null && value!==null)) {
          if(value===null || current.value===null) return {status:"conflict",version:current,base,reasons:["subtree-progress-changed"]};
          const remoteChanged=await this.store.authorityChanges(request,request.baseRevision);
          const decision=compareContent({...request,base,local:{baseRevision:request.baseRevision,value,changed:request.changed},remote:current,remoteChanged},handler.policy);
          if(decision.status==="conflict") return {status:"conflict",version:current,base,reasons:decision.reasons};
          value=decision.value;
        }
        try { handler.validate(value,base?.value??current?.value??null,current===null); }
        catch(error) { return {status:"rejected",message:error instanceof Error?error.message:"整体操作校验失败。"}; }
        values.push({...request,value});
      }
      const merged=new Map(rows.map(r=>[r.recordId,r.value]));
      values.forEach(r=>merged.set(r.recordId,r.value));
      try {handler.validateCollection?.([...merged].map(([recordId,value])=>({recordId,value})));}
      catch(error) {return {status:"rejected",message:error instanceof Error?error.message:"整体结果无效，原成果保留。"};}
      const result=await this.store.authorityBatch(input,values,rows,handler.guards);
      if(result)return result;
    }
    throw new Error("统一位置正在变化，请核对原整体操作。");
  }
}
