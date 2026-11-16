import type { NativeStorage } from './store';
declare global { interface Window { WorkspaceNative: NativeStorage } }
import { AndroidStore } from './replica-store';
import { DatabaseSync } from './sqlite-platform';
import { DomainRegistry, LocalContentService, CollectionContentService, SyncEngine, ConflictService, McpAccess, confirmMigrationBoundary } from '@workspace/core';
import { todoDefinition, TODO_DOMAIN, prepareTodo, prepareTodoTree, todoConflictPolicy } from '@workspace/todo-list';
import { NOTES_DOMAIN, isPresetDomain, validatePresetRecord, presetDefinition, matchesPreset, canonical, type WorkspaceIdentity, type ExtensionDefinition, type DomainRegistration, type JsonObject, type ResolutionChoice } from '@workspace/contracts';
import { validateExtensionRecord, parseExtension } from '@workspace/extension-sdk';
import { HttpSyncRemote } from '../../../packages/adapters/src/connection/http-sync';
import { HttpWorkspaceLocation } from '../../../packages/adapters/src/workspace/http-location';
import { localAuthority } from './local-authority';
import { file } from './files';
import type { WorkspaceSnapshot } from '@workspace/contracts';
export interface Archive { workspace: WorkspaceIdentity; location: string; snapshot: WorkspaceSnapshot }
export interface Profile { identity: WorkspaceIdentity; endpoint: string; key: string; replica: string; authorityPath?: string }
class Programs {
  private db: DatabaseSync;
  constructor(space = 'initial') { this.db = new DatabaseSync('programs-'+space); this.db.exec('CREATE TABLE IF NOT EXISTS programs (fingerprint TEXT PRIMARY KEY, source TEXT NOT NULL)'); }
  async stage(definition: ExtensionDefinition) { const source = JSON.stringify(definition), fingerprint = window.AndroidPlatform.hash(source); this.db.prepare('INSERT OR REPLACE INTO programs VALUES (?,?)').run(fingerprint, source); return fingerprint; }
  async available(fingerprint: string) { const row = this.db.prepare('SELECT source FROM programs WHERE fingerprint=?').get(fingerprint); return !!row && window.AndroidPlatform.hash(row.source) === fingerprint; }
  async remove(fingerprint: string) { this.db.prepare('DELETE FROM programs WHERE fingerprint=?').run(fingerprint); }
}
export class Client {
  private catalog = new DatabaseSync('catalog');
  profiles: Profile[] = [];
  current: Profile | null = null;
  store!: AndroidStore;
  registry!: DomainRegistry;
  programs = new Programs();
  message = '已保存在本机，尚未同步。';
  private syncing: Promise<void> | null = null;
  async load() {
    this.catalog.exec('CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.profiles = JSON.parse(this.catalog.prepare('SELECT value FROM settings WHERE id=?').get('profiles')?.value ?? '[]');
    const current = this.catalog.prepare('SELECT value FROM settings WHERE id=?').get('current')?.value;
    if (this.profiles.length) await this.select(current ?? this.profiles[0]!.replica);
    // The first Android build is retained, and imported idempotently into the shared model.
    if (!this.catalog.prepare('SELECT value FROM settings WHERE id=?').get('legacy-imported')) {
      const old = JSON.parse(window.WorkspaceNative.load());
      if (!old.ok) throw new Error('旧版本机材料暂不能读取，未覆盖。');
      for (const space of old.state.spaces) {
        let profile = this.profiles.find(p => p.identity.workspaceId === space.id);
        if (!profile) profile = await this.createLocal(space.name, space.id);
        await this.select(profile.replica);
        await this.builtins();
        for (const row of space.rows) if (!row.deleted && row.payload) await this.store.commit({ workspaceId: space.id, domainId: TODO_DOMAIN, recordId: row.recordId, operationId: 'legacy-' + row.recordId, kind: 'put', payloadJson: JSON.stringify(row.payload) });
      }
      this.setting('legacy-imported', '1');
    }
  }
  saveCapture(domainId: string, text: string) { if(this.current)this.setting('capture:'+this.current.replica+':'+domainId,text); }
  loadCapture(domainId: string): string { return this.catalog.prepare('SELECT value FROM settings WHERE id=?').get('capture:'+this.current?.replica+':'+domainId)?.value??''; }
  private setting(id: string, value: string) { this.catalog.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(id, value); }
  async select(replica: string) {
    if (this.syncing) await this.syncing;
    const profile = this.profiles.find(p => p.replica === replica);
    if (!profile) throw new Error('请选择已有空间。');
    this.current = profile; this.programs = new Programs(profile.identity.workspaceId); this.store = await AndroidStore.open({ databasePath: replica });
    this.registry = new DomainRegistry(profile.identity.workspaceId, this.store, this.programs, def => def.domainId !== TODO_DOMAIN && !matchesPreset(def));
    this.setting('current', replica);
    await this.programs.stage(todoDefinition);
    if (!profile.endpoint && !profile.replica.startsWith('restore-') && !(await this.registry.list()).length) await this.builtins();
    for (const entry of await this.registry.list()) if (matchesPreset(entry.definition)) await this.programs.stage(entry.definition);
  }
  async createLocal(name: string, id = crypto.randomUUID()) {
    if (!name.trim() || name.length > 100) throw new Error('空间名称须为 1 至 100 个字符。');
    const identity = { workspaceId: id, authorityId: crypto.randomUUID(), creationId: crypto.randomUUID(), name: name.trim(), createdAt: new Date().toISOString() };
    const profile = { identity, endpoint: '', key: '', replica: 'replica-' + id };
    await this.addProfile(profile); await this.builtins(); return profile;
  }
  async inspect(endpoint: string, token: string) { return new HttpWorkspaceLocation(endpoint, token).inspect(); }
  async connect(identity: WorkspaceIdentity, endpoint: string, token: string) {
    const verified = await this.inspect(endpoint, token);
    if (!verified || canonical(verified) !== canonical(identity)) throw new Error('目标空间身份已变化，请重新核验。');
    const existing = this.current?.identity.workspaceId === identity.workspaceId ? this.current : this.profiles.find(p => p.identity.workspaceId === identity.workspaceId);
    if (existing && existing.identity.authorityId !== identity.authorityId) throw new Error('权威身份不同，请通过迁移切换核验。');
    const key = 'owner-' + identity.workspaceId;
    const result = JSON.parse(window.AndroidPlatform.credential('save', key, token));
    if (!result.ok) throw new Error('系统凭据保护不可用，未保存明文凭据。');
    const profile = { identity, endpoint, key, replica: existing?.replica ?? 'replica-' + identity.workspaceId };
    await this.addProfile(profile); await this.sync();
    if (!(await this.registry.list()).some(e => e.definition.domainId === TODO_DOMAIN)) { await this.builtins(); await this.sync(); }
  }
  private async addProfile(profile: Profile) {
    this.profiles = [...this.profiles.filter(p => p.replica !== profile.replica), profile];
    this.setting('profiles', JSON.stringify(this.profiles)); await this.select(profile.replica);
  }
  private async builtins() {
    await this.registry.register(todoDefinition, 'builtin-todo-registration'); await this.registry.setEnabled(TODO_DOMAIN, true, 'builtin-todo-default-enable');
    await this.registry.register(presetDefinition(NOTES_DOMAIN), 'preset-notes-register'); await this.registry.setEnabled(NOTES_DOMAIN, true, 'preset-notes-enable');
  }
  private get workspaceId() { if (!this.current) throw new Error('请先选择空间。'); return this.current.identity.workspaceId; }
  rows(domainId: string) { return this.store.listRecords({ workspaceId: this.workspaceId, domainId }); }
  async addTodo(text: string, parentId?: string) {
    const content = await this.registry.contentStore(TODO_DOMAIN);
    const payload = prepareTodo(text, new Date().toISOString());
    if (parentId) { const row = await content.readRecord({ workspaceId: this.workspaceId, domainId: TODO_DOMAIN, recordId: parentId }); if (!row?.payload || row.deleted || row.payload.completed) throw new Error('父事项不可添加子待办，请先恢复父事项。'); payload.parentId = parentId; }
    const result = await new LocalContentService(content).save({ workspaceId: this.workspaceId, domainId: TODO_DOMAIN, recordId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: 'put', payload });
    if (result.status !== 'saved-local') throw new Error(result.message ?? '保存结果待核对。');
  }
  async todo(recordId: string, command: import('@workspace/todo-list').TodoCommand) {
    const content = await this.registry.contentStore(TODO_DOMAIN), scope = { workspaceId: this.workspaceId, domainId: TODO_DOMAIN, recordId };
    const row = await content.readRecord(scope); if (!row || row.deleted) throw new Error('原任务已不存在。');
    const at = new Date().toISOString();
    const result = await new CollectionContentService(content).mutate({ ...scope, operationId: crypto.randomUUID() }, row.localSequence, window.AndroidPlatform.hash(canonical({ command, at })), rows => prepareTodoTree(rows, recordId, command, at));
    if (result.status !== 'saved-local') throw new Error(result.message ?? '保存结果待核对。');
  }
  async editTodo(recordId: string, baseSequence: number, payload: JsonObject, move?: Extract<import('@workspace/todo-list').TodoCommand, { kind: 'move' }>) {
    const content = await this.registry.contentStore(TODO_DOMAIN), scope={workspaceId:this.workspaceId,domainId:TODO_DOMAIN,recordId};
    const before=await content.readRecord(scope);if(!before||before.deleted||before.localSequence!==baseSequence)throw new Error('编辑依据已变化，请保留输入并核对。');
    const previous=before.payload!;
    if(!move && (payload.prerequisiteId ?? null) === (previous.prerequisiteId ?? null) && String(payload.text??'')===String(previous.text??'')&&String(payload.notes??'')===String(previous.notes??'')&&(payload.dueDate||null)===(previous.dueDate||null)&&(payload.repeatFrequency||null)===(previous.repeatFrequency||null)&&(!payload.repeatFrequency||Number(payload.repeatTarget??1)===Number(previous.repeatTarget??1))){await this.store.clearEditor(scope);return;}
    const at=new Date().toISOString(), operationId=crypto.randomUUID();
    const result=await new CollectionContentService(content).mutate({...scope,operationId},baseSequence,window.AndroidPlatform.hash(canonical({payload,at,move:move??null})),original=>{
      let working=[...original];
      const apply=(command:import('@workspace/todo-list').TodoCommand)=>{const changes=prepareTodoTree(working,recordId,command,at);working=working.map(row=>{const change=changes.find(c=>c.recordId===row.recordId);return change?{...row,payload:change.value,deleted:change.value===null}:row;});};
      apply({kind:'text',text:String(payload.text??'')});
      apply({kind:'notes',notes:String(payload.notes??'')});
      apply({kind:'date',dueDate:payload.dueDate?String(payload.dueDate):null});
      const old=original.find(row=>row.recordId===recordId)?.payload;
      if((payload.repeatFrequency??null)!==(old?.repeatFrequency??null)||Number(payload.repeatTarget??1)!==Number(old?.repeatTarget??1))apply({kind:'repeat',frequency:(payload.repeatFrequency||null) as any,target:Number(payload.repeatTarget??1),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});
      if (move) apply(move);
      if ((payload.prerequisiteId ?? null) !== (old?.prerequisiteId ?? null)) {
        apply({ kind: 'prerequisite', recordId: typeof payload.prerequisiteId === 'string' ? payload.prerequisiteId : null });
      }
      return working.filter(row=>canonical(row.payload)!==canonical(original.find(r=>r.recordId===row.recordId)?.payload)).map(row=>({recordId:row.recordId,value:row.deleted?null:row.payload}));
    });
    if(result.status!=='saved-local')throw new Error(result.message??'本机保存结果待核对。');
    await this.store.clearEditor(scope);
  }
  async saveRecord(domainId: string, recordId: string, payload: JsonObject, baseSequence?: number) {
    const entry = await this.registry.get(domainId); validateExtensionRecord(entry.definition, payload);
    const content = await this.registry.contentStore(domainId), scope = { workspaceId: this.workspaceId, domainId, recordId };
    const old = await content.readRecord(scope);
    if (!entry.definition.actions.includes(old?'update':'create')) throw new Error('插件未声明此内容动作。');
    if(isPresetDomain(domainId))validatePresetRecord(domainId,payload);
    if (old?.deleted) throw new Error('原内容已经删除，请核对冲突，未将旧编辑转为新增。');
    if (old && old.localSequence !== baseSequence) throw new Error('编辑依据已变化，请保留输入并重新核对。');
    const result = await new LocalContentService({ ...content, commit: change => content.commit(change, old?.localSequence ?? null) }).save({ ...scope, operationId: crypto.randomUUID(), kind: 'put', payload });
    if (result.status !== 'saved-local') throw new Error(result.message ?? '保存结果待核对。');
    await this.store.clearEditor(scope);
  }
  async deleteRecord(domainId: string, row: import('@workspace/contracts').LocalRecord) { const entry=await this.registry.get(domainId);if(!entry.definition.actions.includes('delete'))throw new Error('插件未声明删除动作。');const content=await this.registry.contentStore(domainId);await content.commit({workspaceId:row.workspaceId,domainId,recordId:row.recordId,operationId:crypto.randomUUID(),kind:'delete',payloadJson:null},row.localSequence); }
  async createProject(name: string) { const id='preset.project.'+crypto.randomUUID();await this.registry.register(presetDefinition(id),crypto.randomUUID());await this.registry.manageProject(id,crypto.randomUUID(),name);await this.registry.setEnabled(id,true,crypto.randomUUID());return id; }
  async install(source: string) { const definition = parseExtension(source); await this.registry.register(definition, crypto.randomUUID()); }
  async sync() {
    if (this.syncing) return this.syncing;
    if (!this.current) return;
    if (this.current.replica.startsWith('restore-') && !this.current.endpoint && !this.current.authorityPath) { this.message = '当前为隔离恢复副本，请核验统一位置后接入。'; return; }
    const profile = this.current, store = this.store;
    this.syncing = (async () => {
      const credential = profile.endpoint ? JSON.parse(window.AndroidPlatform.credential('load', profile.key, '')) : null;
      if (profile.endpoint && !credential?.ok) throw new Error('请重新接入以恢复凭据。');
      const deviceId = profile.endpoint ? window.AndroidPlatform.syncDeviceId() : '';
      const remote = profile.endpoint ? new HttpSyncRemote(profile.endpoint, credential.value, deviceId ? { id: deviceId, name: 'Android' } : undefined) : (await localAuthority(profile.identity, this.programs, profile.authorityPath)).remote;
      const registrations = await store.listRecords({ workspaceId: profile.identity.workspaceId, domainId: 'system.domains' });
      await store.recoverFrozen(profile.identity.workspaceId);
      const errors = await new SyncEngine(profile.identity, store, remote, domainId => domainId === TODO_DOMAIN ? todoConflictPolicy : domainId === 'system.domains' ? { attributes: { enabled: ['enabled','removed'], name: ['displayName'], program: ['definition','fingerprint'] }, validate: () => undefined } : (() => {
        const registration = registrations.find(row => row.recordId === domainId)?.payload as unknown as DomainRegistration | undefined;
        return registration ? { attributes: {}, validate: value => { if (value !== null) validateExtensionRecord(registration.definition, value); } } : undefined;
      })()).run();
      for (const row of await store.listRecords({ workspaceId: profile.identity.workspaceId, domainId: 'system.domains' })) { const entry = row.payload as unknown as DomainRegistration | null; if (!row.deleted && entry && matchesPreset(entry.definition)) await this.programs.stage(entry.definition); }
      const status = await store.syncSummary(profile.identity.workspaceId);
      this.message = errors[0] ?? (status.conflicts ? `有 ${status.conflicts} 项冲突待处理。` : status.pending ? `有 ${status.pending} 项本机改动待同步。` : '已同步到统一位置。');
    })().catch(error => { this.message = error instanceof Error ? error.message : '服务器暂不可达，本机内容保留。'; }).finally(() => { this.syncing = null; });
    return this.syncing;
  }
  async topology() {
    const profile = this.current;
    if (!profile?.endpoint) return [];
    const credential = JSON.parse(window.AndroidPlatform.credential('load', profile.key, ''));
    if (!credential.ok) throw new Error('接入凭据不可用。');
    return new HttpSyncRemote(profile.endpoint, credential.value).topology(profile.identity);
  }
  async manage(method: string, input: JsonObject = {}): Promise<any> {
    const profile = this.current; if (!profile) throw new Error('请先选择空间。');
    if (profile.endpoint) {
      const credential = JSON.parse(window.AndroidPlatform.credential('load', profile.key, ''));
      if (!credential.ok) throw new Error('接入凭据不可用。');
      const response = await fetch(new URL('v1/mcp/' + method, profile.endpoint.endsWith('/') ? profile.endpoint : profile.endpoint + '/'), { method: 'POST', headers: { authorization: 'Bearer ' + credential.value, 'content-type':'application/json' }, body: JSON.stringify(input) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message ?? '管理操作尚未完成。'); return result;
    }
    if (profile.replica.startsWith('restore-') && !profile.authorityPath) throw new Error('隔离副本需要重新核验统一位置，才能管理授权或迁移。');
    if (!method.startsWith('migration-')) await this.sync();
    const authority = (await localAuthority(profile.identity,this.programs,profile.authorityPath)).store;
    if (method === 'export-snapshot') return {workspace:profile.identity,location:'Android 本机统一位置',snapshot:await authority.snapshot(this.workspaceId,'authority')};
    if (method.startsWith('migration-')) return authority.authorityControl(this.workspaceId,profile.identity.authorityId,method==='migration-status'?'status':method==='migration-stop'?'stop':'activate',input.isolated===true);
    const access = new McpAccess(this.workspaceId, authority, () => new Date().toISOString());
    if (method === 'grants') return authority.mcp({ method:'grant-list', workspaceId:this.workspaceId });
    if (method === 'calls') return authority.mcp({ method:'call-list', workspaceId:this.workspaceId });
    if (method === 'grant-revoke') return access.revoke(String(input.id));
    if (method === 'grant-create') {
      const secret = crypto.randomUUID() + crypto.randomUUID();
      const grant = await access.create(crypto.randomUUID(),String(input.name),input.domains as string[],input.actions as string[],window.AndroidPlatform.hash(secret));
      return {grant, secret};
    }
    throw new Error('当前本机管理动作不可用。');
  }
  async stopMigration() {
    await this.sync(); const summary=await this.store.syncSummary(this.workspaceId);
    if(summary.pending||summary.uncertain||summary.conflicts)throw new Error('请先处理待同步、结果待核对及冲突，再停止旧位置写入。');
    return this.manage('migration-stop');
  }
  async switchMigration(endpoint: string, token: string, isolated: boolean) {
    if(!this.current)throw new Error('请先选择原空间。');
    const original=this.current.identity, target=await this.inspect(endpoint,token);
    if(!target)throw new Error('目标空间尚未恢复。');
    const summary=await this.store.syncSummary(this.workspaceId);
    if(summary.pending||summary.uncertain||summary.conflicts)throw new Error('本机仍有尚未确认的成果，请先处理并核对材料覆盖范围。');
    let oldState:'active'|'stopped'|'unreachable'='unreachable';
    try{oldState=(await this.manage('migration-status')).state==='stopped'?'stopped':'active';}catch{}
    confirmMigrationBoundary(original,target,oldState,isolated);
    const response=await fetch(new URL('v1/mcp/migration-activate',endpoint.endsWith('/')?endpoint:endpoint+'/'),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({isolated})});
    const result=await response.json();if(!response.ok||result.state!=='active')throw new Error(result.message??'目标尚未明确启用，原绑定保留。');
    await this.connect(target,endpoint,token);
  }
  async exportBackup(source: 'local' | 'authority') {
    if (!this.current) throw new Error('请先选择空间。');
    let archive: Archive;
    if (source === 'authority') {
      await this.sync();
      const summary = await this.store.syncSummary(this.workspaceId);
      if (summary.pending || summary.uncertain || summary.conflicts) throw new Error('尚有待同步、结果待核对或冲突内容，请先处理。');
      archive = await this.manage('export-snapshot');
    } else archive = { workspace:this.current.identity,location:'Android 本机副本',snapshot:await this.store.snapshot(this.workspaceId,'local') };
    const payload = JSON.stringify(archive);
    await file('save', JSON.stringify({ format:'personal-workspace-archive',version:1,algorithm:'sha256',checksum:window.AndroidPlatform.hash(payload),payload }));
  }
  async previewBackup(): Promise<Archive> {
    const envelope = JSON.parse(await file('open'));
    if (envelope.format!=='personal-workspace-archive'||envelope.version!==1||envelope.algorithm!=='sha256'||typeof envelope.payload!=='string'||window.AndroidPlatform.hash(envelope.payload)!==envelope.checksum) throw new Error('备份格式不兼容或完整性校验失败。');
    const archive = JSON.parse(envelope.payload) as Archive, snapshot=archive.snapshot;
    if (!archive.workspace?.workspaceId || !archive.workspace.authorityId || snapshot?.format!=='workspace-snapshot'||snapshot.version!==1||snapshot.schemaVersion!==5||snapshot.workspaceId!==archive.workspace.workspaceId||!['local','authority'].includes(snapshot.source)||!Number.isSafeInteger(snapshot.revisionFloor)||snapshot.revisionFloor<0) throw new Error('备份身份或存储版本不兼容。');
    return archive;
  }
  async restoreBackup(archive: Archive) {
    // Always allocate a fresh database. Never overwrite an existing workspace.
    const replica='restore-'+crypto.randomUUID(), authorityPath=archive.snapshot.source==='authority'?'restored-authority-'+crypto.randomUUID():undefined;
    const store=await AndroidStore.open({databasePath:replica});
    if(authorityPath)await AndroidStore.open({databasePath:authorityPath});
    const db=new DatabaseSync(authorityPath??replica);
    const snapshot=archive.snapshot;
    const names=snapshot.source==='local'?['pending_operations','local_records','replica_progress','replica_cursors','operation_delivery','retained_conflicts','mcp_requests','mcp_calls','grant_definitions']:['authority_versions','authority_receipts','retained_conflicts','mcp_requests','mcp_calls','grant_definitions'];
    if(Object.keys(snapshot.tables).length!==names.length||Object.keys(snapshot.tables).some(n=>!names.includes(n)))throw new Error('备份材料不完整。');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE archive_grant_definitions (workspace_id TEXT NOT NULL,id TEXT NOT NULL,grant_json TEXT NOT NULL,PRIMARY KEY(workspace_id,id))');
      for(const name of names){
        const table=name==='grant_definitions'?'archive_grant_definitions':name, columns=db.prepare('PRAGMA table_info('+table+')').all().map((r:any)=>String(r.name));
        const rows=snapshot.tables[name];if(!Array.isArray(rows))throw new Error('备份缺少数据表。');
        for(const row of rows){
          if(Object.keys(row).length!==columns.length||columns.some((c:string)=>!Object.hasOwn(row,c))||(name!=='operation_delivery'&&row.workspace_id!==snapshot.workspaceId))throw new Error('备份字段或空间归属不匹配。');
          for(const [key,value] of Object.entries(row)){if(value!==null&&typeof value!=='string'&&!(typeof value==='number'&&Number.isSafeInteger(value)))throw new Error('备份含不支持的数据值。');if(key.endsWith('_json')&&value!==null)JSON.parse(String(value));}
          db.prepare('INSERT INTO '+table+' ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').run(...columns.map((c:string)=>row[c]));
        }
      }
      if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('备份引用不完整。');
      if(snapshot.source==='local'&&db.prepare('SELECT 1 FROM pending_operations p LEFT JOIN operation_delivery d ON p.sequence=d.sequence WHERE d.sequence IS NULL LIMIT 1').get())throw new Error('缺少原操作接续材料。');
      if(authorityPath){db.exec('CREATE TABLE workspace_restore (singleton INTEGER PRIMARY KEY CHECK(singleton=1),archive_json TEXT NOT NULL)');db.prepare('INSERT INTO workspace_restore VALUES(1,?)').run(JSON.stringify({source:snapshot.source,authorityState:snapshot.authorityState}));}
      if(authorityPath){db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='authority_versions'").run(snapshot.revisionFloor);if(!db.prepare("SELECT 1 FROM sqlite_sequence WHERE name='authority_versions'").get())db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('authority_versions',?)").run(snapshot.revisionFloor);}
      if(authorityPath)db.exec("CREATE TABLE authority_lifecycle (singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL CHECK(state IN ('active','stopped','prepared'))); INSERT INTO authority_lifecycle VALUES(1,'prepared')");
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    if(snapshot.source==='authority'){
      const latest=new Map<string,any>();
      for(const row of snapshot.tables.authority_versions??[])latest.set(String(row.domain_id)+'/'+String(row.record_id),row);
      for(const row of latest.values())await store.importVersion({workspaceId:archive.workspace.workspaceId,domainId:row.domain_id,recordId:row.record_id,revision:row.revision,value:JSON.parse(row.value_json),changed:JSON.parse(row.changed_json)},null,snapshot.revisionFloor,false);
    }
    // Restored credentials never regain authority; reconnect explicitly after reviewing identity.
    await this.addProfile({identity:archive.workspace,endpoint:'',key:'',replica,...(authorityPath?{authorityPath}:{})});
    this.message='已恢复到新的隔离副本；请核验当前统一位置后接入。旧授权未恢复效力。';
  }
  conflicts(domainId: string) { return this.store.listConflicts({ workspaceId: this.workspaceId, domainId }); }
  async resolve(domainId: string, recordId: string, generation: number, choice: ResolutionChoice) {
    const entry = await this.registry.get(domainId);
    await new ConflictService(this.store, domainId === TODO_DOMAIN ? todoConflictPolicy : { attributes: {}, validate: value => { if (value !== null) validateExtensionRecord(entry.definition, value); } }).saveChoice({ workspaceId: this.workspaceId, domainId, recordId }, generation, crypto.randomUUID(), choice, true);
  }
}
