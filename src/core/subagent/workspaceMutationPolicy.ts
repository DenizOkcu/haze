export type WorkspaceMutationOwner = symbol;

interface Waiter {
  owner: WorkspaceMutationOwner;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Turn-scoped, reentrant workspace-wide mutation lease. It coordinates work;
 * it is not a shell sandbox or authorization boundary. */
export class WorkspaceMutationPolicy {
  private owner?: WorkspaceMutationOwner;
  private depth = 0;
  private readonly waiters: Waiter[] = [];

  createOwner(): WorkspaceMutationOwner { return Symbol('workspace-mutation-owner'); }

  async acquire(owner: WorkspaceMutationOwner, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('Workspace mutation cancelled before admission.');
    if (!this.owner || this.owner === owner) {
      this.owner = owner;
      this.depth++;
      return this.releaseFor(owner);
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {owner, resolve, reject, ...(signal ? {signal} : {})};
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('Workspace mutation cancelled while queued.'));
        };
        signal.addEventListener('abort', waiter.onAbort, {once: true});
      }
      this.waiters.push(waiter);
    });
  }

  private releaseFor(owner: WorkspaceMutationOwner) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.owner !== owner) return;
      this.depth--;
      if (this.depth > 0) return;
      this.owner = undefined;
      const next = this.waiters.shift();
      if (!next) return;
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      this.owner = next.owner;
      this.depth = 1;
      next.resolve(this.releaseFor(next.owner));
    };
  }
}
