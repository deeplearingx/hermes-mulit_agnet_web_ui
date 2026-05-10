/**
 * Unified initializer for all Hermes SQLite stores.
 * Call this once at bootstrap to create/migrate all tables.
 *
 * All table schemas, creation, and migration logic are now centralized
 * in schemas.ts to avoid duplication and ensure consistency.
 */

import { initAllHermesTables } from './schemas'
import { recoverStaleRuns, recoverStaleRoleRuns } from './agent-room-store'

export function initAllStores(): void {
  // Initialize all tables with centralized schema definitions and migrations
  initAllHermesTables()

  // Recover stale runs from previous server session
  const recoveredRuns = recoverStaleRuns()
  const recoveredRoleRuns = recoverStaleRoleRuns()
  if (recoveredRuns > 0 || recoveredRoleRuns > 0) {
    console.log(`[agent-room] Recovered ${recoveredRuns} stale runs and ${recoveredRoleRuns} stale role runs`)
  }
}
