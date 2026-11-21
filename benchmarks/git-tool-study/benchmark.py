#!/usr/bin/env python3
"""Prepare content-free Haze session metrics and sweep all Git-tool subsets."""
from __future__ import annotations
import argparse
import csv
import itertools
import json
import math
import re
import shlex
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMES = ('gitStatus', 'gitLog', 'gitDiff', 'gitBranch', 'gitFetch', 'gitPull', 'gitClone', 'gitStage', 'gitCommit', 'gitBranchManage', 'gitRebase', 'gitReset')
VERB_TO_TOOL = {'status':'gitStatus','log':'gitLog','diff':'gitDiff','branch':'gitBranch','fetch':'gitFetch','pull':'gitPull','clone':'gitClone','add':'gitStage','commit':'gitCommit','checkout':'gitBranchManage','switch':'gitBranchManage','rebase':'gitRebase','reset':'gitReset'}


def tokens(obj):
    # Match estimateValueTokens for a tool part: compact JSON, JS UTF-16 length.
    text = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    return math.ceil(len(text.encode('utf-16-le', 'surrogatepass')) / 8)


def git_verbs(command):
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars='();|&<>')
        lexer.whitespace_split = True
        lexer.commenters = '#'
        words = list(lexer)
    except ValueError:
        return None
    verbs = []
    for i, word in enumerate(words):
        if word != 'git':
            continue
        if i and not (words[i-1] in ('command', 'env', 'sudo', 'time', 'exec', '!') or all(c in '();|&<>' for c in words[i-1]) or words[i-1].endswith('$')):
            continue
        j = i + 1
        while j < len(words) and words[j].startswith('-'):
            j += 2 if words[j] in ('-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env') else 1
        if j < len(words) and re.fullmatch(r'[a-z][a-z0-9-]*', words[j]):
            verbs.append(words[j])
    return verbs


def status_projection(call, result):
    """Only reconstruct untruncated standalone short status; preserve no content."""
    command = call.get('input', {}).get('command', '')
    if not isinstance(command, str) or not re.fullmatch(r'\s*git\s+status\s+(?:--short|-s)\s*', command):
        return None
    output = result.get('output', {})
    out = output.get('value', {}) if isinstance(output, dict) else {}
    if not isinstance(out, dict) or not out.get('ok'):
        return None
    stdout = out.get('stdout', {})
    text = stdout.get('text', '') if isinstance(stdout, dict) else ''
    if not isinstance(text, str) or not text.startswith('git status:') or re.search(r'\.\.\. \d+ more', text):
        return None
    staged, unstaged, untracked = [], [], []
    for line in text.splitlines()[1:]:
        if not line or line.startswith('[Use readToolOutput'):
            continue
        row = line[2:] if line.startswith('  ') else line
        if len(row) < 3 or row[2] != ' ':
            return None
        x, y, filename = row[0], row[1], row[3:]
        if (x, y) == ('?', '?'):
            untracked.append(filename)
        else:
            if x not in (' ', '?'): staged.append(filename)
            if y not in (' ', '?'): unstaged.append(filename)
    match = re.search(r'branch ([^,]+),', text)
    result_value = {'ok':True, 'toolName':'gitStatus', 'branch':match.group(1) if match else 'example-branch', 'cwd':out.get('cwd', '/workspace'), 'staged':staged, 'unstaged':unstaged, 'untracked':untracked}
    call_part = {'type':'tool-call', 'toolCallId':call.get('toolCallId'), 'toolName':'gitStatus', 'input':{}}
    result_part = {'type':'tool-result', 'toolCallId':result.get('toolCallId'), 'toolName':'gitStatus', 'output':{'type':'json', 'value':result_value}}
    return {'historical': tokens(call)+tokens(result), 'projected': tokens(call_part)+tokens(result_part)}


def schema_costs():
    js = "import {hazeTools} from './src/llm/hazeTools.ts'; import {estimateToolSchemas} from './src/core/agent/contextBudget.ts'; console.log(JSON.stringify(estimateToolSchemas(hazeTools).filter(x=>x.name.startsWith('git'))))"
    output = subprocess.check_output(['node', '--import', 'tsx', '--input-type=module', '-e', js], cwd=ROOT, text=True)
    costs = {x['name']:x['tokens'] for x in json.loads(output)}
    if set(costs) != set(NAMES):
        raise ValueError(f'Git tool catalog changed; update NAMES: {sorted(costs)}')
    return costs


def prepare(session_dir, dest):
    events, calls, results = {}, {}, {}
    steps = files = errors = 0
    for file in sorted(session_dir.rglob('*.jsonl')):
        files += 1
        with file.open(encoding='utf-8', errors='replace') as stream:
            for line in stream:
                try: row = json.loads(line)
                except json.JSONDecodeError:
                    errors += 1
                    continue
                if row.get('type') == 'event':
                    if row.get('name') == 'step_start': steps += 1
                    if row.get('name') != 'tool_start': continue
                    try: event = json.loads(row['text'])
                    except (KeyError, TypeError, json.JSONDecodeError): continue
                    key = (event.get('id'), event.get('name'))
                    if None not in key: events[key] = True
                elif row.get('type') == 'conversation_snapshot':
                    for message in row.get('messages', []):
                        if not isinstance(message, dict) or not isinstance(message.get('content'), list): continue
                        for part in message['content']:
                            if not isinstance(part, dict): continue
                            key = (part.get('toolCallId'), part.get('toolName'))
                            if None in key: continue
                            if part.get('type') == 'tool-call': calls[key] = part
                            elif part.get('type') == 'tool-result': results[key] = part
    counts, available, token_totals, estimates = Counter(), Counter(), Counter(), Counter()
    missing_commands = missing_results = parse_errors = 0
    for key in events:
        if key[1] not in ('shell', 'bash'): continue
        call = calls.get(key)
        if call is None:
            missing_commands += 1
            continue
        command = call.get('input', {}).get('command', '')
        if not isinstance(command, str): continue
        verbs = git_verbs(command)
        if verbs is None:
            parse_errors += 1
            continue
        if not verbs: continue
        available['git_shell_calls'] += 1
        counts.update(verbs)
        result = results.get(key)
        if result is None:
            missing_results += 1
            continue
        token_totals['git_call_input'] += tokens(call)
        token_totals['git_call_output'] += tokens(result)
        projection = status_projection(call, result)
        if projection:
            estimates['gitStatus_calls'] += 1
            estimates['gitStatus_historical'] += projection['historical']
            estimates['gitStatus_projected'] += projection['projected']
    dataset = {'format':1, 'estimator':'ceil(UTF-16 JSON characters / 4) per tool part',
      'schema_tokens_per_request':schema_costs(), 'session_files':files, 'malformed_lines':errors,
      'recorded_step_starts':steps, 'tool_start_events_deduplicated':len(events),
      'shell_starts_missing_command':missing_commands, 'shell_command_parse_errors':parse_errors,
      'git_calls_missing_result':missing_results, 'git_usage_counts':dict(sorted(counts.items())),
      'historical_git_shell_calls':available['git_shell_calls'], 'historical_git_part_tokens':dict(token_totals),
      'projection':dict(estimates), 'projection_scope':'Standalone successful untruncated short status only; no prompts, paths, commands or content are retained.',
      'limitations':['Historical tool results and mixed shell calls are not exact Git-only costs.', 'Status projection reconstructs available paths and uses a branch placeholder where absent.', 'Step starts approximate requests and do not capture provider caching or schema transmission exactly.', 'No task success or model retry behavior is simulated.']}
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(dataset, indent=2)+'\n', encoding='utf-8')
    return dataset


def simulate(dataset, request_count, per_tool_savings=None):
    schema = dataset['schema_tokens_per_request']
    projection = dataset['projection']
    savings = {name:0 for name in NAMES}
    savings['gitStatus'] = projection.get('gitStatus_historical', 0)-projection.get('gitStatus_projected', 0)
    if per_tool_savings: savings.update(per_tool_savings)
    for bits in itertools.product((0,1), repeat=len(NAMES)):
        selected = [name for name, enabled in zip(NAMES, bits) if enabled]
        per_request = sum(schema[name] for name in selected)
        gross = sum(savings[name] for name in selected)
        yield {'tools':','.join(selected), 'tool_count':len(selected), 'schema_per_request':per_request,
               'requests':request_count, 'schema_total':per_request*request_count, 'projected_gross_saved':gross,
               'partial_delta_excluding_repeated_history':gross-per_request*request_count,
               'unmodeled_tools':','.join(name for name in selected if name != 'gitStatus' and (not per_tool_savings or name not in per_tool_savings))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--sessions', type=Path, default=Path.home()/'.haze/sessions')
    p.add_argument('--output', type=Path, required=True)
    r = sub.add_parser('run')
    r.add_argument('--dataset', type=Path, required=True)
    r.add_argument('--output', type=Path, required=True)
    r.add_argument('--requests', type=int, help='Number of requests receiving schemas; default: all recorded step starts')
    r.add_argument('--savings', type=Path, help='Optional JSON mapping of tool names to total projected tokens saved; experimental assumptions')
    args = parser.parse_args()
    if args.command == 'prepare':
        if not args.sessions.is_dir(): parser.error('sessions directory does not exist')
        data = prepare(args.sessions, args.output)
        print(f"Prepared {data['session_files']} session files; {data['historical_git_shell_calls']} identifiable Git shell calls; {data['projection'].get('gitStatus_calls', 0)} status projections.")
    else:
        data = json.loads(args.dataset.read_text(encoding='utf-8'))
        request_count = data['recorded_step_starts'] if args.requests is None else args.requests
        if request_count < 0: parser.error('--requests must be nonnegative')
        overrides = json.loads(args.savings.read_text()) if args.savings else None
        if overrides and (set(overrides)-set(NAMES) or any(not isinstance(v, (int,float)) for v in overrides.values())): parser.error('invalid savings map')
        rows = list(simulate(data, request_count, overrides))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('w', newline='', encoding='utf-8') as stream:
            writer = csv.DictWriter(stream, fieldnames=rows[0].keys(), lineterminator='\n')
            writer.writeheader(); writer.writerows(rows)
        print(f'Wrote {len(rows)} configurations to {args.output}; requests={request_count}.')
        print('Only gitStatus has a data-derived projection by default; other tools are unmodeled, not measured as zero benefit.')


if __name__ == '__main__': main()
