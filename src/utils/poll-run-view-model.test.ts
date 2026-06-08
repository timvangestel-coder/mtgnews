import { describe, expect, it } from 'vitest';
import { mapStatus, mapStepStatus, stepDisplay, type RunState, type PollRunStep } from './poll-run-view-model';

describe('mapStatus', () => {
  const cases: Array<{ db: string; expected: RunState['status'] }> = [
    { db: 'running', expected: 'running' },
    { db: 'done', expected: 'complete' },
    { db: 'done-forced', expected: 'aborted' },
    { db: 'failed', expected: 'failed' },
    { db: 'unknown', expected: 'failed' },
    { db: '', expected: 'failed' },
  ];

  for (const c of cases) {
    it(`maps "${c.db}" to "${c.expected}"`, () => {
      expect(mapStatus(c.db)).toBe(c.expected);
    });
  }
});

describe('mapStepStatus', () => {
  const cases: Array<{ db: string; expected: PollRunStep['status'] }> = [
    { db: 'fetching', expected: 'fetching' },
    { db: 'running', expected: 'processing' },
    { db: 'processing', expected: 'processing' },
    { db: 'done', expected: 'done' },
    { db: 'failed', expected: 'failed' },
    { db: 'unknown', expected: 'done' },
    { db: '', expected: 'done' },
  ];

  for (const c of cases) {
    it(`maps "${c.db}" to "${c.expected}"`, () => {
      expect(mapStepStatus(c.db)).toBe(c.expected);
    });
  }
});

describe('stepDisplay', () => {
  const makeStep = (status: PollRunStep['status'], total: number, done: number): PollRunStep => ({
    displayName: 'Test Channel',
    status,
    total,
    done,
  });

  it('returns "fetching" with amber colors when step is fetching', () => {
    const step = makeStep('fetching', 0, 0);
    expect(stepDisplay(step, 'running')).toEqual({
      label: 'fetching',
      color: 'text-white bg-amber-500',
    });
  });

  it('returns "failed" with red colors when step is failed', () => {
    const step = makeStep('failed', 5, 2);
    expect(stepDisplay(step, 'running')).toEqual({
      label: 'failed',
      color: 'text-white bg-red-600',
    });
  });

  it('returns "none" with gray colors when total=0 and step is done', () => {
    const step = makeStep('done', 0, 0);
    expect(stepDisplay(step, 'complete')).toEqual({
      label: 'none',
      color: 'text-gray-600 bg-gray-200',
    });
  });

  it('returns "X/Y processing" with amber colors when partially done', () => {
    const step = makeStep('processing', 5, 2);
    expect(stepDisplay(step, 'running')).toEqual({
      label: '2/5 processing',
      color: 'text-white bg-amber-500',
    });
  });

  it('returns "Y/Y done" with green colors when all done and total>0', () => {
    const step = makeStep('done', 5, 5);
    expect(stepDisplay(step, 'complete')).toEqual({
      label: '5/5 done',
      color: 'text-white bg-green-600',
    });
  });

  it('returns "X/Y processing" with amber colors for aborted run with partial progress', () => {
    const step = makeStep('processing', 10, 3);
    expect(stepDisplay(step, 'aborted')).toEqual({
      label: '3/10 processing',
      color: 'text-white bg-amber-500',
    });
  });

  it('returns "Y/Y done" with green colors for failed run step that completed', () => {
    const step = makeStep('done', 3, 3);
    expect(stepDisplay(step, 'failed')).toEqual({
      label: '3/3 done',
      color: 'text-white bg-green-600',
    });
  });

  it('returns "fetching" with amber colors regardless of run status when step is fetching', () => {
    const step = makeStep('fetching', 0, 0);
    expect(stepDisplay(step, 'aborted')).toEqual({
      label: 'fetching',
      color: 'text-white bg-amber-500',
    });
  });

  it('returns "failed" with red colors regardless of run status when step is failed', () => {
    const step = makeStep('failed', 0, 0);
    expect(stepDisplay(step, 'complete')).toEqual({
      label: 'failed',
      color: 'text-white bg-red-600',
    });
  });

  it('returns "none" with gray colors for done step with total=0 on running run', () => {
    const step = makeStep('done', 0, 0);
    expect(stepDisplay(step, 'running')).toEqual({
      label: 'none',
      color: 'text-gray-600 bg-gray-200',
    });
  });

  it('returns "1/1 done" with green colors for single signal completed', () => {
    const step = makeStep('done', 1, 1);
    expect(stepDisplay(step, 'running')).toEqual({
      label: '1/1 done',
      color: 'text-white bg-green-600',
    });
  });

  it('returns "0/5 processing" with amber colors when nothing processed yet', () => {
    const step = makeStep('processing', 5, 0);
    expect(stepDisplay(step, 'running')).toEqual({
      label: '0/5 processing',
      color: 'text-white bg-amber-500',
    });
  });

  // Full matrix: each step status x each run status for key combinations
  describe('aborted run display', () => {
    it('shows fetching for fetching step', () => {
      expect(stepDisplay(makeStep('fetching', 0, 0), 'aborted')).toEqual({
        label: 'fetching',
        color: 'text-white bg-amber-500',
      });
    });

    it('shows failed for failed step', () => {
      expect(stepDisplay(makeStep('failed', 3, 1), 'aborted')).toEqual({
        label: 'failed',
        color: 'text-white bg-red-600',
      });
    });

    it('shows none for done step with total=0', () => {
      expect(stepDisplay(makeStep('done', 0, 0), 'aborted')).toEqual({
        label: 'none',
        color: 'text-gray-600 bg-gray-200',
      });
    });

    it('shows X/Y processing for processing step', () => {
      expect(stepDisplay(makeStep('processing', 8, 4), 'aborted')).toEqual({
        label: '4/8 processing',
        color: 'text-white bg-amber-500',
      });
    });

    it('shows Y/Y done for done step with total>0', () => {
      expect(stepDisplay(makeStep('done', 6, 6), 'aborted')).toEqual({
        label: '6/6 done',
        color: 'text-white bg-green-600',
      });
    });
  });

  describe('failed run display', () => {
    it('shows fetching for fetching step', () => {
      expect(stepDisplay(makeStep('fetching', 0, 0), 'failed')).toEqual({
        label: 'fetching',
        color: 'text-white bg-amber-500',
      });
    });

    it('shows failed for failed step', () => {
      expect(stepDisplay(makeStep('failed', 2, 0), 'failed')).toEqual({
        label: 'failed',
        color: 'text-white bg-red-600',
      });
    });

    it('shows none for done step with total=0', () => {
      expect(stepDisplay(makeStep('done', 0, 0), 'failed')).toEqual({
        label: 'none',
        color: 'text-gray-600 bg-gray-200',
      });
    });

    it('shows X/Y processing for processing step', () => {
      expect(stepDisplay(makeStep('processing', 4, 1), 'failed')).toEqual({
        label: '1/4 processing',
        color: 'text-white bg-amber-500',
      });
    });

    it('shows Y/Y done for done step with total>0', () => {
      expect(stepDisplay(makeStep('done', 2, 2), 'failed')).toEqual({
        label: '2/2 done',
        color: 'text-white bg-green-600',
      });
    });
  });
});

describe('RunState and PollRunStep types are exported', () => {
  it('exports RunState type usable as object shape', () => {
    const state: RunState = {
      id: 1,
      status: 'running',
      steps: [],
    };
    expect(state.id).toBe(1);
    expect(state.status).toBe('running');
    expect(state.steps).toEqual([]);
  });

  it('exports PollRunStep type usable as object shape', () => {
    const step: PollRunStep = {
      displayName: 'Channel',
      status: 'done',
      total: 10,
      done: 10,
    };
    expect(step.displayName).toBe('Channel');
    expect(step.total).toBe(10);
  });
});