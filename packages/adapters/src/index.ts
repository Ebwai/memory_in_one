export { HttpSyncRemote } from "./connection/http-sync.js";
export { FileExtensionPrograms } from "./extension-loader/programs.js";
export { authorityFromLocal } from "./archive/local-promotion.js";
export { recoverArchive } from "./archive/recovery.js";
export type { RecoverySummary } from "./archive/recovery.js";
export { encodeArchive, decodeArchive, readArchive, deliverArchive } from "./archive/workspace-archive.js";
export type { WorkspaceArchive } from "./archive/workspace-archive.js";
export { SqliteLocalStore } from "./sqlite/local-store.js";
export { SqliteWorkspaceAuthority } from "./workspace/authority.js";
export { HttpWorkspaceLocation, workspaceServiceUrl } from "./workspace/http-location.js";

