import {describe, expect, it} from 'vitest';
import {clearRenderMetricsReader, readRenderMetrics, setRenderMetricsReader} from '../../../src/cli/chat/renderMetrics.js';

describe('renderMetrics', () => {
  it('reads through the installed reader and resets to undefined', () => {
    clearRenderMetricsReader();
    try {
      expect(readRenderMetrics()).toBeUndefined();
      const sample = {at: 1, renderTime: 2};
      setRenderMetricsReader(() => sample);
      expect(readRenderMetrics()).toBe(sample);
      clearRenderMetricsReader();
      expect(readRenderMetrics()).toBeUndefined();
    } finally {
      clearRenderMetricsReader();
    }
  });
});
