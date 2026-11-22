/**
 * Rust profile (tree-sitter-rust). `pub` items are the crate-visible export
 * surface; `use` paths resolve when they start with `crate::` (against src/)
 * or `self::`/`super::` (relative to the file). `impl Trait for Type` records
 * a heritage edge on the trait.
 */
import path from 'node:path';
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite, HeritageEntry} from '../profile.js';
import {walkNamed, lineOf, firstNamed, hasAccessModifier, lastPathSegment} from '../profile.js';

const TYPE_ITEM_TYPES = new Set(['struct_item', 'enum_item', 'trait_item', 'union_item', 'type_item']);

function collectItems(root: TreeNode): {def: Definition; node: TreeNode}[] {
  const items: {def: Definition; node: TreeNode}[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    if (node.type === 'function_item') {
      const name = node.childForFieldName('name')?.text;
      if (name) items.push({def: {name, kind: owner ? 'method' : 'function', line: lineOf(node), ...(owner ? {owner} : {})}, node});
    } else if (TYPE_ITEM_TYPES.has(node.type)) {
      const name = node.childForFieldName('name')?.text;
      if (name) items.push({def: {name, kind: 'type', line: lineOf(node)}, node});
    } else if (node.type === 'field_declaration' && owner) {
      const name = node.childForFieldName('name')?.text;
      if (name) items.push({def: {name, kind: 'field', line: lineOf(node), owner}, node});
    }
    const childOwner = node.type === 'impl_item'
      ? (node.childForFieldName('type')?.text ?? owner)
      : (TYPE_ITEM_TYPES.has(node.type) ? node.childForFieldName('name')?.text ?? owner : owner);
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return items;
}

function collectDefinitions(root: TreeNode): Definition[] {
  return collectItems(root).map(item => item.def);
}

function useBindings(argument: TreeNode, bindings: {importedName: string; localName: string}[]): void {
  if (argument.type === 'use_as_clause') {
    const alias = argument.childForFieldName('alias');
    const p = argument.childForFieldName('path');
    if (p) bindings.push({importedName: lastPathSegment(p.text), localName: alias?.text ?? lastPathSegment(p.text)});
    return;
  }
  if (argument.type === 'scoped_use_list') {
    const list = firstNamed(argument, 'use_list');
    for (const item of list?.namedChildren ?? []) useBindings(item, bindings);
    return;
  }
  if (argument.type === 'use_wildcard') {
    const p = argument.childForFieldName('path');
    if (p) bindings.push({importedName: `${lastPathSegment(p.text)}::*`, localName: `${lastPathSegment(p.text)}::*`});
    return;
  }
  if (argument.type === 'identifier' || argument.type === 'scoped_identifier') {
    bindings.push({importedName: lastPathSegment(argument.text), localName: lastPathSegment(argument.text)});
  }
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type !== 'use_declaration') return;
    const argument = node.childForFieldName('argument');
    if (!argument) return;
    const entry: FileImport = {specifier: argument.text, line: lineOf(node), kind: 'import', bindings: []};
    useBindings(argument, entry.bindings);
    imports.push(entry);
  });
  return imports;
}

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(root, node => {
    if (node.type !== 'call_expression') return;
    const func = node.childForFieldName('function');
    if (!func) return;
    const record = (name: string, thisCall = false) => {
      const key = `${name}:${lineOf(node)}:${thisCall}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push({name, line: lineOf(node), ...(thisCall ? {thisCall: true} : {})});
      }
    };
    if (func.type === 'identifier' || func.type === 'generic_function') {
      record(func.type === 'generic_function' ? (func.childForFieldName('function')?.text ?? func.text) : func.text);
    } else if (func.type === 'field_expression') {
      const value = func.childForFieldName('value');
      const field = func.childForFieldName('field');
      if (value?.type === 'self' && field) record(field.text, true);
      // Other field calls (recv.method()) stay unresolved on purpose.
    }
  });
  return calls;
}

function collectHeritage(root: TreeNode): HeritageEntry[] {
  const heritage: HeritageEntry[] = [];
  walkNamed(root, node => {
    if (node.type !== 'impl_item') return;
    const trait = node.childForFieldName('trait');
    const name = trait?.type === 'type_identifier' || trait?.type === 'generic_type'
      ? (trait.type === 'generic_type' ? firstNamed(trait, 'type_identifier')?.text : trait.text)
      : undefined;
    if (name) heritage.push({name, line: lineOf(node)});
  });
  return heritage;
}

function collectExports(root: TreeNode): string[] {
  const names = new Set<string>();
  for (const item of collectItems(root)) {
    if (!item.def.owner && hasAccessModifier(item.node, 'pub')) names.add(item.def.name);
  }
  return [...names];
}

function resolveSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  let base: string | undefined;
  let rest: string;
  if (specifier.startsWith('crate::')) {
    base = 'src';
    rest = specifier.slice('crate::'.length);
  } else if (specifier.startsWith('self::')) {
    base = path.posix.dirname(fromFile);
    rest = specifier.slice('self::'.length);
  } else if (specifier.startsWith('super::')) {
    base = path.posix.dirname(fromFile);
    rest = specifier.replace(/^super::/, '../');
  } else {
    return undefined; // extern crate paths carry no workspace edge
  }
  // `use crate::config::Settings` names an item inside the `config` module
  // file, so try the full path first, then progressively shorter prefixes.
  const segments = rest.split('::').filter(Boolean);
  for (let keep = segments.length; keep >= 1; keep--) {
    const target = path.posix.normalize(path.posix.join(base, segments.slice(0, keep).join('/')));
    for (const candidate of [`${target}.rs`, `${target}/mod.rs`, `${target}/lib.rs`, `${target}/main.rs`]) {
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return undefined;
}

export const rustProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: collectHeritage,
  exports: collectExports,
  resolveSpecifier,
};
