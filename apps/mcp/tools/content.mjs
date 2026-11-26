import { filterTodoTree, groupTodoTree, localCalendarDate } from '@workspace/todo-list';
import { NOTES_DOMAIN, noteTitle } from '@workspace/contracts';

export function contentTools(info) {
  const tools = [];
  const string = { type: 'string' };
  for (const [prefix, domain] of [['todo', 'builtin.todo'], ['note', NOTES_DOMAIN]]) {
    if (!info.domains.includes(domain)) continue;
    for (const action of ['create', 'update', 'delete', 'query']) {
      if (!info.grant.actions.includes(action === 'query' ? 'read' : action)) continue;
      const properties = { workspaceId: { ...string, description: '工作空间 ID；多空间时必须明确选择。' } };
      const required = [];
      if (action === 'query') {
        Object.assign(properties, {
          recordId: string, keyword: string, fields: { type: 'array', items: string },
          status: { type: 'string', enum: ['all', 'unfinished', 'completed'] },
          timeField: { type: 'string', enum: ['createdAt', 'dueDate', 'completedAt'] },
          start: string, end: string,
        });
      } else {
        properties.operationId = { ...string, pattern: '^[a-zA-Z0-9_-]{1,100}$' };
        required.push('operationId');
        if (action !== 'create') {
          Object.assign(properties, { recordId: string, revision: { type: 'integer', minimum: 1 } });
          required.push('recordId', 'revision');
        }
        if (prefix === 'note' && action !== 'delete') {
          Object.assign(properties, { title: string, text: string });
          if (action === 'create') required.push('text');
        } else if (prefix === 'todo' && action !== 'delete') {
          Object.assign(properties, { text: string, notes: string, prerequisiteId: { type: ['string', 'null'] }, dueDate: { type: ['string', 'null'] }, completed: { type: 'boolean', description: '普通任务切换完成状态；周期任务 true 按现有规则完成一次，达到 target 后才为已完成。' }, frequency: { type: ['string', 'null'], enum: ['day', 'week', 'month', null] }, target: { type: 'integer', minimum: 1, maximum: 1000 }, timezone: string });
          if (action === 'create') required.push('text');
          else { properties.mode = { type: 'string', description: 'text 对应 text，notes 对应 notes，prerequisite 对应 prerequisiteId，date 对应 dueDate，repeat 对应 frequency/target/timezone，completion 对应 completed，all 支持组合。', enum: ['text', 'notes', 'prerequisite', 'date', 'repeat', 'completion', 'all'] }; required.push('mode'); }
        }
      }
      if (prefix === 'note' && action === 'query') {
        delete properties.status;
        properties.timeField = { type: 'string', enum: ['createdAt'] };
      }
      tools.push({ name: prefix + '_' + action, description: `${prefix === 'todo' ? '待办' : '随记'}${action}。查询始终返回 recordId 和 revision，fields 可指定返回属性；操作重试保留 operationId。${prefix === 'todo' ? '查询复用层级筛选，命中子项保留祖先。' : '随记正文必填，标题可选。'}`, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: action === 'query', destructiveHint: action === 'delete', idempotentHint: true } });
    }
  }
  return tools;
}

export async function executeContent(remote, name, input) {
  const [prefix, action] = name.split('_');
  const domainId = prefix === 'todo' ? 'builtin.todo' : NOTES_DOMAIN;
  if (action === 'query') {
    if ((input.start || input.end) && !input.timeField) throw new Error('设置时间范围时请选择 timeField。');
    if (input.start && !Number.isFinite(Date.parse(input.start)) || input.end && !Number.isFinite(Date.parse(input.end))) throw new Error('时间范围无效。');
    const result = await remote(prefix === 'todo' ? 'list' : input.recordId ? 'get' : 'list', { domainId, ...(input.recordId && prefix !== 'todo' ? { recordId: input.recordId } : {}) });
    if (result.status && !['ok', 'found', 'available'].includes(result.status) && !result.records && !result.record) return result;
    let records = result.records ?? (result.record ? [result.record] : []);
    if (prefix === 'todo') {
      const rows = records.map(record => ({ ...record, payload: record.effectiveValue ?? record.value, localSequence: record.revision, deleted: record.value === null }));
      const today = localCalendarDate(new Date());
      const groups = groupTodoTree(rows, today);
      const ids = new Set(filterTodoTree([...groups.unfinished, ...groups.completed], input.status ?? 'all', today, input.timeField ? { field: input.timeField, start: input.start ?? '', end: input.end ?? '' } : undefined, input.keyword ?? '').map(row => row.recordId));
      if (input.recordId) {
        const matched = ids.has(input.recordId);
        ids.clear();
        const byId = new Map([...groups.unfinished, ...groups.completed].map(row => [row.recordId, row]));
        let cursor = matched ? byId.get(input.recordId) : undefined;
        while (cursor && !ids.has(cursor.recordId)) {
          ids.add(cursor.recordId);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
      }
      records = records.filter(record => ids.has(record.recordId));
    } else {
      records = records.filter(record => !input.keyword || (noteTitle(record.value) + '\n' + record.value?.text).toLocaleLowerCase().includes(input.keyword.toLocaleLowerCase()));
      if (input.timeField && input.timeField !== 'createdAt') throw new Error('随记仅支持创建时间筛选。');
      if (input.timeField) records = records.filter(record => {
        const time = Date.parse(record.value?.createdAt);
        return time >= (input.start ? Date.parse(input.start) : -Infinity) && time <= (input.end ? Date.parse(input.end) + 59999 : Date.now());
      });
    }
    return { status: 'ok', records: records.map(record => {
      const value = record.effectiveValue ?? record.value;
      if (!input.fields) return { recordId: record.recordId, revision: record.revision, ...value };
      return { recordId: record.recordId, revision: record.revision, ...Object.fromEntries(input.fields.filter(field => field in (value ?? {})).map(field => [field, value[field]])) };
    }) };
  }
  return remote('write', { ...input, domainId, action });
}
