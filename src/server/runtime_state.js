// In-memory runtime state (non-persistent)
export const runtimeState = {
  sessionRuns: new Map(),
  // key: `${userId}:${site}` -> { id, flagPath, pid, startedAt }
};
