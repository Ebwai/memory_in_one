export interface PlatformBridge {
  sql(name: string, operation: string, sql: string, argumentsJson: string): string;
  hash(text: string): string;
  debug(): boolean;
  syncDeviceId(): string;
  background(): void;
  rpc(id: string, action: string, source: string): void;
  ssh(action: string, config: string): string;
  credential(action: string, key: string, value: string): string;
  file(id: string, action: string, body: string): void;
  request(url: string, method: string, token: string, body: string): string;
}
declare global { interface Window { AndroidPlatform: PlatformBridge } }
export class DatabaseSync {
  private transaction = false;
  get isTransaction() { return this.transaction; }
  constructor(private name: string, _options?: unknown) { this.name = name.split('/').pop()!.replace(/\.sqlite$/, ''); }
  private call(operation: string, sql: string, args: unknown[] = []): any {
    const result = JSON.parse(window.AndroidPlatform.sql(this.name, operation, sql, JSON.stringify(args)));
    if (!result.ok) throw new Error(result.message ?? 'SQLite operation failed');
    return result.value;
  }
  exec(sql: string) { this.call('exec', sql); for (const statement of sql.split(';')) { if (/^\s*BEGIN/i.test(statement)) this.transaction = true; if (/^\s*(COMMIT|ROLLBACK)/i.test(statement)) this.transaction = false; } }
  prepare(sql: string) { if (sql === "SELECT name FROM sqlite_master WHERE type = 'table'") sql += " AND name != 'android_metadata'"; return { iterate: (...args: unknown[]) => this.call('all', sql, args)[Symbol.iterator](), all: (...args: unknown[]) => this.call('all', sql, args), get: (...args: unknown[]) => this.call('all', sql, args)[0], run: (...args: unknown[]) => this.call('run', sql, args) }; }
  close() { /* Handles belong to the Activity; logical clients can overlap. */ }
}
