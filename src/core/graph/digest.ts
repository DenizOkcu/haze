/**
 * Compact structure digest for compaction: a bounded, deterministic excerpt
 * of the code graph (top hub symbols + community directory labels) handed to
 * LLM-written compaction summaries so they reference named structure instead
 * of re-describing it in prose. The graph itself persists across compaction —
 * this only keeps its vocabulary alive in the summarized prefix.
 */
import {workspaceRoot} from '../../utils/path.js';
import {buildGraphIndex} from './model.js';
import {graphStoreFor, readGraph} from './store.js';
import {communitySummaries, godNodes} from './analyze.js';

const DIGEST_MAX_CHARS = 2_000;

/** Build the digest, or undefined when no graph exists / it cannot be read. Best-effort by contract. */
export async function buildCodeGraphDigest(): Promise<string | undefined> {
  try {
    const graph = await readGraph(graphStoreFor(workspaceRoot()));
    if (!graph || graph.nodes.length === 0) return undefined;
    const index = buildGraphIndex(graph);
    const lines: string[] = [];
    const gods = godNodes(index, 6);
    if (gods.length > 0) {
      lines.push('Hub symbols:');
      for (const god of gods) lines.push(`- ${god.label} (${god.kind}, ${god.file})`);
    }
    const communities = communitySummaries(index, 5).filter(community => community.size >= 10);
    if (communities.length > 0) {
      lines.push('Subsystems (communities):');
      for (const community of communities) {
        const members = community.members.slice(0, 3).map(member => member.label).join(', ');
        lines.push(`- [${community.directories.join(', ') || 'misc'}] ${members}`);
      }
    }
    return lines.length > 0 ? lines.slice(0, 20).join('\n').slice(0, DIGEST_MAX_CHARS) : undefined;
  } catch {
    return undefined;
  }
}
