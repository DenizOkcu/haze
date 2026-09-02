import fs from 'node:fs/promises';
import path from 'node:path';
import type {HazeLspServer} from '../../config/lspSettings.js';
import {workspaceRelativePath, workspaceRoot} from '../../utils/path.js';
import {walkDir} from '../../utils/fs.js';
import {createIgnoreClassifier} from '../tools/gitIgnore.js';
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
  private readonly workspaceSnapshots = new Map<string, Map<string, string>>();
  private closed = false;

  /** Get (or lazily start + initialize) the reusable client for a server. */
  async getClient(server: HazeLspServer, filePath?: string): Promise<StdioLspClient> {
    const existing = this.clients.get(server.name);
    if (existing && !existing.terminated) {
      // Read-only navigation must not serve stale positions: when a document was
      // modified on disk since it was opened, close/reopen it so the server sees
      // the current text before answering position-based requests.
      if (filePath) {
        const absolutePath = path.resolve(workspaceRoot(), filePath);
        const snapshotKey = workspaceRelativePath(absolutePath);
        const snapshot = this.openSnapshots.get(snapshotKey);
        if (snapshot !== undefined && snapshot !== await fileFingerprint(absolutePath)) {
          const uri = toUri(absolutePath);
          existing.closeDocument(absolutePath);
          this.openedDocuments.get(server.name)?.delete(uri);
          await existing.openDocument(absolutePath);
          this.openedDocuments.get(server.name)?.add(uri);
          this.openSnapshots.set(snapshotKey, await fileFingerprint(absolutePath));
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

  /** Evict and close a failed client so a retry gets a clean process. */
  async restart(server: HazeLspServer): Promise<StdioLspClient> {
    const existing = this.clients.get(server.name);
    this.clients.delete(server.name);
    this.openedDocuments.delete(server.name);
    this.workspaceSnapshots.delete(server.name);
    await existing?.close().catch(() => undefined);
    return await this.getClient(server);
  }

  /**
   * Refresh a warm server's cross-file index after shell/editor/agent changes.
   * The scan is bounded and restricted to the server's configured source extensions.
   */
  async prepareCrossFileQuery(server: HazeLspServer): Promise<{changedFiles: number; indexingComplete: boolean}> {
    const client = await this.getClient(server);
    const extensions = new Set((server.extensions ?? []).map(extension => extension.toLowerCase()));
    const ignore = createIgnoreClassifier(workspaceRoot());
    const entries = await walkDir(workspaceRoot(), {
      recursive: true,
      maxEntries: 10_000,
      filter: entry => entry.isDirectory || (entry.isFile && extensions.has(path.extname(entry.path).toLowerCase())),
      ignoreBatch: async entriesToClassify => await ignore.classify(entriesToClassify.map(entry => ({path: entry.path, isDirectory: entry.isDirectory}))),
    });
    const current = new Map<string, string>();
    for (const entry of entries) if (entry.isFile) current.set(entry.path, await fileFingerprint(entry.absolutePath));
    const previous = this.workspaceSnapshots.get(server.name);
    this.workspaceSnapshots.set(server.name, current);
    let changedFiles = 0;
    if (previous) {
      const changes: Array<{uri: string; type: number}> = [];
      for (const [relative, fingerprint] of current) {
        const old = previous.get(relative);
        if (old !== fingerprint) changes.push({uri: toUri(path.resolve(workspaceRoot(), relative)), type: old === undefined ? 1 : 2});
      }
      for (const relative of previous.keys()) if (!current.has(relative)) changes.push({uri: toUri(path.resolve(workspaceRoot(), relative)), type: 3});
      changedFiles = changes.length;
      if (changes.length > 0) client.notify('workspace/didChangeWatchedFiles', {changes});
    }
    return {changedFiles, indexingComplete: await client.waitForIndexing()};
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
    this.workspaceSnapshots.clear();
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
  }
}
