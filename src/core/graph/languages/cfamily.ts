/**
 * C and C++ profiles (tree-sitter-c / tree-sitter-cpp share one walker; C++
 * adds class specifiers, base clauses, namespaces, and `this->` calls).
 * Quoted `#include "..."` resolves relative to the including file, then the
 * workspace root; `<...>` system includes never resolve.
 */
import path from 'node:path';
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite, HeritageEntry} from '../profile.js';
import {walkNamed, lineOf, firstNamed, hasAccessModifier} from '../profile.js';

interface CFamilyOptions {
  cpp: boolean;
}

function collectDefinitions(root: TreeNode, opts: CFamilyOptions): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    if (node.type === 'function_definition') {
      const declarator = node.childForFieldName('declarator');
      const fn = declarator?.type === 'function_declarator' ? declarator : undefined;
      const nameNode = fn?.childForFieldName('declarator');
      if (nameNode && (nameNode.type === 'identifier' || nameNode.type === 'field_identifier')) {
        const isMethod = Boolean(owner) && nameNode.type === 'field_identifier';
        definitions.push({name: nameNode.text, kind: isMethod ? 'method' : 'function', line: lineOf(node), ...(owner ? {owner} : {})});
      }
    } else if (node.type === 'struct_specifier' || node.type === 'enum_specifier' || node.type === 'union_specifier') {
      // Record only the outermost occurrence: a top-level/namespace-level
      // definition (`struct Point {...};`), not one nested in a declaration,
      // typedef, or parameter — those are covered by their own node.
      const name = node.childForFieldName('name')?.text;
      if (name && (node.parent?.type === 'translation_unit' || node.parent?.type === 'declaration_list')) {
        definitions.push({name, kind: 'type', line: lineOf(node)});
      }
    } else if (node.type === 'type_definition') {
      const declarator = node.childForFieldName('declarator');
      if (declarator?.type === 'type_identifier') definitions.push({name: declarator.text, kind: 'type', line: lineOf(node)});
    } else if (opts.cpp && node.type === 'class_specifier') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: 'class', line: lineOf(node)});
    } else if (node.type === 'field_declaration' && owner) {
      // Struct/class members: the declarator is a field_identifier.
      const declarator = node.childForFieldName('declarator') ?? firstNamed(node, 'field_identifier');
      if (declarator && (declarator.type === 'field_identifier' || declarator.type === 'identifier')) {
        definitions.push({name: declarator.text, kind: 'field', line: lineOf(node), owner});
      }
    }
    let childOwner = owner;
    if (opts.cpp && node.type === 'class_specifier') childOwner = node.childForFieldName('name')?.text ?? owner;
    else if (node.type === 'struct_specifier' || node.type === 'union_specifier' || node.type === 'enum_specifier') childOwner = node.childForFieldName('name')?.text ?? owner;
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type !== 'preproc_include') return;
    const pathNode = node.childForFieldName('path');
    if (!pathNode) return;
    const specifier = pathNode.type === 'string_literal'
      ? pathNode.namedChildren.find(c => c.type === 'string_content')?.text ?? pathNode.text.replace(/^["']|["']$/g, '')
      : pathNode.text; // system_lib_string keeps its <...>
    imports.push({specifier, line: lineOf(node), kind: 'import', bindings: []});
  });
  return imports;
}

function collectCalls(root: TreeNode, opts: CFamilyOptions): CallSite[] {
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
    if (func.type === 'identifier') {
      record(func.text);
    } else if (opts.cpp && func.type === 'field_expression') {
      const object = func.childForFieldName('argument');
      const field = func.childForFieldName('field');
      if (object?.type === 'this' && field) record(field.text, true);
      // ptr->method() and obj.method() stay unresolved on purpose.
    }
  });
  return calls;
}

function collectHeritage(root: TreeNode, opts: CFamilyOptions): HeritageEntry[] {
  if (!opts.cpp) return [];
  const heritage: HeritageEntry[] = [];
  walkNamed(root, node => {
    if (node.type !== 'class_specifier') return;
    const baseClause = firstNamed(node, 'base_class_clause');
    for (const base of baseClause?.namedChildren ?? []) {
      if (base.type === 'type_identifier' || base.type === 'template_type') {
        heritage.push({name: base.type === 'template_type' ? firstNamed(base, 'type_identifier')?.text ?? base.text : base.text, line: lineOf(node)});
      }
    }
  });
  return heritage;
}

function collectExports(root: TreeNode, opts: CFamilyOptions): string[] {
  // C has no module system: non-static top-level functions/types are external.
  const names = new Set<string>();
  walkNamed(root, node => {
    if (hasAccessModifier(node, 'static')) return;
    if (node.type === 'function_definition') {
      const fn = node.childForFieldName('declarator');
      const nameNode = fn?.type === 'function_declarator' ? fn.childForFieldName('declarator') : undefined;
      if (nameNode?.type === 'identifier') names.add(nameNode.text);
    } else if (node.type === 'struct_specifier' || node.type === 'enum_specifier' || node.type === 'union_specifier') {
      const name = node.childForFieldName('name')?.text;
      if (name && (node.parent?.type === 'translation_unit' || node.parent?.type === 'declaration_list')) names.add(name);
    } else if (node.type === 'type_definition') {
      const declarator = node.childForFieldName('declarator');
      if (declarator?.type === 'type_identifier') names.add(declarator.text);
    } else if (opts.cpp && node.type === 'class_specifier') {
      const name = node.childForFieldName('name')?.text;
      if (name) names.add(name);
    }
  });
  return [...names];
}

function resolveSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (specifier.startsWith('<')) return undefined; // system include
  const dir = path.posix.dirname(fromFile);
  for (const candidate of [path.posix.normalize(path.posix.join(dir, specifier)), path.posix.normalize(specifier)]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

export const cProfile: LanguageProfile = {
  definitions: root => collectDefinitions(root, {cpp: false}),
  imports: collectImports,
  calls: root => collectCalls(root, {cpp: false}),
  heritage: () => [],
  exports: root => collectExports(root, {cpp: false}),
  resolveSpecifier,
};

export const cppProfile: LanguageProfile = {
  definitions: root => collectDefinitions(root, {cpp: true}),
  imports: collectImports,
  calls: root => collectCalls(root, {cpp: true}),
  heritage: root => collectHeritage(root, {cpp: true}),
  exports: root => collectExports(root, {cpp: true}),
  resolveSpecifier,
};
