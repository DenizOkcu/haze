import {describe, expect, it} from 'vitest';
import React, {useEffect} from 'react';
import {render} from 'ink-testing-library';
import {useBusyIndicator} from '../../../src/cli/chat/busyIndicator.js';

// FE-10: two setBusy(true) calls inside one React batch must start the elapsed
// timer once (functional state update, not a stale closure read).
describe('useBusyIndicator', () => {
  it('starts the elapsed timer once when setBusy(true) is called twice in one batch', async () => {
    let hookApi: ReturnType<typeof useBusyIndicator> | undefined;
    let renders = 0;
    function Probe() {
      renders += 1;
      const api = useBusyIndicator();
      hookApi = api;
      useEffect(() => {
        api.setBusy(true);
        api.setBusy(true);
      }, [api]);
      return null;
    }
    const {unmount} = render(<Probe />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(hookApi?.busy).toBe(true);
    expect(hookApi?.elapsed).toBe('0s');
    unmount();
  });

  it('clears the timer when setBusy(false) is called', async () => {
    let hookApi: ReturnType<typeof useBusyIndicator> | undefined;
    function Probe() {
      const api = useBusyIndicator();
      hookApi = api;
      useEffect(() => {
        api.setBusy(true);
        api.setBusy(false);
      }, [api]);
      return null;
    }
    const {unmount} = render(<Probe />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(hookApi?.busy).toBe(false);
    expect(hookApi?.elapsed).toBe('');
    unmount();
  });
});
