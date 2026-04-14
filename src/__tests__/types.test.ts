import { describe, it, expect } from 'vitest';
import { detectZone, isFilamentChangeSubStatus } from '../types';

describe('detectZone', () => {
  it('returns cutter_area for cutter coordinates', () => {
    expect(detectZone(254, 3.5)).toBe('cutter_area');
  });

  it('returns purge_area for purge coordinates', () => {
    expect(detectZone(52.5, 264)).toBe('purge_area');
  });

  it('returns print_area for normal bed coordinates', () => {
    expect(detectZone(128, 128)).toBe('print_area');
    expect(detectZone(0, 0)).toBe('print_area');
    expect(detectZone(256, 256)).toBe('print_area');
  });

  it('returns outside for out-of-bounds coordinates', () => {
    expect(detectZone(-10, -10)).toBe('outside');
    expect(detectZone(300, 300)).toBe('outside');
  });
});

describe('isFilamentChangeSubStatus', () => {
  it('returns true for filament change sub-statuses', () => {
    expect(isFilamentChangeSubStatus(1045)).toBe(true);
    expect(isFilamentChangeSubStatus(1061)).toBe(true);
    expect(isFilamentChangeSubStatus(1066)).toBe(true);
    expect(isFilamentChangeSubStatus(1150)).toBe(true);
    expect(isFilamentChangeSubStatus(1166)).toBe(true);
  });

  it('returns false for non-filament-change sub-statuses', () => {
    expect(isFilamentChangeSubStatus(0)).toBe(false);
    expect(isFilamentChangeSubStatus(1000)).toBe(false);
    expect(isFilamentChangeSubStatus(2075)).toBe(false);
  });
});
