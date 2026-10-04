export { discoverAgentWorkspaceScopes } from "./agent-scope-discovery.js";
export type {
  CheckpointHistoryEntry,
  CheckpointRecord,
  CheckpointServiceOptions,
  CheckpointSnapshotStore,
  CreateCheckpointInput,
} from "./checkpoint-service.js";
export { CheckpointService } from "./checkpoint-service.js";
export type {
  WorkspaceConfigChange,
  WorkspaceConfigFile,
  WorkspaceConfigWatcherOptions,
} from "./config-watcher.js";
export { WorkspaceConfigWatcher } from "./config-watcher.js";
export type { CwdTrackerOptions, WorkspaceCwdChange } from "./cwd-tracker.js";
export { CwdTracker } from "./cwd-tracker.js";
export type {
  DirectoryWatcher,
  WatchDirectory,
  WorkspaceFileChange,
  WorkspaceFileWatcherOptions,
} from "./file-watcher.js";
export { WorkspaceFileWatcher } from "./file-watcher.js";
export type { InstructionDocument, InstructionLoaderOptions } from "./instructions.js";
export { InstructionLoader } from "./instructions.js";
export type {
  WorkspaceSnapshotEntry,
  WorkspaceSnapshotManifest,
} from "./snapshot-types.js";
export {
  parseWorkspaceSnapshotManifest,
  WORKSPACE_SNAPSHOT_MANIFEST_VERSION,
  workspaceSnapshotEntrySchema,
  workspaceSnapshotManifestSchema,
} from "./snapshot-types.js";
export type {
  CaptureWorkspaceSnapshotInput,
  WorkspaceSnapshotLimits,
  WorkspaceSnapshotStoreOptions,
} from "./workspace-snapshot-store.js";
export {
  DEFAULT_WORKSPACE_SNAPSHOT_LIMITS,
  WorkspaceSnapshotLimitError,
  WorkspaceSnapshotStore,
} from "./workspace-snapshot-store.js";
export type {
  CreateWorktreeInput,
  RemoveWorktreeOptions,
  WorktreeChangeSet,
  WorktreeHandle,
  WorktreeHookContext,
  WorktreeManagerErrorCode,
  WorktreeManagerOptions,
} from "./worktree-manager.js";
export { WorktreeManager, WorktreeManagerError } from "./worktree-manager.js";
