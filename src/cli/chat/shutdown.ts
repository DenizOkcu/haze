export interface ShutdownOwners {
  stop: () => void;
  abort: () => void;
  settle: () => Promise<unknown> | undefined;
  seal: () => void;
  flush: () => Promise<unknown> | undefined;
  endLog: () => Promise<unknown> | undefined;
  cleanup: () => Promise<unknown>;
  exit: () => void;
  report: (message: string) => void;
}

async function bounded(action: () => unknown, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Shutdown deadline exceeded')), timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One owner for slash exit and interrupt; late rejection is consumed by the race. */
export function createChatShutdown(owners: ShutdownOwners, settlementMs = 12_000, cleanupMs = 5_000) {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    owners.stop();
    pending = (async () => {
      const attempt = async (label: string, action: () => unknown, timeout: number) => {
        try { await bounded(action, timeout); }
        catch { owners.report(`Shutdown warning: ${label} failed or exceeded its deadline.`); }
      };
      try {
        await attempt('abort', owners.abort, cleanupMs);
        await attempt('active turn settlement', owners.settle, settlementMs);
        owners.seal();
        await attempt('session persistence', owners.flush, cleanupMs);
        await attempt('log persistence', owners.endLog, cleanupMs);
        await attempt('resource cleanup', owners.cleanup, cleanupMs);
      } finally { owners.exit(); }
    })();
    return pending;
  };
}

export interface TerminalApp {
  waitUntilExit: () => Promise<unknown>;
  unmount: () => void;
  cleanup: () => void;
  /** Ink 8: settles once pending render output is flushed to stdout. */
  waitUntilRenderFlush?: () => Promise<void>;
}

/** Adoption and synchronous render failures share the same restoration boundary. */
export async function runTerminalSession(owners: {
  adopt: () => void;
  create: () => TerminalApp;
  shutdown: () => Promise<void> | undefined;
  restore: () => void;
}) {
  let app: TerminalApp | undefined;
  try {
    owners.adopt();
    app = owners.create();
    await app.waitUntilExit();
  } finally {
    try { await owners.shutdown(); }
    finally {
      // Flush the final frame before teardown so the last rendered state
      // (goodbye line, final status) actually reaches the TTY.
      try { await app?.waitUntilRenderFlush?.(); } catch { /* terminal already gone */ }
      try { app?.unmount(); }
      finally {
        try { app?.cleanup(); }
        finally { owners.restore(); }
      }
    }
  }
}
