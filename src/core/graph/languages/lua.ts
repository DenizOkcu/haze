/**
 * Lua profile (tree-sitter-lua). `require "mod.name"` is an import resolving
 * against the workspace root (dots → slashes, `.lua` / `/init.lua`); module
 * functions written as `function M.f()` become methods owned by `M`.
 */
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite} from '../profile.js';
import {walkNamed, lineOf, stringLiteralText} from '../profile.js';

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  walkNamed(root, node => {
    if (node.type !== 'function_declaration') return;
    const name = node.childForFieldName('name');
    if (!name) return;
    if (name.type === 'identifier') {
      definitions.push({name: name.text, kind: 'function', line: lineOf(node)});
    } else if (name.type === 'dot_index_expression') {
      const table = name.childForFieldName('table')?.text;
      const field = name.childForFieldName('field')?.text;
      if (table && field) definitions.push({name: field, kind: 'method', line: lineOf(node), owner: table});
    }
  });
  return definitions;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type !== 'function_call') return;
    const name = node.childForFieldName('name');
    if (name?.type !== 'identifier' || name.text !== 'require') return;
    const args = node.childForFieldName('arguments');
    const first = args?.namedChildren[0];
    if (first?.type !== 'string') return;
    imports.push({specifier: stringLiteralText(first), line: lineOf(node), kind: 'require', bindings: []});
  });
  return imports;
}

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(root, node => {
    if (node.type !== 'function_call') return;
    const name = node.childForFieldName('name');
    // dot_index calls (M.f()) stay unresolved on purpose; only bare calls bind by name.
    if (!name || name.type !== 'identifier' || name.text === 'require') return;
    const key = `${name.text}:${lineOf(node)}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push({name: name.text, line: lineOf(node)});
    }
  });
  return calls;
}

function collectExports(root: TreeNode): string[] {
  return collectDefinitions(root).filter(def => !def.owner && def.kind === 'function').map(def => def.name);
}

function resolveSpecifier(_fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  const target = specifier.replace(/\./g, '/');
  for (const candidate of [`${target}.lua`, `${target}/init.lua`]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

export const luaProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: () => [],
  exports: collectExports,
  resolveSpecifier,
};
