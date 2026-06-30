import type {BashOutputFilterInput, BashOutputFilterResult, StreamReduction} from './types.js';
import type {LineFilterDefinition} from './lineFilter.js';
import {applyLineFilter, findLineFilter} from './lineFilter.js';
import {renderValidationReduction} from './reducers/validation.js';
import {reduceGitOutput} from './reducers/git.js';
import {reduceGhOutput} from './reducers/gh.js';
import {reduceSearchOutput} from './reducers/search.js';
import {reduceGenericLogOutput, reduceJsonOutput, reduceUnifiedDiffOutput} from './reducers/content.js';
import {isInflating, reductionMetrics, retrievalHint, type ReductionContentKind} from '../toolOutput/reduction.js';
import {capRawOutput} from '../../llm/tools/outputCap.js';

export const builtInLineFilters: LineFilterDefinition[] = [
  {name: 'markdownlint', matchCommand: /(^|[;&|]\s*)markdownlint\b/, stripAnsi: true, truncateLinesAt: 200, maxLines: 80, onEmpty: 'markdownlint: ok'},
  {name: 'shellcheck', matchCommand: /(^|[;&|]\s*)shellcheck\b/, stripAnsi: true, stripLinesMatching: [/^In .* line \d+:/], truncateLinesAt: 200, maxLines: 100, onEmpty: 'shellcheck: ok'},
  {name: 'docker-list', matchCommand: /(^|[;&|]\s*)docker\s+(?:ps|images)\b/, stripAnsi: true, truncateLinesAt: 180, maxLines: 40, onEmpty: 'docker: no rows'},
  {name: 'kubectl-get', matchCommand: /(^|[;&|]\s*)(?:kubectl|oc)\s+get\b/, stripAnsi: true, truncateLinesAt: 180, maxLines: 60, onEmpty: 'kubectl get: no rows'},
  {name: 'terraform-plan', matchCommand: /(^|[;&|]\s*)terraform\s+plan\b/, stripAnsi: true, stripLinesMatching: [/^Refreshing Terraform state/, /^\s*$/, /^\s*# /], truncateLinesAt: 200, maxLines: 100, onEmpty: 'terraform plan: no significant changes'},
  {name: 'make', matchCommand: /(^|[;&|]\s*)make\b/, stripAnsi: true, stripLinesMatching: [/^make\[\d+\]: Entering directory /, /^make\[\d+\]: Leaving directory /], truncateLinesAt: 180, maxLines: 80, onEmpty: 'make: no significant output'},
  {name: 'system-list', matchCommand: /(^|[;&|]\s*)(?:du|df|ps)\b/, stripAnsi: true, truncateLinesAt: 180, maxLines: 50},
];

function makeReduction(raw: string, text: string, filtered: boolean, filterName: string | undefined, input: BashOutputFilterInput, warning?: string, contentKind: ReductionContentKind = 'generic'): StreamReduction {
  let finalText = text;
  let handle: string | undefined;
  let truncated = false;
  if (finalText.length > input.compactMaxChars) {
    const compacted = input.fallbackCompact(finalText, input.compactMaxChars);
    finalText = compacted.text;
    handle = compacted.handle;
    truncated = compacted.truncated;
  }
  const lossy = filtered && finalText !== raw;
  const rawHandle = lossy && input.storeRawOutput ? input.storeRawOutput(raw) : handle;
  if (filtered && contentKind !== 'validation' && raw.length > 2000 && isInflating(raw, finalText)) return passthroughReduction(raw, input);
  if (lossy && rawHandle && !finalText.includes(rawHandle)) finalText = `${finalText}\n\n[${retrievalHint(rawHandle)}]`;
  const metrics = reductionMetrics(raw, finalText);
  return {
    text: finalText,
    truncated,
    filtered,
    ...(filterName ? {filterName, reducerName: filterName} : {}),
    contentKind,
    lossy,
    parseTier: warning ? 'degraded' : filtered ? 'full' : 'passthrough',
    ...(warning ? {warning} : {}),
    ...(handle ?? rawHandle ? {handle: handle ?? rawHandle} : {}),
    ...(rawHandle ? {rawHandle} : {}),
    omittedChars: Math.max(0, raw.length - finalText.length),
    ...metrics,
  };
}

function passthroughReduction(raw: string, input: BashOutputFilterInput): StreamReduction {
  const compacted = input.fallbackCompact(raw, input.compactMaxChars);
  return {
    text: compacted.text,
    truncated: compacted.truncated,
    filtered: false,
    reducerName: 'generic-cap',
    contentKind: 'generic',
    lossy: compacted.truncated,
    parseTier: 'passthrough',
    ...(compacted.handle ? {handle: compacted.handle, rawHandle: compacted.handle} : {}),
    omittedChars: compacted.omittedChars ?? Math.max(0, raw.length - compacted.text.length),
    ...reductionMetrics(raw, compacted.text),
  };
}

export function filterBashOutput(input: BashOutputFilterInput): BashOutputFilterResult {
  try {
    let stdout: StreamReduction | undefined;
    let stderr: StreamReduction | undefined;
    let filterName: string | undefined;

    if (input.validationSummary && input.validationSummary.status !== 'passed') {
      filterName = `validation-${input.validationSummary.kind}`;
      const raw = `${input.stdout}${input.stderr ? `\n${input.stderr}` : ''}`;
      const rawHandle = input.storeRawOutput?.(raw);
      stdout = makeReduction(input.stdout, renderValidationReduction(input.validationSummary, rawHandle), true, filterName, input, undefined, 'validation');
      stderr = makeReduction(input.stderr, '', input.stderr.length > 0, filterName, input, undefined, 'validation');
    } else {
      // Cap what the synchronous reducers see so a huge or pathological command
      // output cannot pin the event loop in the reduction pipeline. The FULL
      // raw (input.stdout/stderr) is still what makeReduction/passthrough store
      // behind the readToolOutput handle and measure for savings, so capping
      // only the reducer input means nothing the model might later page into is
      // ever lost.
      const stdoutIn = capRawOutput(input.stdout);
      const stderrIn = capRawOutput(input.stderr);
      const git = reduceGitOutput(input.command, stdoutIn, stderrIn);
      const gh = git == null ? reduceGhOutput(input.command, stdoutIn, stderrIn) : undefined;
      if (git != null) {
        filterName = 'git';
        const kind: ReductionContentKind = /^git (?:diff|show):/.test(git) ? 'diff' : 'generic';
        stdout = makeReduction(input.stdout, input.stdout ? git : '', true, filterName, input, undefined, kind);
        stderr = makeReduction(input.stderr, input.stdout ? '' : git, true, filterName, input, undefined, kind);
      } else if (gh != null) {
        filterName = 'gh';
        const kind: ReductionContentKind = gh.trimStart().startsWith('{') ? 'json' : 'generic';
        stdout = makeReduction(input.stdout, input.stdout ? gh : '', true, filterName, input, undefined, kind);
        stderr = makeReduction(input.stderr, input.stdout ? '' : gh, true, filterName, input, undefined, kind);
      } else {
        const search = reduceSearchOutput(input.command, stdoutIn, stderrIn);
        if (search != null) {
          filterName = 'search';
          stdout = makeReduction(input.stdout, input.stdout ? search : '', true, filterName, input, undefined, 'search');
          stderr = makeReduction(input.stderr, input.stdout ? '' : search, true, filterName, input, undefined, 'search');
        } else {
          const diff = reduceUnifiedDiffOutput(stdoutIn, stderrIn);
          const json = diff == null ? reduceJsonOutput(stdoutIn, stderrIn) : undefined;
          const log = diff == null && json == null ? reduceGenericLogOutput(stdoutIn, stderrIn) : undefined;
          const content = diff ?? json ?? log;
          if (content != null) {
            filterName = diff != null ? 'diff' : json != null ? 'json' : 'log';
            const kind: ReductionContentKind = diff != null ? 'diff' : json != null ? 'json' : 'log';
            stdout = makeReduction(input.stdout, input.stdout ? content : '', true, filterName, input, undefined, kind);
            stderr = makeReduction(input.stderr, input.stdout ? '' : content, input.stderr.length > 0, filterName, input, undefined, kind);
          } else {
            const lineFilter = findLineFilter(builtInLineFilters, input.command);
            if (lineFilter) {
              filterName = lineFilter.name;
              const out = input.stdout ? applyLineFilter(lineFilter, input.command, stdoutIn) : undefined;
              const err = input.stderr ? applyLineFilter(lineFilter, input.command, stderrIn) : undefined;
              stdout = makeReduction(input.stdout, out?.text ?? input.stdout, out?.filtered ?? false, lineFilter.name, input, out?.warning, 'log');
              stderr = makeReduction(input.stderr, err?.text ?? input.stderr, err?.filtered ?? false, lineFilter.name, input, err?.warning, 'log');
            }
          }
        }
      }
    }

    stdout ??= passthroughReduction(input.stdout, input);
    stderr ??= passthroughReduction(input.stderr, input);
    return {stdout, stderr, summary: input.validationSummary};
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    const stdout = passthroughReduction(input.stdout, input);
    const stderr = passthroughReduction(input.stderr, input);
    stdout.warning = `bash output filter failed: ${warning}`;
    stdout.parseTier = 'degraded';
    return {stdout, stderr, summary: input.validationSummary};
  }
}
