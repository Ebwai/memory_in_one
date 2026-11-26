import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { selectAndroidUpdate, type AndroidUpdate } from './update';
import { nativeCall } from './native-call';
import { ConnectionTopology } from './connection-topology';
import { RecordEditor } from './record-editor';
import { Client } from './client';
import { installNetwork } from './network';
import { file } from './files';
import { TODO_DOMAIN, currentTodoRows, filterTodoTree, groupTodoTree, type TodoFilterStatus, localCalendarDate, todoSubtreeBasis } from '@workspace/todo-list';
import { noteTitle, NOTES_DOMAIN, isProjectDomain, type DomainEntry, type LocalRecord, type RetainedConflict, type WorkspaceIdentity, type JsonObject } from '@workspace/contracts';

const defaultSshConfig = {host:'',user:'',port:22,remotePort:43127,localPort:42081,fingerprint:'',password:'',privateKey:'',passphrase:''};
type SshConfig = typeof defaultSshConfig;

function App({ client, savedSshConfig }: { client: Client; savedSshConfig: SshConfig | null }) {
  const [page, setPage] = useState('content'), [domain, setDomain] = useState(TODO_DOMAIN);
  const [domains, setDomains] = useState<readonly DomainEntry[]>([]), [rows, setRows] = useState<readonly LocalRecord[]>([]);
  const [conflicts, setConflicts] = useState<readonly RetainedConflict[]>([]);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [text, setText] = useState(''), [name, setName] = useState(''), [url, setUrl] = useState(''), [token, setToken] = useState('');
  const [verified, setVerified] = useState<WorkspaceIdentity | null>(null), [source, setSource] = useState('');
  const [noteHeading, setNoteHeading] = useState('');
  const [selected, setSelected] = useState<LocalRecord | null>(null);
  const [editingConflict, setEditingConflict] = useState<string | null>(null);
  const [selectedOriginal, setSelectedOriginal] = useState<JsonObject | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [confirmation, setConfirmation] = useState<null | { label: string; action: () => Promise<void> }>(null);
  const [mcp, setMcp] = useState<any>(null), [grantDomains, setGrantDomains] = useState(''), [grantActions, setGrantActions] = useState('read');
  const [filter, setFilter] = useState('all');
  const [todoStatus, setTodoStatus] = useState<TodoFilterStatus>('all');
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [deadlineEnabled, setDeadlineEnabled] = useState(true);
  const [timeField, setTimeField] = useState<'createdAt' | 'dueDate' | 'completedAt'>('dueDate');
  const [keyword, setKeyword] = useState('');
  const [deadlineStart, setDeadlineStart] = useState('');
  const [deadlineEnd, setDeadlineEnd] = useState('');
  const [offer,setOffer]=useState<AndroidUpdate|null>(null);
  const [isolated,setIsolated]=useState(false),[projectKind,setProjectKind]=useState('task');
  const [sshConfig,setSshConfig] = useState(savedSshConfig ?? defaultSshConfig);
  const [hasSavedSshConfig,setHasSavedSshConfig] = useState(!!savedSshConfig);
  async function refresh() {
    if (!client.current) return;
    const entries = await client.registry.list(); setDomains(entries);
    setRows(await client.rows(domain)); setConflicts(await client.conflicts(domain));
  }
  async function run(action: () => Promise<unknown>, success = '已保存在手机。') {
    if (busy) return false; setBusy(true); setMessage('');
    try { await action(); await refresh(); setMessage(success); return true; }
    catch (e) { setMessage(e instanceof Error ? e.message : '操作尚未完成，原输入保留。'); return false; }
    finally { setBusy(false); }
  }
  useEffect(()=>{setText(client.loadCapture(domain));setNoteHeading(client.loadCapture(domain + ':title'));setCollapsed(new Set());},[domain,client.current?.replica]);
  useEffect(() => { void refresh().catch(e => setMessage(e.message)); }, [domain, client.current?.replica]);
  useEffect(() => {
    const timer = setInterval(() => { if (!busy) void client.sync().then(refresh).catch(e => setMessage(e.message)); }, 10000);
    const back = () => { if (selected || editingConflict) return; if (confirmation) { setConfirmation(null); return; } if (text.trim() || noteHeading.trim()) setConfirmation({ label: '放弃当前未保存输入并返回？', action: async () => { setSelected(null); client.saveCapture(domain,'');client.saveCapture(domain + ':title','');setNoteHeading('');setText(''); setPage('content'); } }); else if(page==='content')window.AndroidPlatform.background();else setPage('content'); };
    window.addEventListener('android:back', back);
    return () => { clearInterval(timer); window.removeEventListener('android:back', back); };
  }, [busy, domain, selected, text, noteHeading, page, confirmation, editingConflict]);
  const entry = domains.find(e => e.definition.domainId === domain);
  const projected = domain === TODO_DOMAIN ? currentTodoRows(rows, new Date().toISOString()) : rows;
  const today = localCalendarDate(new Date());
  const tree = groupTodoTree(projected, today);
  const nodes = [...tree.unfinished, ...tree.completed];
  const nodesById = new Map(nodes.map(node => [node.recordId, node]));
  const rowsById = new Map(projected.map(row => [row.recordId, row]));
  const contentRows = domain === TODO_DOMAIN ? nodes.flatMap(node => {
    const row = rowsById.get(node.recordId);
    return row ? [row] : [];
  }) : projected;
  const hidden = new Set<string>();
  for (const node of nodes) {
    if (node.parentId && (collapsed.has(node.parentId) || hidden.has(node.parentId))) hidden.add(node.recordId);
  }
  const filteredTodos = filterEnabled && domain === TODO_DOMAIN ? new Set(filterTodoTree(nodes, todoStatus, today,
    deadlineEnabled ? { start: deadlineStart, end: deadlineEnd, field: timeField } : undefined, keyword).map(node => node.recordId)) : null;
  const visibleRows = contentRows.filter(row => {
    if (row.deleted) return false;
    if (domain === TODO_DOMAIN) return filteredTodos ? filteredTodos.has(row.recordId) : !hidden.has(row.recordId);
    return filter === 'all' || (row.payload?.completed === true) === (filter === 'done');
  });
  function toggleChildren(recordId: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  }
  return <main><header><span className="mark">▦</span><strong>我的工作空间</strong><span className="edition">ANDROID</span></header><div className="intro"><h1>{page === 'content' ? '今天，向前一步' : '控制中心'}</h1><p>{client.current?.identity.name ?? '创建或接入你的空间'}</p></div>
    <nav className="filters workspace-nav">{[['content','内容'],['spaces','空间'],['plugins','插件'],['server','服务器'],['mcp','MCP'],['backup','备份'],['settings','设置']].map(([id,label]) => <button disabled={busy} key={id} aria-pressed={page===id} onClick={() => { if (selected || text.trim() || noteHeading.trim()) { setMessage('请先保存或清空当前输入，再切换页面。'); return; } setPage(id!); }}>{label}</button>)}</nav>
    <p role="status" className="status">{message || client.message}</p>{busy && <p>正在处理，请稍候…</p>}
    {page === 'spaces' && <section><h2>工作空间</h2>{client.profiles.map(profile => <button key={profile.replica} className="space" disabled={busy} onClick={() => void run(async () => { await client.select(profile.replica); setDomain(TODO_DOMAIN); setPage('content'); })} aria-pressed={profile.replica===client.current?.replica}>{profile.identity.name}<small>{profile.endpoint || '本机手机'}</small></button>)}<label>新空间名称<input value={name} onChange={e=>setName(e.target.value)}/></label><button disabled={busy} onClick={()=>void run(async()=>{await client.createLocal(name);setName('');setDomain(TODO_DOMAIN);})}>创建本机空间</button><h2>接入服务器空间</h2><label>HTTPS 地址<input type="url" value={url} onChange={e=>{setUrl(e.target.value);setVerified(null);}}/></label><label>接入凭据<input type="password" autoComplete="off" value={token} onChange={e=>{setToken(e.target.value);setVerified(null);}}/></label><button disabled={busy} onClick={()=>void run(async()=>{const found=await client.inspect(url,token);if(!found)throw new Error('服务器尚无空间。');setVerified(found);},'请核对空间身份后确认接入。')}>核验空间</button>{verified && <section><h3>{verified.name}</h3><p>{verified.workspaceId}</p><p>{verified.authorityId}</p><button disabled={busy} onClick={()=>void run(async()=>{await client.connect(verified,url,token);setToken('');setVerified(null);setPage('content');},'已接入同一工作空间。')}>确认接入</button></section>}</section>}
    {page === 'content' && client.current && <><label>插件<select value={domain} disabled={busy || !!selected || !!text.trim() || !!noteHeading.trim()} onChange={e=>setDomain(e.target.value)}>{domains.filter(e=>e.enabled&&!e.removed&&e.programAvailable).map(e=><option key={e.definition.domainId} value={e.definition.domainId}>{e.displayName??e.definition.name}</option>)}</select></label>
      {entry?.enabled && entry.programAvailable ? <>{domain!==TODO_DOMAIN&&!domain.startsWith('preset.')?<button disabled={busy} onClick={()=>{const payload:JsonObject={};for(const [key,rule]of Object.entries(entry.definition.schema.properties as Record<string,any>))payload[key]=rule.enum?.[0]??(rule.type==='boolean'?false:rule.type==='number'?0:'');setSelectedOriginal(payload);setSelected({workspaceId:client.current!.identity.workspaceId,domainId:domain,recordId:crypto.randomUUID(),localSequence:0,deleted:false,payload});}}>＋ 新建内容</button>:<form className="capture" onSubmit={e=>{e.preventDefault();void run(async()=>{if(domain===TODO_DOMAIN)await client.addTodo(text);else {let payload:JsonObject;if(domain===NOTES_DOMAIN)payload={text,title:noteHeading,createdAt:new Date().toISOString()};else if(isProjectDomain(domain))payload={text,kind:projectKind,completed:false,createdAt:new Date().toISOString()};else payload=JSON.parse(text);await client.saveRecord(domain,crypto.randomUUID(),payload);}client.saveCapture(domain,'');client.saveCapture(domain + ':title','');setNoteHeading('');setText('');});}}>{domain === NOTES_DOMAIN && <label>标题（选填）<input value={noteHeading} onChange={event => { setNoteHeading(event.target.value); try { client.saveCapture(domain + ":title",event.target.value); } catch { setMessage("标题草稿暂未保存，请保留输入。"); } }} /></label>}<label>{domain === NOTES_DOMAIN ? "正文（必填）" : "记下一件事"}<textarea required={domain === NOTES_DOMAIN} value={text} onChange={e=>{try{client.saveCapture(domain,e.target.value);setText(e.target.value);}catch{setText(e.target.value);setMessage('输入草稿暂未保存，请保留内容。');}}} placeholder={domain.startsWith('preset.')||domain===TODO_DOMAIN?'记录内容…':'按插件字段输入 JSON 对象…'}/></label>{isProjectDomain(domain)&&<label>内容类型<select value={projectKind} onChange={e=>setProjectKind(e.target.value)}><option value="task">待办</option><option value="idea">想法</option></select></label>}<button disabled={busy||!text.trim()} className="primary">＋ 保存</button></form>}
      {domain === TODO_DOMAIN ? <>
        <div className="todo-filter-controls"><h2>未完成</h2>
          <button type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen(open => !open)}>筛选</button>
        </div>
        {filterOpen && <fieldset className="todo-filter-fields">
          <legend>筛选策略</legend>
          <label className="todo-deadline-enabled"><input type="checkbox" checked={filterEnabled} onChange={event => setFilterEnabled(event.target.checked)} />启用筛选</label>
          <label>关键字<input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索内容或备注" /></label>
          <label>时间类型<select value={timeField} onChange={event => setTimeField(event.target.value as typeof timeField)}>
            <option value="createdAt">创建时间</option><option value="dueDate">截止时间</option><option value="completedAt">完成时间</option>
          </select></label>
          <label>完成状态<select value={todoStatus} onChange={event => setTodoStatus(event.target.value as TodoFilterStatus)}>
            <option value="all">全部</option><option value="unfinished">仅显示未完成</option><option value="completed">仅显示完成</option>
          </select></label>
          <label className="todo-deadline-enabled"><input type="checkbox" checked={deadlineEnabled} onChange={event => setDeadlineEnabled(event.target.checked)} />按时间筛选</label>
          {deadlineEnabled && <>
            <label>起点（留空为最早）<input type="datetime-local" step={60} value={deadlineStart} onChange={event => setDeadlineStart(event.target.value)} /></label>
            <label>终点（留空为今天 24:00）<input type="datetime-local" step={60} value={deadlineEnd} onChange={event => setDeadlineEnd(event.target.value)} /></label>
          </>}
        </fieldset>}
        {filterEnabled && !visibleRows.length && <p>没有符合筛选条件的待办。</p>}
      </> : <div className="filters">{[['all','全部'],['active','进行中'],['done','已完成']].map(([id,label])=><button key={id} aria-pressed={filter===id} onClick={()=>setFilter(id!)}>{label}</button>)}</div>}
      <section className="tasks">{visibleRows.map(row=>{const item=domain===TODO_DOMAIN?nodesById.get(row.recordId):undefined;
        const prerequisite = item && typeof row.payload?.prerequisiteId === 'string' ? row.payload.prerequisiteId : null;
        const blocked = item?.status !== 'completed' && prerequisite !== null && rowsById.get(prerequisite)?.payload?.completed !== true;
        const completionLabel = blocked ? '请先完成前置任务' : '切换完成状态';
        return <article key={row.recordId} style={{paddingInlineStart: item ? `${item.depth}em` : undefined}}>
        {item && (item.childCount > 0 && !filteredTodos ? <button type="button" className="tree-toggle" aria-label={(collapsed.has(row.recordId) ? '展开子待办：' : '折叠子待办：') + item.text} aria-expanded={!collapsed.has(row.recordId)} onClick={() => toggleChildren(row.recordId)}>{collapsed.has(row.recordId) ? '▸' : '▾'}</button> : <span className="tree-toggle-spacer" aria-hidden="true" />)}<button className="check" hidden={domain === NOTES_DOMAIN} disabled={busy||domain===NOTES_DOMAIN||blocked} aria-label={completionLabel} title={blocked ? completionLabel : undefined} onClick={()=>void run(async()=>{if(domain===TODO_DOMAIN)await client.todo(row.recordId,{kind:'complete',completed:item?.status!=='completed'});else {if(row.payload?.kind==='idea')throw new Error('想法无需完成，可编辑为待办后推进。');await client.saveRecord(domain,row.recordId,{...row.payload!,completed:!row.payload?.completed},row.localSequence);}})}>{(item?.status==='completed'||row.payload?.completed)?'■':'□'}</button><button className="task" onClick={()=>void run(async()=>{const editor=await client.store.editor({workspaceId:row.workspaceId,domainId:domain,recordId:row.recordId});setSelectedOriginal(row.payload ?? {});setSelected(editor?{...row,payload:editor.value,localSequence:editor.baseSequence}:row);},'')}>{domain === NOTES_DOMAIN ? noteTitle(row.payload) : item?.text??String(row.payload?.[entry.definition.view.titleField]??row.recordId)}{item?.dateLabel&&<small>{item.dateLabel}</small>}</button><button disabled={busy} aria-label="删除内容" onClick={()=>setConfirmation({label:'删除此内容及其全部子待办？',action:async()=>{if(domain===TODO_DOMAIN)await client.todo(row.recordId,{kind:'delete',confirmed:true,subtreeBasis:todoSubtreeBasis(contentRows,row.recordId)});else await client.deleteRecord(domain,row);}})}>×</button></article>;})}</section></>:<p>当前插件已停用或缺少兼容程序，请到插件管理处理。</p>}
      {selected && entry && <RecordEditor key={selected.recordId} row={selected} original={selectedOriginal ?? selected.payload ?? {}} entry={entry} busy={busy} message={message}
        protect={selected.localSequence > 0 ? async value => {
          try {
            await client.store.saveEditor({workspaceId:selected.workspaceId,domainId:domain,recordId:selected.recordId,value,baseSequence:selected.localSequence,operationId:'editor-'+selected.recordId});
          } catch { setMessage('编辑保护暂未保存，请保留输入。'); }
        } : undefined}
        todoRows={domain === TODO_DOMAIN ? contentRows : undefined}
        save={(value, move) => run(async () => {
          if (domain === TODO_DOMAIN) await client.editTodo(selected.recordId,selected.localSequence,value,move);
          else await client.saveRecord(domain,selected.recordId,value,selected.localSequence);
          setSelected(null);
        })}
        discard={() => run(async () => {
          if (selected.localSequence > 0) await client.store.clearEditor({workspaceId:selected.workspaceId,domainId:domain,recordId:selected.recordId});
          setSelected(null);
        }, '')}
        tools={domain === TODO_DOMAIN && text.trim() ? <button onClick={() => void run(async () => {
          await client.addTodo(text,selected.recordId);
          client.saveCapture(domain,'');
          setText('');
        })}>把录入内容添加为子待办</button> : undefined}
      />}
      {!!conflicts.filter(c=>c.status==='pending').length&&<section><h2>冲突处理</h2>{conflicts.filter(c=>c.status==='pending').map(c=><section key={c.recordId}><p>{c.recordId} · {c.reasons.join('；')}</p><p>本机：{String(c.comparison.local.value?.text??(c.comparison.local.value?'保留的本机内容':'已删除'))}</p><p>服务器：{String(c.comparison.remote?.value?.text??(c.comparison.remote?.value?'保留的服务器内容':'已删除'))}</p>{(['local','remote','delete'] as const).map(choice=><button disabled={busy} key={choice} onClick={()=>setConfirmation({label:`确认采用${choice==='local'?'本机':choice==='remote'?'服务器':'删除'}结果？`,action:async()=>{await client.resolve(domain,c.recordId,c.generation,{kind:choice});await client.sync();}})}>{choice==='local'?'保留本机':choice==='remote'?'采用服务器':'确认删除'}</button>)}{entry && <button disabled={busy} onClick={() => { setMessage(''); setEditingConflict(c.recordId); }}>手动整理 / 恢复内容</button>}
        {entry && editingConflict === c.recordId && <RecordEditor key={c.recordId} row={{workspaceId:c.workspaceId,domainId:c.domainId,recordId:c.recordId,localSequence:0,deleted:false,payload:c.comparison.local.value??c.comparison.remote?.value??{}}}
          original={c.comparison.local.value ?? c.comparison.remote?.value ?? {}} entry={entry} busy={busy} message={message}
          save={value => run(async () => {
            await client.resolve(domain,c.recordId,c.generation,{kind:c.comparison.local.value===null||c.comparison.remote?.value===null?'restore':'manual',value});
            setEditingConflict(null);
            await client.sync();
          })}
          discard={async () => { setEditingConflict(null); return true; }}
        />}</section>)}</section>}</>}
    {page==='plugins'&&client.current&&<section><h2>插件管理</h2>{domains.map(e=><section className="space" key={e.definition.domainId}><h3>{e.displayName??e.definition.name}</h3><p>{e.definition.domainId} · {e.enabled?'已启用':'已停用'} · {e.programAvailable?'程序可用':'需补齐程序'}</p><button disabled={busy} onClick={()=>void run(()=>client.registry.setEnabled(e.definition.domainId,!e.enabled,crypto.randomUUID()))}>{e.enabled?'停用':'启用'}</button><button disabled={busy} onClick={()=>setConfirmation({label:'仅移除此手机上的程序？原登记和内容保留。',action:()=>client.registry.removeProgram(e.definition.domainId)})}>移除本机程序</button>{isProjectDomain(e.definition.domainId)&&<><button disabled={busy||!name.trim()} onClick={()=>void run(()=>client.registry.manageProject(e.definition.domainId,crypto.randomUUID(),name))}>按所填名称重命名</button><button disabled={busy} onClick={()=>setConfirmation({label:'删除整个项目？项目内全部内容将随项目隐藏，并同步删除状态。',action:()=>client.registry.manageProject(e.definition.domainId,crypto.randomUUID(),null)})}>删除整个项目</button></>}</section>)}<label>项目名称（新建或重命名）<input value={name} onChange={e=>setName(e.target.value)}/></label><button disabled={busy} onClick={()=>void run(async()=>{await client.createProject(name);setName('');})}>按项目模板新建</button><label>扩展 JSON<textarea value={source} onChange={e=>setSource(e.target.value)}/></label><button disabled={busy} onClick={()=>void run(()=>client.install(source))}>注册 / 补齐插件</button></section>}
    {page==='server'&&<section><h2>服务器与同步</h2><ConnectionTopology key={client.current?.replica} client={client} /><h3>SSH 加密连接</h3>{hasSavedSshConfig && <p>已保存 SSH 连接配置</p>}{([['host','服务器地址'],['user','SSH 用户'],['fingerprint','已核验的 SHA256 主机指纹'],['password','SSH 密码'],['passphrase','私钥口令']] as const).map(([key,label])=><label key={key}>{label}<input type="text" autoComplete="off" spellCheck={false} value={sshConfig[key]} onChange={e=>setSshConfig({...sshConfig,[key]:e.target.value})}/></label>)}{([['port','SSH 端口'],['remotePort','远端服务端口'],['localPort','手机回环端口']] as const).map(([key,label])=><label key={key}>{label}<input type="number" value={sshConfig[key]} onChange={e=>setSshConfig({...sshConfig,[key]:Number(e.target.value)})}/></label>)}<label>私钥（可选）<textarea value={sshConfig.privateKey} onChange={e=>setSshConfig({...sshConfig,privateKey:e.target.value})}/></label><button disabled={busy} onClick={()=>void run(async()=>{const result=await nativeCall('ssh',{action:'connect',config:JSON.stringify(sshConfig)});if(!result.ok)throw new Error(result.message);const saved=JSON.parse(window.AndroidPlatform.credential('save','ssh-config',JSON.stringify(sshConfig)));if(!saved.ok)throw new Error('隧道已连接，但配置保存失败。');setUrl(result.value);setPage('spaces');setHasSavedSshConfig(true);},'SSH 已连接。请核验转发地址的空间身份后接入。')}>建立 SSH 隧道</button><button disabled={busy} onClick={()=>void run(async()=>{const result=await nativeCall('ssh',{action:'disconnect',config:''});if(!result.ok)throw new Error(result.message);})}>断开 SSH</button><p>{client.current?.endpoint||'当前为手机本机空间。'}</p><button disabled={busy||!client.current} onClick={()=>void run(()=>client.sync(),client.message)}>立即同步</button><p>接入远程空间后每 10 秒尝试接续；离线修改先保存本机，联网后补同步。</p></section>}
    {page==='mcp'&&client.current&&<section><h2>MCP 授权与调用</h2><button disabled={busy} onClick={()=>void run(async()=>setMcp({grants:await client.manage('grants'),calls:await client.manage('calls')}))}>刷新授权与调用记录</button><pre>{mcp?JSON.stringify(mcp,null,2):'点击刷新读取当前空间。'}</pre><label>授权名称<input value={name} onChange={e=>setName(e.target.value)}/></label><label>领域 ID（逗号分隔）<input value={grantDomains} onChange={e=>setGrantDomains(e.target.value)}/></label><label>动作（逗号分隔）<input value={grantActions} onChange={e=>setGrantActions(e.target.value)}/></label><button disabled={busy} onClick={()=>void run(async()=>setMcp(await client.manage('grant-create',{name,domains:grantDomains.split(',').map(s=>s.trim()),actions:grantActions.split(',').map(s=>s.trim())})), '授权已创建，请妥善保管仅展示一次的凭据。')}>创建授权</button><label>撤销授权 ID<input value={source} onChange={e=>setSource(e.target.value)}/></label><button disabled={busy} onClick={()=>setConfirmation({label:'撤销该 MCP 授权？',action:async()=>{await client.manage('grant-revoke',{id:source});}})}>撤销授权</button></section>}
    {page==='backup'&&client.current&&<section><h2>备份与恢复</h2><button disabled={busy} onClick={()=>void run(()=>client.exportBackup('local'))}>导出手机本机副本</button><button disabled={busy} onClick={()=>void run(()=>client.exportBackup('authority'))}>同步后导出统一位置完整备份</button><button disabled={busy} onClick={()=>void run(async()=>{const archive=await client.previewBackup();setConfirmation({label:`恢复「${archive.workspace.name}」的${archive.snapshot.source==='local'?'本机副本':'统一位置快照'}到新的隔离位置？现有空间不覆盖，旧授权不会恢复效力。`,action:async()=>{await client.restoreBackup(archive);setPage('content');}});})}>选择备份并预览恢复</button><h2>迁移切换</h2><button disabled={busy} onClick={()=>void run(async()=>setSource(JSON.stringify(await client.manage('migration-status'))),'已读取位置状态。')}>核对当前写入状态</button><p>{source}</p><button disabled={busy} onClick={()=>setConfirmation({label:'确认停止当前权威位置写入？请在停止后导出完整备份，再恢复目标。',action:async()=>{await client.stopMigration();}})}>停止旧位置写入</button><label><input type="checkbox" checked={isolated} onChange={e=>setIsolated(e.target.checked)}/>我已确认旧位置停用或隔离，并核对备份覆盖范围</label>{client.current.authorityPath&&<button disabled={busy||!isolated} onClick={()=>setConfirmation({label:'确认将当前隔离恢复的权威空间启用为唯一可写位置？',action:async()=>{await client.manage('migration-activate',{isolated});await client.sync();}})}>启用恢复的本机权威位置</button>}<label>已恢复的目标服务器地址<input value={url} onChange={e=>setUrl(e.target.value)}/></label><label>目标所有者凭据<input type="password" value={token} onChange={e=>setToken(e.target.value)}/></label><button disabled={busy||!url||!token} onClick={()=>setConfirmation({label:'核验同一空间与旧位置停写后，明确启用目标并切换？',action:async()=>{await client.switchMigration(url,token,isolated);setToken('');}})}>核验并切换迁移目标</button></section>}
    {page==='settings'&&<section><h2>应用设置</h2><p>版本 1.3.5 · Android</p><button disabled={busy} onClick={()=>void run(async()=>{const response=await fetch('https://api.github.com/repos/Ebwai/memory_in_one/releases?per_page=100');if(!response.ok)throw new Error('暂时无法检查更新。');const found=selectAndroidUpdate(await response.json());setOffer(found);if(!found)setMessage('尚无可安装的更新版本。');},'版本检查完成。')}>检查更新</button>{offer&&<section><h3>新版本 {offer.version}</h3><p>{offer.notes}</p><button disabled={busy} onClick={()=>setConfirmation({label:'下载已核验来源的新版 APK，并交给 Android 系统确认安装？',action:async()=>{await nativeCall('update',offer as unknown as Record<string,unknown>);}})}>下载并安装更新</button></section>}<p>Android · 应用内工作台 · 无悬浮窗</p><button disabled={busy} onClick={()=>void run(()=>file('install'))}>选择新版 APK，交给系统安装</button><p>更新必须使用相同应用签名，由 Android 系统确认。</p></section>}
    {!client.current&&page!=='spaces'&&<button onClick={()=>setPage('spaces')}>创建或接入工作空间</button>}
    {confirmation&&<div className="modal" role="dialog" aria-modal="true"><section><h2>请核对操作</h2><p>{confirmation.label}</p><button disabled={busy} onClick={()=>void run(async()=>{await confirmation.action();setConfirmation(null);})}>确认</button><button disabled={busy} onClick={()=>setConfirmation(null)}>取消</button></section></div>}<footer>保存与同步状态分别确认 · 数据按工作空间隔离</footer>
  </main>;
}
installNetwork();
const client = new Client();
if (window.AndroidPlatform.debug()) (window as any).__workspaceClient = client;
document.getElementById('root')!.textContent='正在读取本机空间…';
const initialize = async (): Promise<SshConfig | null> => {
  let savedConfig: SshConfig | null = null;
  try {
    const saved = JSON.parse(window.AndroidPlatform.credential('load', 'ssh-config', ''));
    if (saved.ok) {
      savedConfig = { ...defaultSshConfig, ...JSON.parse(saved.value) };
      await nativeCall('ssh', { action: 'connect', config: saved.value });
    }
  } catch { client.message = 'SSH 暂未连接，本机内容可继续使用。'; }
  await client.load();
  return savedConfig;
};
initialize().then(savedSshConfig => createRoot(document.getElementById('root')!).render(<App client={client} savedSshConfig={savedSshConfig}/>))
  .catch(e => { document.getElementById('root')!.textContent = e.message; });
