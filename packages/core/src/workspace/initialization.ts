import type { WorkspaceCreateResult, WorkspaceCreationPort, WorkspaceCreationRequest } from "@workspace/contracts";

export class WorkspaceInitialization {
  constructor(private readonly location: WorkspaceCreationPort, private readonly newId: () => string, private readonly now: () => string) {}

  async create(request: WorkspaceCreationRequest): Promise<WorkspaceCreateResult> {
    if (!request || typeof request.name !== "string" || !request.name.trim() ||
      typeof request.creationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.creationId)) {
      return { status: "rejected", reason: "invalid-input", message: "请填写工作空间名称并保留有效的创建请求。" };
    }
    try {
      return await this.location.create({ creationId: request.creationId, name: request.name.trim(),
        workspaceId: this.newId(), authorityId: this.newId(), createdAt: this.now() });
    } catch {
      return { status: "unconfirmed", message: "尚不能确认创建结果，请沿原请求核对，不要改建另一份空间。" };
    }
  }
}

