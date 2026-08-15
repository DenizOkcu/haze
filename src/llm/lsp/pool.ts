import fs from 'node:fs/promises';
import path from 'node:path';
import type {HazeLspServer} from '../../config/lspSettings.js';
import {workspaceRelativePath, workspaceRoot} from '../../utils/path.js';
import {toUri} from './protocol.js';
import {LspError, StdioLspClient} from './client.js';

/** Server selection and turn-scoped client reuse. */

export function pickLspServer(servers: HazeLspServer[], filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return servers.find(server => server.enabled !== false && (server.extensions ?? []).map(e => e.toLowerCase()).includes(ext));
}

/** Cheap file fingerprint (mtime + size) used to detect on-disk modification. */
async function fileFingerprint(absolutePath: string) {
  try {
    const stats = await fs.stat(absolutePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return '';
  }
}

/**
 * Turn-scoped pool of reused LSP clients (RH-009). Autonomous code navigation
 * issues many symbols/definition/references calls per turn; reusing one
 * initialized server and its opened documents avoids repeating expensive
 * startup and indexing on every call. Clients are keyed by server name; a
 * crashed/terminated client is evicted so the next call restarts it.
 */
export class LspPool {
  private readonly clients = new Map<string, StdioLspClient>();
  private readonly openedDocuments = new Map<string, Set<string>>();
  private readonly openSnapshots = new Map<string, string>();
  private closed = false;

  /** Get (or lazily start + initialize) the reusable client for a server. */
  async getClient(server: HazeLspServer, filePath?: string): Promise<StdioLspClient> {
    const existing = this.clients.get(server.name);
    if (existing && !existing.terminated) {
      // Read-only navigation must not serve stale positions: when a document was
      // modified on disk since it was opened, close/reopen it so the server sees
      // the current text before answering position-based requests.
      if (filePath) {
        const snapshot = this.openSnapshots.get(filePath);
        if (snapshot !== undefined && snapshot !== await fileFingerprint(filePath)) {
          const absolutePath = path.resolve(workspaceRoot(), filePath);
          const uri = toUri(absolutePath);
          existing.closeDocument(absolutePath);
          this.openedDocuments.get(server.name)?.delete(uri);
          await existing.openDocument(absolutePath);
          this.openedDocuments.get(server.name)?.add(uri);
          this.openSnapshots.set(filePath, await fileFingerprint(filePath));
        }
      }
      return existing;
    }
    const client = StdioLspClient.start(server);
    await client.initialize();
    if (this.closed) { await client.close(); throw new LspError('LSP pool closed during initialization.'); }
    this.clients.set(server.name, client);
    this.openedDocuments.set(server.name, new Set());
    return client;
  }

  /** Open a document once per client; subsequent calls for the same URI are no-ops. */
  async ensureOpen(server: HazeLspServer, client: StdioLspClient, absolutePath: string): Promise<void> {
    const uri = toUri(absolutePath);
    const opened = this.openedDocuments.get(server.name);
    if (opened && opened.has(uri)) return;
    await client.openDocument(absolutePath);
    opened?.add(uri);
    const relative = workspaceRelativePath(absolutePath);
    this.openSnapshots.set(relative, await fileFingerprint(absolutePath));
  }

  /** Bounded teardown of every pooled client. Safe to call once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.openedDocuments.clear();
    this.openSnapshots.clear();
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
  }
}
