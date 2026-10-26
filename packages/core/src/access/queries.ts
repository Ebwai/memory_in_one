import type { AuthorityVersion, McpGrant, RecordScope } from "@workspace/contracts";
import { McpAccess } from "./grants.js";

export interface McpQueryStore {
  authorityList(workspaceId: string, domainId: string): Promise<AuthorityVersion[]>;
  authorityRead(scope: RecordScope): Promise<AuthorityVersion | null>;
}
export class McpQueries {
  constructor(private readonly workspaceId: string, private readonly access: McpAccess, private readonly store: McpQueryStore, private readonly available: (domainId: string) => Promise<unknown>) {}
  async read(grant: McpGrant, domainId: string, recordId?: string) {
    this.access.require(grant, domainId, "read");
    await this.available(domainId);
    if (recordId !== undefined) {
      const record = await this.store.authorityRead({ workspaceId: this.workspaceId, domainId, recordId });
      return record?.value ? { status: "found", source: "authority-confirmed", record } : { status: "not-found" };
    }
    return { status: "found", source: "authority-confirmed", records: (await this.store.authorityList(this.workspaceId, domainId)).filter(r => r.value !== null) };
  }
}
