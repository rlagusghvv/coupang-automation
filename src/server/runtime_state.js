// In-memory runtime state (non-persistent)
export const runtimeState = {
  sessionRuns: new Map(),
  // key: `${userId}:${site}` -> { id, flagPath, pid, startedAt }

  purchaseDrafts: new Map(),
  // key: `${userId}` -> { createdAt, drafts: { domeme?: {filePath,rowCount}, domeggook?: {...} } }

  purchaseLogs: new Map(),
  // key: `${userId}` -> Array<{ at: string, type: "draft"|"upload", vendor?: string, ok?: boolean, error?: string, filePath?: string, payUrl?: string }>
};
