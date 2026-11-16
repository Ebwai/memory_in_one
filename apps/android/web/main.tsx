import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { currentTodoRows, projectTodo, localCalendarDate, todoSubtreeBasis, type TodoCommand } from '@workspace/todo-list';
import { MobileStore, type NativeStorage } from './store';

declare global { interface Window { WorkspaceNative: NativeStorage } }
function App({ store }: { store: MobileStore }) {
  const [, render] = useState(0);
  const [screen, setScreen] = useState<'list' | 'spaces' | 'details'>('list');
  const [id, setId] = useState('');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [remove, setRemove] = useState(false);
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState({ text: '', notes: '', dueDate: '' });
  const [dirty, setDirty] = useState(false);
  const [leave, setLeave] = useState(false);
  const space = store.current;
  const rows = currentTodoRows(space?.rows ?? [], new Date().toISOString());
  const selected = rows.find(r => r.recordId === id && !r.deleted);
  const display = selected ? projectTodo(selected, localCalendarDate(new Date())) : null;
  function act(action: () => void) {
    try { action(); render(v => v + 1); setMessage('已保存在这台手机'); return true; }
    catch (e) { setMessage(e instanceof Error ? e.message : '尚未保存，请保留输入。'); return false; }
  }
  function back() { if (dirty || text.trim()) setLeave(true); else { setRemove(false); setScreen('list'); } }
  useEffect(() => { window.addEventListener('android:back', back); return () => window.removeEventListener('android:back', back); }, [dirty, text]);
  useEffect(() => {
    const timer = setInterval(() => render(v => v + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  function open(recordId: string) {
    const row = rows.find(r => r.recordId === recordId);
    if (!row?.payload) return;
    setId(recordId); setDraft({ text: String(row.payload.text), notes: String(row.payload.notes ?? ''), dueDate: String(row.payload.dueDate ?? '') }); setDirty(false); setScreen('details');
  }
  function mutate(command: TodoCommand) { return act(() => store.mutate(id, command)); }
  return <main>
    <header><span className="mark">▦</span><strong>我的工作空间</strong><span className="edition">ANDROID DEV</span></header>
    <div className="intro"><small>想法 · 计划 · 行动</small><h1>{screen === 'spaces' ? '每一个空间，' : screen === 'details' ? '把事情想清楚。' : '今天，向前一步。'}</h1><p>{screen === 'spaces' ? '都有独立的想法与进度。' : space?.name ?? '创建你的第一个本机空间。'}</p></div>
    <nav><button onClick={back}>← {screen === 'list' ? '工作台' : '返回'}</button><button onClick={() => { if (dirty || text.trim()) setLeave(true); else setScreen('spaces'); }}>▦ 空间</button></nav>
    <p className="notice">开发版 · 当前仅验证本机空间与待办。服务器同步、SSH、MCP、插件和备份恢复尚未接入。</p>
    {message && <p role="status" className="status">{message}</p>}
    {(screen === 'spaces' || !space) && <section aria-label="工作空间"><h2>我的空间</h2>{store.state.spaces.map(s => <button className="space" key={s.id} onClick={() => { if (act(() => store.select(s.id))) { setScreen('list'); setId(''); } }} aria-pressed={s.id === space?.id}><strong>▦ {s.name}</strong><small>本机手机 {s.id === space?.id ? '· 当前空间' : ''}</small></button>)}<form onSubmit={e => { e.preventDefault(); if (act(() => store.createSpace(name))) { setName(''); setScreen('list'); } }}><label>新空间名称<input value={name} onChange={e => setName(e.target.value)} maxLength={100} required /></label><button className="primary">＋ 创建本机空间</button></form></section>}
    {space && screen === 'list' && <>
      <form className="capture" onSubmit={e => { e.preventDefault(); if (act(() => store.add(text))) setText(''); }}><label htmlFor="capture">记下一件事</label><textarea id="capture" placeholder="此刻，想做些什么？" value={text} onChange={e => setText(e.target.value)} /><button className="primary" disabled={!text.trim()}>＋ 添加待办</button></form>
      <div className="filters">{[['all','全部'],['active','进行中'],['done','已完成']].map(([value,label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value!)}>{label}</button>)}</div>
      <section aria-label="待办列表" className="tasks">{rows.filter(r => !r.deleted).filter(r => filter === 'all' || (r.payload?.completed === true) === (filter === 'done')).map(r => {
        const item = projectTodo(r, localCalendarDate(new Date()))!;
        return <article key={r.recordId} data-completed={item.status === 'completed'}><button className="check" aria-label={(item.status === 'completed' ? '恢复：' : '完成：') + item.text} onClick={() => act(() => store.mutate(r.recordId, { kind: 'complete', completed: item.status !== 'completed' }))}>{item.status === 'completed' ? '■' : '□'}</button><button className="task" onClick={() => open(r.recordId)}><span>{r.payload?.parentId ? '↳ ' : ''}{item.text}</span>{item.dateLabel && <small>{item.dateLabel}</small>}{item.repeatFrequency && <small>重复 · {item.repeatCount}/{item.repeatTarget}</small>}</button><button aria-label={'删除：' + item.text} onClick={() => { open(r.recordId); setRemove(true); }}>×</button></article>;
      })}{!rows.some(r => !r.deleted) && <p className="empty">留一点空白，给接下来的行动。</p>}</section>
    </>}
    {space && screen === 'details' && display && <section className="details"><h2>任务详情</h2><label>任务内容<textarea value={draft.text} onChange={e => { setDraft({ ...draft, text: e.target.value }); setDirty(true); }} /></label><label>备注<textarea value={draft.notes} onChange={e => { setDraft({ ...draft, notes: e.target.value }); setDirty(true); }} /></label><label>截止日期<input type="date" value={draft.dueDate} onChange={e => { setDraft({ ...draft, dueDate: e.target.value }); setDirty(true); }} /></label><button className="primary" onClick={() => {
      // A single native commit covers all fields; never leave a partly saved editor.
      act(() => {
        const original = store.state;
        const buffer: NativeStorage = { load: () => JSON.stringify({ ok: true, revision: 0, state: original }), commit: (_, body) => JSON.stringify({ ok: true, revision: 0 }) };
        let next = original;
        buffer.commit = (_, body) => { next = JSON.parse(body); return JSON.stringify({ ok: true, revision: 0 }); };
        const temporary = new MobileStore(buffer);
        temporary.mutate(id, { kind: 'text', text: draft.text }); temporary.mutate(id, { kind: 'notes', notes: draft.notes }); temporary.mutate(id, { kind: 'date', dueDate: draft.dueDate || null });
        store.save(next); setDirty(false);
      });
    }}>保存修改</button><label>重复规则<select value={display.repeatFrequency ?? ''} onChange={e => mutate({ kind: 'repeat', frequency: (e.target.value || null) as 'day' | 'week' | 'month' | null, target: 1, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}><option value="">不重复</option><option value="day">每天</option><option value="week">每周</option><option value="month">每月</option></select></label><form onSubmit={e => { e.preventDefault(); if (act(() => store.add(text, id))) setText(''); }}><label>添加子待办<input value={text} onChange={e => setText(e.target.value)} /></label><button disabled={!text.trim()}>＋ 添加子待办</button></form><button className="danger" onClick={() => setRemove(true)}>删除任务及子待办</button></section>}
    {remove && selected && <div className="modal" role="dialog" aria-modal="true" aria-label="删除确认"><section><h2>确认删除？</h2><p>这条任务及其全部子待办将被删除。</p><button className="danger" onClick={() => { if (mutate({ kind: 'delete', confirmed: true, subtreeBasis: todoSubtreeBasis(rows, id) })) { setRemove(false); setScreen('list'); setDirty(false); } }}>确认删除</button><button onClick={() => setRemove(false)}>保留</button></section></div>}
    {leave && <div className="modal" role="dialog" aria-modal="true" aria-label="保留输入"><section><h2>还有未保存的输入</h2><p>可以返回继续编辑，或明确放弃本次输入。</p><button onClick={() => setLeave(false)}>继续编辑</button><button onClick={() => { setDirty(false); setText(''); setLeave(false); setScreen('list'); }}>放弃输入并返回</button></section></div>}
    <footer>本机保存 · 数据独立于 Windows 版</footer>
  </main>;
}
try { const store = new MobileStore(window.WorkspaceNative); createRoot(document.getElementById('root')!).render(<App store={store} />); }
catch (e) { document.getElementById('root')!.textContent = e instanceof Error ? e.message : '无法读取本机空间。'; }
