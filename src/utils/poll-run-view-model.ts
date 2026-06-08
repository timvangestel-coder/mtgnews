/**
 * Poll Run View Model — pure module for status mapping and display logic.
 *
 * Single source of truth for converting DB status strings to UI-friendly
 * enums and Tailwind CSS display classes used on the Run History pages.
 */

// ── Types ────────────────────────────────────────────────────────────────

/** Step-level progress for one channel in a poll run */
export interface PollRunStep {
  displayName: string | null;
  status: 'fetching' | 'processing' | 'done' | 'failed';
  total: number;     // signals discovered for this channel
  done: number;      // signals processed (relevant + irrelevant + failed)
}

/** View model representing the full state of a poll run */
export interface RunState {
  id: number;
  status: 'running' | 'complete' | 'failed' | 'aborted';
  steps: PollRunStep[];
}

// ── Pure mapping functions ───────────────────────────────────────────────

/** Map a DB run status string to the UI-friendly RunState status. */
export function mapStatus(dbStatus: string): RunState['status'] {
  switch (dbStatus) {
    case 'running': return 'running';
    case 'done': return 'complete';
    case 'done-forced': return 'aborted';
    case 'failed': return 'failed';
    default: return 'failed';
  }
}

/** Map a DB step status string to the UI-friendly PollRunStep status. */
export function mapStepStatus(dbStatus: string): PollRunStep['status'] {
  switch (dbStatus) {
    case 'fetching': return 'fetching';
    case 'running': return 'processing';
    case 'processing': return 'processing';
    case 'done': return 'done';
    case 'failed': return 'failed';
    default: return 'done';
  }
}

// ── Display helper ───────────────────────────────────────────────────────

/**
 * Maps a step + run status combination to a display label and Tailwind CSS
 * color classes. Implements the 5-branch logic matching current EJS behavior:
 *
 * 1. fetching → "fetching" (amber)
 * 2. failed   → "failed" (red)
 * 3. done + total=0 → "none" (gray)
 * 4. processing or done+total>0 but not all done → "X/Y processing" (amber)
 * 5. done + total>0 and all done → "Y/Y done" (green)
 */
export function stepDisplay(step: PollRunStep, _runStatus: string): { label: string; color: string } {
  // Branch 1: fetching
  if (step.status === 'fetching') {
    return { label: 'fetching', color: 'text-white bg-amber-500' };
  }

  // Branch 2: failed
  if (step.status === 'failed') {
    return { label: 'failed', color: 'text-white bg-red-600' };
  }

  // Branch 3: done with total=0 → none
  if (step.status === 'done' && step.total === 0) {
    return { label: 'none', color: 'text-gray-600 bg-gray-200' };
  }

  // Branch 5: done with total>0 and all done → Y/Y done
  if (step.status === 'done' && step.total > 0) {
    return { label: `${step.done}/${step.total} done`, color: 'text-white bg-green-600' };
  }

  // Branch 4: processing (or fallback) → X/Y processing
  return { label: `${step.done}/${step.total} processing`, color: 'text-white bg-amber-500' };
}