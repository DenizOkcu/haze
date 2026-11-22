/**
 * PHP profile (tree-sitter-php). `use` declarations are namespace imports
 * (no file resolution); `require`/`include` string expressions resolve
 * relative to the file dir; top-level classes/functions are the export
 * surface; `extends`/`implements` are heritage; `$this->m()` binds to the
 * enclosing class.
 */
import path from 'node:path';
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite, HeritageEntry} from '../profile.js';
import {walkNamed, lineOf, firstNamed, stringLiteralText, joinRelative} from '../profile.js';

const TYPE_KINDS: Record<string, Definition['kind']> = {
  class_declaration: 'class',
  interface_declaration: 'type',
  trait_declaration: 'type',
  enum_declaration: 'type',
};

function nameText(node: TreeNode | null | undefined): string | undefined {
  // PHP names are `name` nodes; variables carry a `$` prefix.
  return node && node.type === 'name' ? node.text : undefined;
}

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    const kind = TYPE_KINDS[node.type];
    if (kind) {
      const name = nameText(node.childForFieldName('name'));
      if (name) definitions.push({name, kind, line: lineOf(node)});
    } else if (node.type === 'method_declaration') {
      const name = nameText(node.childForFieldName('name'));
      if (name) definitions.push({name, kind: 'method', line: lineOf(node), ...(owner ? {owner} : {})});
    } else if (node.type === 'function_definition') {
      const name = nameText(node.childForFieldName('name'));
      if (name) definitions.push({name, kind: 'function', line: lineOf(node)});
    } else if (node.type === 'property_declaration' && owner) {
      for (const element of node.namedChildren) {
        if (element.type !== 'property_element') continue;
        const varName = element.childForFieldName('name');
        const name = varName?.type === 'variable_name' ? varName.text.replace(/^\$/, '') : undefined;
        if (name) definitions.push({name, kind: 'field', line: lineOf(node), owner});
      }
    }
    const childOwner = kind ? nameText(node.childForFieldName('name')) ?? owner : owner;
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

const REQUIRE_TYPES = new Set(['require_expression', 'require_once_expression', 'include_expression', 'include_once_expression']);

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type === 'namespace_use_declaration') {
      for (const clause of node.namedChildren) {
        if (clause.type !== 'namespace_use_clause') continue;
        const qualified = firstNamed(clause, 'qualified_name');
        if (!qualified) continue;
        const entry: FileImport = {specifier: qualified.text, line: lineOf(node), kind: 'import', bindings: []};
        const alias = clause.childForFieldName('alias') ?? firstNamed(clause, 'name');
        const leaf = qualified.text.split('\\').filter(Boolean).pop() ?? qualified.text;
        entry.bindings.push({importedName: leaf, localName: alias?.text ?? leaf});
        imports.push(entry);
      }
    } else if (REQUIRE_TYPES.has(node.type)) {
      const arg = node.namedChildren[0];
      if (arg?.type === 'string') {
        imports.push({specifier: stringLiteralText(arg), line: lineOf(node), kind: 'require', bindings: []});
      }
    }
  });
  return imports;
}

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(root, node => {
    if (node.type === 'function_call_expression') {
      const func = node.childForFieldName('function');
      const name = func && (func.type === 'name' || func.type === 'qualified_name') ? func.text.split('\\').pop() : undefined;
      if (!name) return;
      const key = `${name}:${lineOf(node)}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push({name, line: lineOf(node)});
      }
    } else if (node.type === 'member_call_expression') {
      const object = node.childForFieldName('object');
      const name = nameText(node.childForFieldName('name'));
      if (!name || !object) return;
      // $this->m() binds to the enclosing class; other receivers stay unresolved.
      if (object.text !== '$this') return;
      const key = `${name}:${lineOf(node)}:true`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push({name, line: lineOf(node), thisCall: true});
      }
    }
  });
  return calls;
}

function collectHeritage(root: TreeNode): HeritageEntry[] {
  const heritage: HeritageEntry[] = [];
  walkNamed(root, node => {
    if (!(node.type in TYPE_KINDS)) return;
    const base = firstNamed(node, 'base_clause');
    const baseName = nameText(base?.namedChildren[0]);
    if (baseName) heritage.push({name: baseName, line: lineOf(node)});
    const ifaceClause = firstNamed(node, 'class_interface_clause');
    for (const iface of ifaceClause?.namedChildren ?? []) {
      const name = nameText(iface);
      if (name) heritage.push({name, line: lineOf(node)});
    }
  });
  return heritage;
}

function collectExports(root: TreeNode): string[] {
  const names = new Set<string>();
  for (const def of collectDefinitions(root)) {
    if (!def.owner && (def.kind === 'class' || def.kind === 'type' || def.kind === 'function')) names.add(def.name);
  }
  return [...names];
}

function resolveSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (specifier.includes('\\')) return undefined; // namespace use, not a file path
  const dir = path.posix.dirname(fromFile);
  for (const base of [dir, '']) {
    const target = joinRelative(base, specifier);
    for (const candidate of [target, `${target}.php`]) {
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return undefined;
}

export const phpProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: collectHeritage,
  exports: collectExports,
  resolveSpecifier,
};
