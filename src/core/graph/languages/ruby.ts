/**
 * Ruby profile (tree-sitter-ruby). `require`/`require_relative` calls are
 * imports (relative ones resolve against the file dir); top-level defs,
 * classes, and modules are the export surface; `class X < Base` is heritage;
 * `self.m` calls bind to the enclosing class.
 */
import path from 'node:path';
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite, HeritageEntry} from '../profile.js';
import {walkNamed, lineOf, stringLiteralText, joinRelative} from '../profile.js';

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    if (node.type === 'class') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: 'class', line: lineOf(node)});
    } else if (node.type === 'module') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: 'type', line: lineOf(node)});
    } else if (node.type === 'method' || node.type === 'singleton_method') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: owner ? 'method' : 'function', line: lineOf(node), ...(owner ? {owner} : {})});
    }
    const childOwner = node.type === 'class' || node.type === 'module' ? node.childForFieldName('name')?.text ?? owner : owner;
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

function stringArg(call: TreeNode): string | undefined {
  const args = call.childForFieldName('arguments');
  const first = args?.namedChildren[0];
  return first?.type === 'string' ? stringLiteralText(first) : undefined;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type !== 'call') return;
    const method = node.childForFieldName('method')?.text;
    if (method !== 'require' && method !== 'require_relative') return;
    const specifier = stringArg(node);
    if (!specifier) return;
    imports.push({specifier, line: lineOf(node), kind: method === 'require_relative' ? 'require' : 'import', bindings: []});
  });
  return imports;
}

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(root, node => {
    if (node.type !== 'call') return;
    const method = node.childForFieldName('method');
    if (!method || method.type !== 'identifier') return;
    if (method.text === 'require' || method.text === 'require_relative') return; // import site, not a symbol call
    const receiver = node.childForFieldName('receiver');
    const key = `${method.text}:${lineOf(node)}:${receiver?.type === 'self'}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (receiver && receiver.type !== 'self') return; // obj.m stays unresolved on purpose
    calls.push({name: method.text, line: lineOf(node), ...(receiver?.type === 'self' ? {thisCall: true} : {})});
  });
  return calls;
}

function collectHeritage(root: TreeNode): HeritageEntry[] {
  const heritage: HeritageEntry[] = [];
  walkNamed(root, node => {
    if (node.type !== 'class') return;
    const superclass = node.childForFieldName('superclass')?.namedChildren[0];
    if (superclass) heritage.push({name: superclass.text, line: lineOf(node)});
  });
  return heritage;
}

function collectExports(root: TreeNode): string[] {
  // requiring a file loads its whole top-level namespace.
  return collectDefinitions(root).filter(def => !def.owner).map(def => def.name);
}

function resolveSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  const dir = path.posix.dirname(fromFile);
  for (const base of [dir, '']) {
    const target = joinRelative(base, specifier);
    for (const candidate of [target, `${target}.rb`, `${target}/init.rb`]) {
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return undefined;
}

export const rubyProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: collectHeritage,
  exports: collectExports,
  resolveSpecifier,
};
