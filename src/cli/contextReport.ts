import fs from 'fs-extra';
import path from 'node:path';
import {buildSystemPrompt} from '../llm/systemPrompt.js';
import {hazeTools} from '../llm/hazeTools.js';
import {contextBreakdown} from '../core/agent/contextBudget.js';
import {compactToolHistory} from '../core/agent/requestAssembly.js';
import {compactModelMessages} from '../core/agent/compaction.js';
import {summarizeContextDiagnostics} from '../config/contextFiles.js';
import type {ContextFile} from '../config/contextFiles.js';
import type {ModelMessage} from 'ai';

const reportSession = {start: new Date(0), cwd: process.cwd()};

async function loadFiles(paths: string[]): Promise<ContextFile[]> {
  const candidates = paths.length > 0 ? paths : ['AGENTS.md', 'CLAUDE.md'];
  const files: ContextFile[] = [];
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (!await fs.pathExists(absolute) || !(await fs.stat(absolute)).isFile()) continue;
    files.push({path: path.relative(process.cwd(), absolute) || path.basename(absolute), content: await fs.readFile(absolute, 'utf8')});
  }
  return files;
}

const args = process.argv.slice(2);
const traceIndex = args.indexOf('--trace');
if (traceIndex >= 0) {
  const tracePath = args[traceIndex + 1];
  if (!tracePath) throw new Error('--trace requires a JSON fixture path');
  const raw = await fs.readJson(path.resolve(tracePath)) as {messages?: ModelMessage[]};
  const messages = raw.messages ?? [];
  const pruned = compactToolHistory(messages);
  const compacted = compactModelMessages(pruned.messages, {tokenBudget: 4_000});
  const system = buildSystemPrompt([], reportSession);
  process.stdout.write(`${JSON.stringify({
    trace: tracePath,
    before: contextBreakdown({system, messages, tools: hazeTools}),
    after: contextBreakdown({system, messages: compacted.messages, tools: hazeTools}),
    compactedToolResults: pruned.compactedResults,
    compactedToolCalls: pruned.compactedCalls,
    compactedMessages: compacted.compacted,
    olderMessagesRemoved: compacted.olderCount,
  }, null, 2)}\n`);
  process.exit(0);
}

const files = await loadFiles(args);
const system = buildSystemPrompt(files, reportSession);
const breakdown = contextBreakdown({system, contextFiles: files, messages: [], tools: hazeTools});
const summary = summarizeContextDiagnostics(files);
process.stdout.write(`${JSON.stringify({breakdown, summary}, null, 2)}\n`);
