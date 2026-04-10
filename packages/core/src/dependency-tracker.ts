/**
 * Dependency Tracker — in-memory DAG for cross-repo task sequencing.
 *
 * Tracks blocked-by relationships between sub-tickets. Used by the
 * orchestrator loop to determine when downstream tasks can be unblocked.
 */

export interface DependencyTracker {
  /** Register that `blocked` cannot start until `blocker` completes */
  addDependency(blocked: string, blocker: string): void;

  /** Remove a specific dependency */
  removeDependency(blocked: string, blocker: string): void;

  /** Mark an issue as complete, returns list of newly unblocked issue IDs */
  markComplete(issueId: string): string[];

  /** Check if an issue has unresolved blockers */
  isBlocked(issueId: string): boolean;

  /** Get all blocker issue IDs for a given issue */
  getBlockers(issueId: string): string[];

  /** Get all issues blocked by a given issue */
  getBlocked(issueId: string): string[];

  /** Get the full dependency graph (blocked -> Set of blockers) */
  getGraph(): ReadonlyMap<string, ReadonlySet<string>>;

  /** Clear all tracking data */
  clear(): void;
}

/**
 * Walk the blocked->blockers graph from `start` to see if `target` is reachable.
 * Used for cycle detection before inserting a new edge.
 */
function wouldCycle(
  blockedToBlockers: Map<string, Set<string>>,
  start: string,
  target: string,
): boolean {
  const visited = new Set<string>();
  const stack = [start];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const blockers = blockedToBlockers.get(current);
    if (blockers) {
      for (const b of blockers) {
        stack.push(b);
      }
    }
  }

  return false;
}

export function createDependencyTracker(): DependencyTracker {
  /** blocked issue -> set of issues that block it */
  const blockedToBlockers = new Map<string, Set<string>>();
  /** blocker issue -> set of issues it blocks (reverse index) */
  const blockerToBlocked = new Map<string, Set<string>>();

  return {
    addDependency(blocked: string, blocker: string): void {
      if (blocked === blocker) {
        throw new Error(`Cannot add self-dependency: ${blocked}`);
      }

      // Cycle check: walk from blocker's blockers to see if we reach blocked
      if (wouldCycle(blockedToBlockers, blocker, blocked)) {
        throw new Error(
          `Adding dependency ${blocked} -> ${blocker} would create a cycle`,
        );
      }

      // Forward index
      let blockers = blockedToBlockers.get(blocked);
      if (!blockers) {
        blockers = new Set<string>();
        blockedToBlockers.set(blocked, blockers);
      }
      blockers.add(blocker);

      // Reverse index
      let dependents = blockerToBlocked.get(blocker);
      if (!dependents) {
        dependents = new Set<string>();
        blockerToBlocked.set(blocker, dependents);
      }
      dependents.add(blocked);
    },

    removeDependency(blocked: string, blocker: string): void {
      const blockers = blockedToBlockers.get(blocked);
      if (blockers) {
        blockers.delete(blocker);
        if (blockers.size === 0) {
          blockedToBlockers.delete(blocked);
        }
      }

      const dependents = blockerToBlocked.get(blocker);
      if (dependents) {
        dependents.delete(blocked);
        if (dependents.size === 0) {
          blockerToBlocked.delete(blocker);
        }
      }
    },

    markComplete(issueId: string): string[] {
      const newlyUnblocked: string[] = [];

      // Find all issues that were blocked by this issue
      const dependents = blockerToBlocked.get(issueId);
      if (dependents) {
        for (const dependent of dependents) {
          const blockers = blockedToBlockers.get(dependent);
          if (blockers) {
            blockers.delete(issueId);
            if (blockers.size === 0) {
              blockedToBlockers.delete(dependent);
              newlyUnblocked.push(dependent);
            }
          }
        }
      }

      // Clean up completed issue from both maps
      blockerToBlocked.delete(issueId);
      blockedToBlockers.delete(issueId);

      return newlyUnblocked;
    },

    isBlocked(issueId: string): boolean {
      const blockers = blockedToBlockers.get(issueId);
      return blockers !== undefined && blockers.size > 0;
    },

    getBlockers(issueId: string): string[] {
      const blockers = blockedToBlockers.get(issueId);
      return blockers ? [...blockers] : [];
    },

    getBlocked(issueId: string): string[] {
      const dependents = blockerToBlocked.get(issueId);
      return dependents ? [...dependents] : [];
    },

    getGraph(): ReadonlyMap<string, ReadonlySet<string>> {
      return blockedToBlockers;
    },

    clear(): void {
      blockedToBlockers.clear();
      blockerToBlocked.clear();
    },
  };
}
