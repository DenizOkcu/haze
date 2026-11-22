/**
 * Kotlin profile (tree-sitter-kotlin). Top-level declarations are the file's
 * export surface (default visibility is public); `class A : B(), C` records
 * heritage for every delegation specifier; `this.f()` calls bind to the
 * enclosing class. Imports are package paths — no workspace resolution.
 */
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite, HeritageEntry} from '../profile.js';
import {walkNamed, lineOf, firstNamed, lastPathSegment} from '../profile.js';

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    if (node.type === 'class_declaration' || node.type === 'object_declaration') {
      const name = firstNamed(node, 'type_identifier')?.text;
      if (name) definitions.push({name, kind: 'class', line: lineOf(node)});
    } else if (node.type === 'function_declaration') {
      const name = firstNamed(node, 'simple_identifier')?.text;
      if (name) definitions.push({name, kind: owner ? 'method' : 'function', line: lineOf(node), ...(owner ? {owner} : {})});
    } else if (node.type === 'property_declaration') {
      const decl = firstNamed(node, 'variable_declaration');
      const name = firstNamed(decl ?? node, 'simple_identifier')?.text;
      if (name) definitions.push({name, kind: 'field', line: lineOf(node), ...(owner ? {owner} : {})});
    }
    const childOwner = node.type === 'class_declaration' || node.type === 'object_declaration'
      ? firstNamed(node, 'type_identifier')?.text ?? owner
      : owner;
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type !== 'import_header') return;
    const pathNode = firstNamed(node, 'identifier');
    if (!pathNode) return;
    const entry: FileImport = {specifier: pathNode.text, line: lineOf(node), kind: 'import', bindings: []};
    const alias = firstNamed(node, 'import_alias')?.childForFieldName('type_identifier')?.text
      ?? firstNamed(node, 'import_alias')?.namedChildren[0]?.text;
    const leaf = lastPathSegment(pathNode.text);
    entry.bindings.push({importedName: leaf, localName: alias ?? leaf});
    imports.push(entry);
  });
  return imports;
}

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(root, node => {
    if (node.type !== 'call_expression') return;
    const func = node.namedChildren[0];
    if (!func) return;
    const record = (name: string, thisCall = false) => {
      const key = `${name}:${lineOf(node)}:${thisCall}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push({name, line: lineOf(node), ...(thisCall ? {thisCall: true} : {})});
      }
    };
    if (func.type === 'simple_identifier' || func.type === 'navigation_expression' && firstNamed(func, 'this_expression')) {
      if (func.type === 'simple_identifier') record(func.text);
      else {
        const suffix = firstNamed(func, 'navigation_suffix');
        const name = suffix?.namedChildren[0]?.text;
        if (name) record(name, true);
      }
    }
    // obj.f() navigation calls stay unresolved on purpose.
  });
  return calls;
}

function collectHeritage(root: TreeNode): HeritageEntry[] {
  const heritage: HeritageEntry[] = [];
  walkNamed(root, node => {
    if (node.type !== 'class_declaration' && node.type !== 'object_declaration') return;
    for (const specifier of node.namedChildren) {
      if (specifier.type !== 'delegation_specifier') continue;
      const invocation = firstNamed(specifier, 'constructor_invocation');
      const userType = firstNamed(invocation ?? specifier, 'user_type');
      const name = firstNamed(userType ?? specifier, 'type_identifier')?.text;
      if (name) heritage.push({name, line: lineOf(node)});
    }
  });
  return heritage;
}

function collectExports(root: TreeNode): string[] {
  return collectDefinitions(root).filter(def => !def.owner).map(def => def.name);
}

export const kotlinProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: collectHeritage,
  exports: collectExports,
};
