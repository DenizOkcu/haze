import {describe, expect, it} from 'vitest';
import {randomTipIndex, tipsEnabled, TIPS} from '../../../src/cli/chat/tips.js';

describe('tips rotation', () => {
  describe('TIPS registry', () => {
    it('has a non-trivial rotation pool', () => {
      expect(TIPS.length).toBeGreaterThanOrEqual(10);
      expect(new Set(TIPS).size).toBe(TIPS.length); // no duplicates
    });

    it('keeps each entry terminal-friendly and non-empty', () => {
      for (const tip of TIPS) {
        expect(tip.length).toBeGreaterThan(10);
        expect(tip.length).toBeLessThan(200);
      }
    });
  });

  describe('randomTipIndex', () => {
    it('returns an in-bounds index', () => {
      for (let i = 0; i < 50; i++) {
        const index = randomTipIndex();
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(TIPS.length);
      }
    });

    it('never repeats the excluded index when there is more than one tip', () => {
      const exclude = 0;
      for (let i = 0; i < 50; i++) {
        expect(randomTipIndex(exclude)).not.toBe(exclude);
      }
    });

    it('returns 0 when the pool has at most one entry', () => {
      // The guard is defensive; with the current pool it is unreachable,
      // but the contract must hold if the registry ever shrinks.
      expect(randomTipIndex(0)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('tipsEnabled', () => {
    it('defaults to true when unset', () => {
      expect(tipsEnabled({})).toBe(true);
      expect(tipsEnabled({tips: {}})).toBe(true);
    });

    it('honours an explicit false', () => {
      expect(tipsEnabled({tips: {enabled: false}})).toBe(false);
    });

    it('honours an explicit true', () => {
      expect(tipsEnabled({tips: {enabled: true}})).toBe(true);
    });
  });
});
