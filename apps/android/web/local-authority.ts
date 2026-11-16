import { AuthorityService, DOMAIN_REGISTRY } from '@workspace/core';
import { todoDefinition, TODO_DOMAIN, todoConflictPolicy, validateTodoConflict, validateTodoTree } from '@workspace/todo-list';
import { canonical, matchesPreset, isPresetDomain, isCompatibleDomainUpgrade, validatePresetRecord, type ExtensionDefinition, type ContentValue, type DomainRegistration, type WorkspaceIdentity, type DomainHandler, type SyncRemote, type ExtensionPrograms } from '@workspace/contracts';
import { parseExtension, validateExtensionRecord } from '@workspace/extension-sdk';
import { DatabaseSync } from './sqlite-platform';
import { AndroidStore } from './replica-store';

export async function localAuthority(identity: WorkspaceIdentity, programs: ExtensionPrograms, databasePath = 'authority-'+identity.workspaceId) {
  const store = await AndroidStore.open({ databasePath });
  const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE IF NOT EXISTS workspace_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),workspace_id TEXT NOT NULL,authority_id TEXT NOT NULL,name TEXT NOT NULL,creation_id TEXT NOT NULL,created_at TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO workspace_identity VALUES(1,?,?,?,?,?)').run(identity.workspaceId,identity.authorityId,identity.name,identity.creationId,identity.createdAt);
  const stored=db.prepare('SELECT workspace_id,authority_id FROM workspace_identity WHERE singleton=1').get();if(stored.workspace_id!==identity.workspaceId||stored.authority_id!==identity.authorityId)throw new Error('本机权威空间身份不匹配。');
  async function handler(domainId: string): Promise<DomainHandler> {
    if(domainId===DOMAIN_REGISTRY){
      const validate=(value: ContentValue,base: ContentValue)=>{
        if(!value||typeof value.enabled!=='boolean'||typeof value.fingerprint!=='string'||!value.definition)throw new Error('领域登记格式无效。');
        const definition=(value.definition as any).domainId===TODO_DOMAIN?value.definition as unknown as ExtensionDefinition:parseExtension(JSON.stringify(value.definition));
        if(window.AndroidPlatform.hash(JSON.stringify(value.definition))!==value.fingerprint)throw new Error('程序声明与指纹不一致。');
        if(isPresetDomain(definition.domainId)&&!matchesPreset(definition))throw new Error('预设模板声明不匹配。');
        if(definition.domainId===TODO_DOMAIN&&canonical(definition)!==canonical(todoDefinition)&&!isCompatibleDomainUpgrade(definition,todoDefinition))throw new Error('待办声明不兼容。');
        if(base?.removed)throw new Error('已删除项目不可恢复。');
        if(base&&canonical(value.definition)!==canonical(base.definition)&&!isCompatibleDomainUpgrade(base.definition as any,definition))throw new Error('不兼容的程序升级。');
      };
      return {validate,guards:[],policy:{attributes:{enabled:['enabled','removed'],name:['displayName'],program:['definition','fingerprint']},validate}};
    }
    const registration=await store.authorityRead({workspaceId:identity.workspaceId,domainId:DOMAIN_REGISTRY,recordId:domainId});
    const entry=registration?.value as unknown as DomainRegistration|null;
    if(!registration||!entry?.enabled||entry.removed)throw new Error('统一位置的插件已停用或未登记。');
    if(domainId===TODO_DOMAIN)return {guards:[registration],policy:todoConflictPolicy,validate:validateTodoConflict,validateCollection:validateTodoTree};
    if(!await programs.available(entry.fingerprint))throw new Error('本机权威位置缺少兼容程序。');
    return {guards:[registration],validate:(value,base,creating = base === null)=>{if(!entry.definition.actions.includes(value===null?'delete':creating?'create':'update'))throw new Error('插件未声明此动作。');if(value!==null){validateExtensionRecord(entry.definition,value);if(isPresetDomain(domainId))validatePresetRecord(domainId,value);}if(base===null&&!creating&&value!==null)throw new Error('不支持此恢复结果。');}};
  }
  const service=new AuthorityService(identity,store,handler);
  const remote:SyncRemote={inspect:async()=>identity,upload:request=>service.upload(request),pull:async(workspaceId,authorityId,cursor)=>{if(workspaceId!==identity.workspaceId||authorityId!==identity.authorityId)throw new Error('空间身份不匹配。');return store.authorityPull(workspaceId,cursor);}};
  return {store,remote};
}
