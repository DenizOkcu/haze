/**
 * C# profile (tree-sitter-c_sharp). `using` directives are namespace imports
 * (no file resolution); `public` members are the export surface; base-list
 * entries are heritage; `this.X()` invocations bind to the enclosing type.
 */
import type {LanguageProfile, TreeNode, Definition, FileImport, CallSite, HeritageEntry} from '../profile.js';
import {walkNamed, lineOf, firstNamed, hasAccessModifier, lastPathSegment} from '../profile.js';

const TYPE_KINDS: Record<string, Definition['kind']> = {
  class_declaration: 'class',
  struct_declaration: 'type',
  interface_declaration: 'type',
  enum_declaration: 'type',
  record_declaration: 'type',
};

function collectDefinitions(root: TreeNode): Definition[] {
  const definitions: Definition[] = [];
  const walk = (node: TreeNode, owner: string | undefined) => {
    const kind = TYPE_KINDS[node.type];
    if (kind) {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind, line: lineOf(node)});
    } else if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: 'method', line: lineOf(node), ...(owner ? {owner} : {})});
    } else if (node.type === 'property_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) definitions.push({name, kind: 'field', line: lineOf(node), ...(owner ? {owner} : {})});
    } else if (node.type === 'field_declaration') {
      // variable_declarator nodes nest inside the variable_declaration child.
      const declaration = firstNamed(node, 'variable_declaration');
      for (const declarator of declaration?.namedChildren ?? []) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name')?.text;
        if (name) definitions.push({name, kind: 'field', line: lineOf(node), ...(owner ? {owner} : {})});
      }
    }
    const childOwner = kind ? node.childForFieldName('name')?.text ?? owner : owner;
    for (const child of node.namedChildren) walk(child, childOwner);
  };
  walk(root, undefined);
  return definitions;
}

function collectImports(root: TreeNode): FileImport[] {
  const imports: FileImport[] = [];
  walkNamed(root, node => {
    if (node.type !== 'using_directive') return;
    const qualified = firstNamed(node, 'qualified_name');
    const plain = firstNamed(node, 'identifier');
    const target = qualified ?? plain;
    if (!target) return;
    const entry: FileImport = {specifier: target.text, line: lineOf(node), kind: 'import', bindings: []};
    const alias = node.childForFieldName('name'); // `using Alias = Ns.Type;`
    const leaf = lastPathSegment(target.text);
    entry.bindings.push({importedName: leaf, localName: alias?.text ?? leaf});
    imports.push(entry);
  });
  return imports;
}

function collectCalls(root: TreeNode): CallSite[] {
  const calls: CallSite[] = [];
  const seen = new Set<string>();
  walkNamed(root, node => {
    if (node.type !== 'invocation_expression') return;
    const func = node.childForFieldName('function');
    if (!func) return;
    const record = (name: string, thisCall = false) => {
      const key = `${name}:${lineOf(node)}:${thisCall}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push({name, line: lineOf(node), ...(thisCall ? {thisCall: true} : {})});
      }
    };
    if (func.type === 'identifier' || func.type === 'generic_name') {
      record(func.type === 'generic_name' ? firstNamed(func, 'identifier')?.text ?? func.text : func.text);
    } else if (func.type === 'member_access_expression') {
      const object = func.childForFieldName('expression');
      const name = func.childForFieldName('name')?.text;
      if (!name) return;
      // `this.X()` carries the receiver as a `this` expression node.
      if (object?.type === 'this' || object?.type === 'this_expression') record(name, true);
      // Other member calls (obj.Method()) stay unresolved on purpose.
    }
  });
  return calls;
}

function collectHeritage(root: TreeNode): HeritageEntry[] {
  const heritage: HeritageEntry[] = [];
  walkNamed(root, node => {
    if (!(node.type in TYPE_KINDS)) return;
    const baseList = firstNamed(node, 'base_list');
    for (const base of baseList?.namedChildren ?? []) {
      if (base.type === 'identifier' || base.type === 'qualified_name' || base.type === 'generic_name') {
        heritage.push({name: base.type === 'generic_name' ? firstNamed(base, 'identifier')?.text ?? base.text : lastPathSegment(base.text), line: lineOf(node)});
      }
    }
  });
  return heritage;
}

function collectExports(root: TreeNode): string[] {
  const names = new Set<string>();
  walkNamed(root, node => {
    if (node.type in TYPE_KINDS || node.type === 'method_declaration' || node.type === 'field_declaration' || node.type === 'property_declaration') {
      if (!hasAccessModifier(node, 'public')) return;
      const declaration = firstNamed(node, 'variable_declaration');
      const name = node.childForFieldName('name')?.text
        ?? (declaration ? firstNamed(declaration, 'variable_declarator')?.childForFieldName('name')?.text : undefined);
      if (name) names.add(name);
    }
  });
  return [...names];
}

export const csharpProfile: LanguageProfile = {
  definitions: collectDefinitions,
  imports: collectImports,
  calls: collectCalls,
  heritage: collectHeritage,
  exports: collectExports,
};
