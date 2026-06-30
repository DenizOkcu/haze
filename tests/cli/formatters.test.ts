import {describe, it, expect} from 'vitest';
import {compact, toolCallSummary, toolResultSummary, busyToolLabel, formatSeconds, formatElapsedTime, formatElapsedTimeWhole, formatContextReport, type ContextReportData} from '../../src/cli/commands/formatters.js';

describe('compact', () => {
  it('returns short strings unchanged', () => {
    expect(compact('hello')).toBe('hello');
  });

  it('truncates long strings with ellipsis', () => {
    const long = 'a'.repeat(200);
    expect(compact(long)).toBe(`${'a'.repeat(180)}…`);
  });

  it('respects custom maxLength', () => {
    expect(compact('hello world', 5)).toBe('hello…');
  });

  it('extracts message from Error objects', () => {
    expect(compact(new Error('oops'))).toBe('oops');
  });

  it('stringifies objects', () => {
    expect(compact({key: 'value'})).toBe('{"key":"value"}');
  });

  it('returns String(value) for null/undefined', () => {
    expect(compact(undefined)).toBe('undefined');
    expect(compact(null)).toBe('null');
  });

  it('returns an empty string for empty objects (avoiding [object Object])', () => {
    expect(compact({})).toBe('');
  });

  it('replaces Error instances nested in objects', () => {
    const result = compact({err: new Error('nested')});
    expect(result).toContain('nested');
    expect(result).not.toContain('Error');
  });
});

describe('toolCallSummary', () => {
  it('formats bash commands', () => {
    expect(toolCallSummary('bash', {command: 'ls -la'})).toBe('bash $ ls -la');
  });

  it('includes timeout for bash commands', () => {
    expect(toolCallSummary('bash', {command: 'sleep', timeoutSeconds: 30})).toBe('bash $ sleep (timeout 30s)');
  });

  it('formats listFiles', () => {
    expect(toolCallSummary('listFiles', {path: 'src'})).toBe('listFiles src');
  });

  it('formats readFile', () => {
    expect(toolCallSummary('readFile', {path: 'foo.ts'})).toBe('readFile foo.ts');
  });

  it('formats writeFile', () => {
    expect(toolCallSummary('writeFile', {path: 'bar.ts'})).toBe('writeFile bar.ts');
  });

  it('renders path-using tools with just the tool name when input is missing/empty (e.g. tool-input-start)', () => {
    expect(toolCallSummary('writeFile', {})).toBe('writeFile');
    expect(toolCallSummary('writeFile', undefined)).toBe('writeFile');
    expect(toolCallSummary('readFile', {})).toBe('readFile');
    expect(toolCallSummary('editFile', {})).toBe('editFile');
    expect(toolCallSummary('replaceLines', {})).toBe('replaceLines');
  });

  it('does not leak [object Object] into tool summaries when input is malformed', () => {
    expect(toolCallSummary('writeFile', {path: undefined})).not.toContain('[object Object]');
    expect(toolCallSummary('writeFile', {})).not.toContain('[object Object]');
  });

  it('formats editFile with edit count', () => {
    expect(toolCallSummary('editFile', {path: 'a.ts', edits: [{}]})).toBe('editFile a.ts (1 edit)');
    expect(toolCallSummary('editFile', {path: 'a.ts', edits: [{}, {}]})).toBe('editFile a.ts (2 edits)');
  });

  it('formats replaceLines with line range', () => {
    expect(toolCallSummary('replaceLines', {path: 'x.ts', startLine: 3, endLine: 5})).toBe('replaceLines x.ts:3-5');
  });

  it('falls back to generic format', () => {
    expect(toolCallSummary('custom', {data: 1})).toMatch(/^custom /);
  });
});

describe('busyToolLabel', () => {
  it('labels bash as running a command', () => {
    expect(busyToolLabel('bash', {command: 'npm test'})).toBe('Running command');
  });

  it('labels readFile with its path', () => {
    expect(busyToolLabel('readFile', {path: 'src/index.ts'})).toBe('Reading src/index.ts');
  });

  it('labels readFile without input generically', () => {
    expect(busyToolLabel('readFile', {})).toBe('Reading file');
  });

  it('labels editFile and replaceLines as editing', () => {
    expect(busyToolLabel('editFile', {path: 'a.ts'})).toBe('Editing a.ts');
    expect(busyToolLabel('replaceLines', {path: 'b.ts'})).toBe('Editing b.ts');
  });

  it('labels grep and listFiles', () => {
    expect(busyToolLabel('grep', {pattern: 'x'})).toBe('Searching');
    expect(busyToolLabel('listFiles', {path: '.'})).toBe('Listing files');
  });

  it('labels fetch and subagent', () => {
    expect(busyToolLabel('fetch', {url: 'https://example.com'})).toBe('Fetching URL');
    expect(busyToolLabel('subagent', {task: 'x'})).toBe('Running subagent');
  });

  it('falls back to Running <name> for unknown tools', () => {
    expect(busyToolLabel('customTool', {data: 1})).toBe('Running customTool');
  });

  it('labels LSP- and MCP-prefixed tools generically', () => {
    expect(busyToolLabel('lspSymbols', {path: 'a.ts'})).toBe('Querying LSP');
    expect(busyToolLabel('mcp_search', {})).toBe('Running MCP tool');
  });
});

describe('toolResultSummary', () => {
  it('reports failure', () => {
    expect(toolResultSummary({success: false, error: 'bad'})).toBe('failed: bad');
  });

  it('reports exit code', () => {
    expect(toolResultSummary({success: true, output: {code: 1}})).toBe('exited with code 1');
  });

  it('reports completed for ok:true', () => {
    expect(toolResultSummary({success: true, output: {ok: true}})).toBe('completed');
  });

  it('reports failed for ok:false output with the concise error message', () => {
    expect(toolResultSummary({success: true, output: {ok: false, error: 'oldText was not found', suggestedNextStep: 'Read again'}})).toBe('failed: oldText was not found');
  });

  it('reports completed for success with no output', () => {
    expect(toolResultSummary({success: true})).toBe('completed');
  });
});

describe('formatSeconds', () => {
  it('formats milliseconds to seconds with one decimal', () => {
    expect(formatSeconds(1500)).toBe('1.5s');
  });

  it('formats zero', () => {
    expect(formatSeconds(0)).toBe('0.0s');
  });

  it('formats whole seconds', () => {
    expect(formatSeconds(3000)).toBe('3.0s');
  });
});

describe('formatElapsedTime', () => {
  it('formats response timers with one decimal second', () => {
    expect(formatElapsedTime(1500)).toBe('1.5s');
    expect(formatElapsedTime(3000)).toBe('3.0s');
  });

  it('keeps one decimal second for minute and hour durations', () => {
    expect(formatElapsedTime(62_300)).toBe('1m 2.3s');
    expect(formatElapsedTime(3_723_400)).toBe('1h 2m 3.4s');
  });
});

describe('formatElapsedTimeWhole', () => {
  it('formats running timers without decimal seconds', () => {
    expect(formatElapsedTimeWhole(1500)).toBe('1s');
    expect(formatElapsedTimeWhole(3000)).toBe('3s');
  });

  it('keeps whole seconds for minute and hour durations', () => {
    expect(formatElapsedTimeWhole(62_300)).toBe('1m 2s');
    expect(formatElapsedTimeWhole(3_723_400)).toBe('1h 2m 3s');
  });
});

describe('formatContextReport', () => {
  function base(overrides?: Partial<ContextReportData>): ContextReportData {
    return {
      modelLabel: 'openrouter:gpt-4',
      systemTokens: 1000,
      projectContext: [{path: 'AGENTS.md', tokens: 600}],
      tools: [
        {name: 'bash', tokens: 400, category: 'builtin'},
        {name: 'readFile', tokens: 200, category: 'builtin'},
        {name: 'context7_search', tokens: 500, category: 'mcp'},
        {name: 'subagent', tokens: 150, category: 'subagent'},
      ],
      messagesByRole: {user: 300, assistant: 1200, tool: 2000},
      toolResults: {bash: 1500, grep: 500},
      toolInputs: {bash: 300},
      syntheticControl: 0,
      logicalInputEstimate: 4350,
      messageCount: 7,
      mcpErrors: [],
      ...overrides,
    };
  }

  it('reports model label and estimated input header', () => {
    const out = formatContextReport(base());
    expect(out).toContain('Context overview — model: openrouter:gpt-4');
    expect(out).toContain('Estimated input: ~4,350 tokens');
  });

  it('splits system prompt into project context and base instructions', () => {
    const out = formatContextReport(base());
    expect(out).toContain('System prompt');
    expect(out).toContain('1,000');
    expect(out).toContain('project context');
    expect(out).toContain('AGENTS.md');
    expect(out).toContain('base instructions');
    // 1000 system - 600 project = 400 base
    expect(out).toContain('400');
  });

  it('groups tools by category and totals them', () => {
    const out = formatContextReport(base());
    expect(out).toMatch(/Tools \(4\)/);
    // builtin: bash 400 + readFile 200 = 600
    expect(out).toMatch(/Built-in \(2\).*600/s);
    // mcp: 500
    expect(out).toMatch(/MCP \(1\).*500/s);
    // subagent: 150
    expect(out).toMatch(/Subagent \(1\).*150/s);
  });

  it('lists chat messages by role with count', () => {
    const out = formatContextReport(base());
    expect(out).toMatch(/Chat messages \(7\)/);
    expect(out).toContain('user');
    expect(out).toContain('assistant');
    expect(out).toContain('tool');
  });

  it('shows tool result/input breakdown as subsets', () => {
    const out = formatContextReport(base());
    expect(out).toContain('Tool content inside messages (already counted above');
    expect(out).toContain('tool results');
    expect(out).toContain('tool inputs');
    // bash results 1500 + grep 500
    expect(out).toContain('1,500');
    expect(out).toContain('500');
  });

  it('includes MCP errors when present', () => {
    const out = formatContextReport(base({mcpErrors: ['context7: connection refused']}));
    expect(out).toContain('MCP errors: context7: connection refused');
  });

  it('omits tool content section when no results or inputs', () => {
    const out = formatContextReport(base({toolResults: {}, toolInputs: {}}));
    expect(out).not.toContain('Tool content inside messages');
  });

  it('handles empty project context', () => {
    const out = formatContextReport(base({projectContext: []}));
    expect(out).toContain('(no project context files)');
  });
});

describe('formatContextReport bars', () => {
  function base(overrides?: Partial<ContextReportData>): ContextReportData {
    return {
      modelLabel: 'p:m',
      systemTokens: 4000,
      projectContext: [],
      tools: [{name: 'bash', tokens: 1000, category: 'builtin'}],
      messagesByRole: {user: 5000},
      toolResults: {},
      toolInputs: {},
      syntheticControl: 0,
      logicalInputEstimate: 10000,
      messageCount: 1,
      mcpErrors: [],
      ...overrides,
    };
  }

  it('renders a proportional bar and percentage per row', () => {
    const out = formatContextReport(base());
    // 4000/10000 = 40% → 8 full cells of 20
    expect(out).toMatch(/System prompt\s+█{8}░{12}\s+4,000\s+40%/);
    // bash tool 1000/10000 = 10% → 2 full cells
    expect(out).toMatch(/bash\s+██░{18}\s+1,000\s+10%/);
    // messages 5000/10000 = 50%
    expect(out).toMatch(/5,000\s+50%/);
  });

  it('uses sub-cell precision via partial block glyphs', () => {
    // 5500/10000 = 55% → 11 full cells
    const out = formatContextReport(base({systemTokens: 5500}));
    expect(out).toMatch(/System prompt\s+█{11}░{9}\s+5,500\s+55%/);
  });

  it('shows a full empty track and 0% for zero-token rows', () => {
    const out = formatContextReport(base({projectContext: []}));
    expect(out).toContain('(no project context files)');
    expect(out).toMatch(/\(no project context files\)\s+░{20}\s+0\s+0%/);
  });

  it('shows at least a sliver for any nonzero token value', () => {
    // 1/10000 ≈ 0.01% → would round to empty, but should show the 1/8 glyph
    const out = formatContextReport(base({tools: [{name: 'tiny', tokens: 1, category: 'builtin'}]}));
    expect(out).toMatch(/tiny\s+▏░{19}/);
  });

  it('scales the largest row to the full bar width', () => {
    const out = formatContextReport(base());
    // messages user 5000 is the single largest at 50% → 10 cells, not full 20
    expect(out).not.toMatch(/user\s+█{20}/);
    // but a value equal to the total fills the whole bar
    const out2 = formatContextReport({...base(), systemTokens: 10000, logicalInputEstimate: 10000});
    expect(out2).toMatch(/System prompt\s+█{20}/);
  });
});
