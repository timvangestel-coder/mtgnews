import { describe, it, expect } from 'vitest';
import { softDeleteFilter } from './soft-delete-filter';

describe('softDeleteFilter', () => {
  it('returns filter with alias when provided', () => {
    expect(softDeleteFilter('c')).toBe('AND c.deleted_at IS NULL');
  });

  it('returns filter without alias when omitted', () => {
    expect(softDeleteFilter()).toBe('AND deleted_at IS NULL');
  });
});