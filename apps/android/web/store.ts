import { prepareTodo, prepareTodoTree, TODO_DOMAIN, type TodoCommand } from '@workspace/todo-list';
import type { LocalRecord } from '@workspace/contracts';

export interface Space { id: string; name: string; rows: LocalRecord[] }
export interface State { format: 1; spaces: Space[]; current: string | null }
export interface NativeStorage { load(): string; commit(revision: number, body: string): string }
export class MobileStore {
  state: State;
  private revision: number;
  constructor(private native: NativeStorage) {
    const result = JSON.parse(native.load());
    if (!result.ok || result.state?.format !== 1 || !Array.isArray(result.state.spaces)) throw new Error(result.message ?? '本机数据版本不受支持。');
    this.state = result.state; this.revision = result.revision;
  }
  save(state: State) {
    const result = JSON.parse(this.native.commit(this.revision, JSON.stringify(state)));
    if (!result.ok) throw new Error(result.message ?? '本机保存失败，输入保留。');
    this.state = state; this.revision = result.revision;
  }
  createSpace(name: string) {
    if (!name.trim() || name.trim().length > 100) throw new Error('请填写 1 至 100 个字符的空间名称。');
    const id = crypto.randomUUID();
    this.save({ ...this.state, current: id, spaces: [...this.state.spaces, { id, name: name.trim(), rows: [] }] });
  }
  select(id: string) {
    if (!this.state.spaces.some(s => s.id === id)) throw new Error('空间不存在。');
    this.save({ ...this.state, current: id });
  }
  get current() { return this.state.spaces.find(s => s.id === this.state.current); }
  private replaceRows(rows: LocalRecord[]) {
    const id = this.current?.id;
    if (!id) throw new Error('请先创建空间。');
    this.save({ ...this.state, spaces: this.state.spaces.map(s => s.id === id ? { ...s, rows } : s) });
  }
  add(text: string, parentId?: string) {
    const space = this.current;
    if (!space) throw new Error('请先创建空间。');
    const payload = prepareTodo(text, new Date().toISOString());
    if (parentId) {
      const parent = space.rows.find(r => r.recordId === parentId && !r.deleted);
      if (!parent) throw new Error('父任务不存在。');
      if (parent.payload?.completed) throw new Error('请先恢复父任务，再添加子任务。');
      payload.parentId = parentId;
    }
    this.replaceRows([...space.rows, { workspaceId: space.id, domainId: TODO_DOMAIN, recordId: crypto.randomUUID(), payload, deleted: false, localSequence: Math.max(0, ...space.rows.map(r => r.localSequence)) + 1 }]);
  }
  mutate(id: string, command: TodoCommand) {
    const space = this.current;
    if (!space) throw new Error('请先创建空间。');
    const changes = prepareTodoTree(space.rows, id, command, new Date().toISOString());
    let sequence = Math.max(0, ...space.rows.map(r => r.localSequence));
    this.replaceRows(space.rows.map(row => {
      const change = changes.find(c => c.recordId === row.recordId);
      return change ? { ...row, payload: change.value, deleted: change.value === null, localSequence: ++sequence } : row;
    }));
  }
}
