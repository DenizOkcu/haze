/**
 * Go profile (tree-sitter-go). Go has no inheritance; "exports" follow the
 * language convention (capitalized top-level declarations). Imports are
 * package paths, so no workspace specifier resolution is attempted.
 */
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite} from '../profile.js';
import {walkNamed, lineOf, firstNamed, stringLiteralText} from '../profile.js';

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    if (node.type === 'function_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: 'function', line: lineOf(node)});
    } else if (node.type === 'method_declaration') {
      const name = node.childForFieldName('name')?.text;
      const receiver = node.childForFieldName('receiver');
      const param = firstNamed(receiver ?? node, 'parameter_declaration');
      const typeNode = param?.childForFieldName('type');
      const receiverType = typeNode?.type === 'pointer_type'
        ? firstNamed(typeNode, 'type_identifier')?.text ?? typeNode.text.replace(/^[*&]/, '')
        : typeNode?.text;
      if (name) definitions.push({name, kind: 'method', line: lineOf(node), ...(receiverType ? {owner: receiverType} : owner ? {owner} : {})});
    } else if (node.type === 'type_spec') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: 'type', line: lineOf(node)});
    } else if (node.type === 'field_declaration' && owner) {
      for (const nameNode of node.namedChildren) {
        if (nameNode.type !== 'field_identifier') continue;
        definitions.push({name: nameNode.text, kind: 'field', line: lineOf(node), owner});
      }
    }
    let childOwner = owner;
    if (node.type === 'type_spec') {
      childOwner = node.childForFieldName('name')?.text ?? owner;
    }
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type !== 'import_spec') return;
    const pathNode = node.childForFieldName('path');
    if (!pathNode) return;
    const entry: FileImport = {specifier: stringLiteralText(pathNode), line: lineOf(node), kind: 'import', bindings: []};
    const name = node.childForFieldName('name');
    if (name && name.text !== '.') entry.namespaceImport = name.text; // named import binds the alias
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
    // selector_expression calls (pkg.Fn(), recv.Method()) stay unresolved on purpose.
    if (!func || func.type !== 'identifier') return;
    const key = `${func.text}:${lineOf(node)}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push({name: func.text, line: lineOf(node)});
    }
  });
  return calls;
}

function collectExports(root: TreeNode): string[] {
  // Go convention: capitalized top-level declarations are the package API.
  return collectDefinitions(root)
    .filter(def => !def.owner && /^[A-Z]/.test(def.name))
    .map(def => def.name);
}

export const goProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: () => [],
  exports: collectExports,
};
