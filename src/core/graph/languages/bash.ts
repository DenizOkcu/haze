/**
 * Bash profile (tree-sitter-bash). `source`/`.` commands are imports
 * (resolved like require paths); function definitions are the export
 * surface; every command name is a call site — resolution downstream only
 * binds names that match a known symbol, so builtins stay harmless noise.
 */
import path from 'node:path';
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite} from '../profile.js';
import {walkNamed, lineOf, joinRelative} from '../profile.js';

const SOURCE_COMMANDS = new Set(['source', '.']);

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  walkNamed(root, node => {
    if (node.type !== 'function_definition') return;
    const name = node.childForFieldName('name')?.text;
    if (name) definitions.push({name, kind: 'function', line: lineOf(node)});
  });
  return definitions;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type !== 'command') return;
    const name = node.childForFieldName('name')?.text;
    if (!name || !SOURCE_COMMANDS.has(name)) return;
    const arg = node.childForFieldName('argument') ?? node.namedChildren.find(child => child.type === 'word' || child.type === 'string');
    if (!arg) return;
    const specifier = arg.type === 'string'
      ? arg.namedChildren.find(c => c.type === 'string_content')?.text ?? arg.text.replace(/^['"]|['"]$/g, '')
      : arg.text;
    imports.push({specifier, line: lineOf(node), kind: 'require', bindings: []});
  });
  return imports;
}

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(root, node => {
    if (node.type !== 'command') return;
    const name = node.childForFieldName('name')?.text;
    if (!name || SOURCE_COMMANDS.has(name)) return;
    const key = `${name}:${lineOf(node)}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push({name, line: lineOf(node)});
    }
  });
  return calls;
}

function collectExports(root: TreeNode): string[] {
  return collectDefinitions(root).map(def => def.name);
}

function resolveSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (specifier.startsWith('/')) return undefined; // absolute host path, not workspace
  const dir = path.posix.dirname(fromFile);
  for (const base of [dir, '']) {
    const target = joinRelative(base, specifier);
    for (const candidate of [target, `${target}.sh`, `${target}.bash`]) {
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return undefined;
}

export const bashProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: () => [],
  exports: collectExports,
  resolveSpecifier,
};
