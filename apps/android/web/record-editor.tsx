import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { canonical } from '@workspace/contracts';
import { TODO_DOMAIN, type TodoCommand } from '@workspace/todo-list';
import type { DomainEntry, JsonObject, LocalRecord } from '@workspace/contracts';
const labels:Record<string,string>={text:'内容',notes:'备注',dueDate:'截止日期',repeatFrequency:'重复规则',repeatTarget:'每周期完成次数',kind:'条目类型',completed:'已完成'};
export type TodoMove = Extract<TodoCommand, { kind: 'move' }>;
export function RecordEditor({row,original,entry,busy,message,save,discard,protect,tools,todoRows}:{
  row: LocalRecord; original: JsonObject; entry: DomainEntry; busy: boolean; message: string;
  save: (value: JsonObject, move?: TodoMove) => Promise<boolean>; discard: () => Promise<boolean>;
  protect?: (value: JsonObject) => Promise<void>; tools?: ReactNode; todoRows?: readonly LocalRecord[];
}) {
  const [value,setValue]=useState<JsonObject>({...row.payload});
  const [confirmClose,setConfirmClose]=useState(false);
  const [move,setMove] = useState<TodoMove>();
  const [working,setWorking]=useState(false);
  const draft = useRef(Promise.resolve());
  const active = useRef(false);
  const card = useRef<HTMLElement>(null);
  const warning = useRef<HTMLElement>(null);
  useEffect(() => {
    const background = document.getElementById('root');
    const focus = document.activeElement;
    if (background) background.inert = true;
    card.current?.focus();
    return () => {
      if (background) background.inert = false;
      if (focus instanceof HTMLElement) focus.focus();
    };
  }, []);
  useEffect(() => {
    if (confirmClose) warning.current?.focus();
    else if (warning.current === null && card.current && !card.current.contains(document.activeElement)) card.current.focus();
  }, [confirmClose]);
  const dirty = !!move || canonical(value) !== canonical(original);
  const disabled = busy || working;
  function change(next: JsonObject) {
    setValue(next);
    if (protect) draft.current = draft.current.then(() => protect(next));
  }
  async function finish(action: () => Promise<boolean>) {
    if (disabled || active.current) return;
    active.current = true;
    setWorking(true);
    try {
      await draft.current;
      if (!(await action())) setConfirmClose(false);
    } finally {
      active.current = false;
      setWorking(false);
    }
  }
  useEffect(() => {
    function close() {
      if (disabled || active.current) return;
      if (confirmClose) setConfirmClose(false);
      else if (dirty) setConfirmClose(true);
      else void finish(discard);
    }
    window.addEventListener('android:back', close);
    return () => window.removeEventListener('android:back', close);
  });
  const todo=row.domainId===TODO_DOMAIN;
  const properties=entry.definition.schema.properties as Record<string,any>;
  const keys=todo?['text','notes','dueDate','repeatFrequency','repeatTarget']:Object.keys(properties).filter(k=>!row.domainId.startsWith('preset.')||!['createdAt','completedAt'].includes(k));
  return createPortal(<div className="modal record-overlay">
    <section ref={card} tabIndex={-1} className="record-card" role="dialog" aria-modal="true" aria-label="编辑详情" aria-hidden={confirmClose || undefined} inert={confirmClose || undefined}>
      <div className="record-toolbar"><h2>编辑详情</h2>
        <button type="button" aria-label="关闭详情" disabled={disabled} onClick={() => dirty ? setConfirmClose(true) : void finish(discard)}>–</button>
        <button type="button" aria-label="保存修改" disabled={disabled} onClick={() => void finish(() => save(value, move))}>√</button>
      </div>
      {message && <p role="status" className="status">{message}</p>}
      {keys.map(key=>{
    const property=properties[key]??{},label=labels[key]??key;
    if(key==='repeatFrequency')return <label key={key}>{label}<select value={String(value[key]??'')} disabled={disabled} onChange={e=>change({...value,[key]:e.target.value})}><option value="">不重复</option><option value="day">每天</option><option value="week">每周</option><option value="month">每月</option></select></label>;
    if(key==='repeatTarget'&&!value.repeatFrequency)return null;
    if(property.enum)return <label key={key}>{label}<select value={String(value[key]??property.enum[0])} disabled={disabled} onChange={e=>change({...value,[key]:property.enum.find((item:unknown)=>String(item)===e.target.value)})}>{property.enum.map((option:string)=><option key={option} value={option}>{option==='task'?'待办':option==='idea'?'想法':option}</option>)}</select></label>;
    if(property.type==='boolean')return <label key={key}>{label}<input type="checkbox" checked={value[key]===true} disabled={disabled} onChange={e=>change({...value,[key]:e.target.checked})}/></label>;
    if(property.type==='number'||key==='repeatTarget')return <label key={key}>{label}<input type="number" value={Number(value[key]??1)} disabled={disabled} onChange={e=>change({...value,[key]:Number(e.target.value)})}/></label>;
    if(key==='dueDate')return <label key={key}>{label}<input type="date" value={String(value[key]??'')} disabled={disabled} onChange={e=>change({...value,[key]:e.target.value})}/></label>;
    return <label key={key}>{label}<textarea value={String(value[key]??'')} disabled={disabled} onChange={e=>change({...value,[key]:e.target.value})}/></label>;
      })}
      {todoRows && <>
        <label>前置关联<select value={String(value.prerequisiteId ?? '')} disabled={disabled} onChange={event => {
          const next = { ...value };
          if (event.target.value) next.prerequisiteId = event.target.value;
          else delete next.prerequisiteId;
          change(next);
        }}>
          <option value="">无</option>
          {typeof value.prerequisiteId === 'string' && !todoRows.some(candidate => candidate.recordId === value.prerequisiteId) &&
            <option value={value.prerequisiteId}>前置任务已删除</option>}
          {todoRows.filter(candidate => candidate.recordId !== row.recordId).map(candidate =>
            <option key={candidate.recordId} value={candidate.recordId}>{String(candidate.payload?.text ?? candidate.recordId)}</option>)}
        </select></label>
        <details>
          <summary>调整层级与顺序</summary>
          <label>目标任务<select disabled={disabled} value={move ? move.targetId ?? '' : 'unchanged'} onChange={event => {
            setMove(event.target.value === 'unchanged' ? undefined : { kind: 'move', targetId: event.target.value || null, position: move?.position ?? 'inside' });
          }}>
            <option value="unchanged">保持当前位置</option>
            <option value="">移到顶层末尾</option>
            {todoRows.filter(candidate => candidate.recordId !== row.recordId).map(candidate =>
              <option key={candidate.recordId} value={candidate.recordId}>{String(candidate.payload?.text ?? candidate.recordId)}</option>)}
          </select></label>
          {move?.targetId && <label>位置<select disabled={disabled} value={move.position} onChange={event => setMove({ ...move, position: event.target.value as TodoMove['position'] })}>
            <option value="inside">作为子待办</option><option value="before">放在目标之前</option><option value="after">放在目标之后</option>
          </select></label>}
        </details>
      </>}
      {!dirty && !disabled && tools}
    </section>
    {confirmClose && <div className="modal close-confirmation">
      <section ref={warning} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title">
        <h2 id="unsaved-title">当前修改未保存</h2>
        <button disabled={disabled} onClick={() => void finish(discard)}>直接退出</button>
        <button className="primary" disabled={disabled} onClick={() => void finish(() => save(value, move))}>保存并退出</button>
      </section>
    </div>}
  </div>, document.body);
}
