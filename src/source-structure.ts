import ts from "typescript";

export interface SymbolDeclaration {
  name: string;
  line: number;
  endLine: number;
  kind: "function" | "variable" | "class" | "type";
  runtimeLoads?: Array<{ line: number; parameter: number }>;
}
export interface SymbolImport {
  module: string;
  imported: string;
  local: string;
  line: number;
}
export interface SymbolExport {
  local: string;
  exported: string;
  line: number;
  module?: string;
}
export interface SymbolReference {
  name: string;
  line: number;
  owner: string;
  member?: string;
  registration?: true;
  callArguments?: Array<string | null>;
}
export interface StructuralLocation { line: number; kind: string }
export interface SourceStructure {
  declarations: SymbolDeclaration[];
  imports: SymbolImport[];
  exports: SymbolExport[];
  references: SymbolReference[];
  tests: StructuralLocation[];
  routes: Array<StructuralLocation & { handler?: string }>;
  gaps: StructuralLocation[];
}

export const structurePolicy = `typescript-${ts.version}-syntax-v4`;
export const structureLimit = 2048;
export const safeSymbol = (value: string): boolean => value.length <= 160 && /^(?:[A-Za-z_$][\w$]*|\*|default|<module>)$/.test(value);
export const safeModule = (value: string): boolean => value.length <= 512 && /^(?:node:)?[\w@./-]+$/.test(value);
export const safeRuntimeModule = (value: string): boolean => safeModule(value)
  && /^\.\.?\//.test(value) && /\.[cm]?[jt]sx?$/.test(value);

// Parse syntax only. No compiler configuration, imports, or application code is executed.
export function collectSourceStructure(file: string, text: string): SourceStructure {
  try {
    return collectSourceStructureSyntax(file, text);
  } catch {
    return { declarations: [], imports: [], exports: [], references: [], tests: [], routes: [], gaps: [
      { line: 1, kind: "parse-error" },
      { line: 1, kind: "parser-failure" },
    ] };
  }
}

function collectSourceStructureSyntax(file: string, text: string): SourceStructure {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result: SourceStructure = { declarations: [], imports: [], exports: [], references: [], tests: [], routes: [], gaps: [] };
  const owners = new Map<ts.Node, string>();
  const line = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const nameOf = (node: ts.Node | undefined): string | undefined => node && ts.isIdentifier(node) && safeSymbol(node.text) ? node.text : undefined;
  const moduleOf = (node: ts.Expression | undefined): string | undefined => node && ts.isStringLiteral(node) && safeModule(node.text) ? node.text : undefined;
  const exported = (node: ts.Node): boolean => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (node: ts.Node): boolean => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const module = moduleOf(statement.moduleSpecifier);
      if (!module) { result.gaps.push({ line: line(statement), kind: "unsupported-module" }); continue; }
      const clause = statement.importClause;
      if (!clause) result.imports.push({ module, imported: "*", local: "<module>", line: line(statement) });
      if (clause?.name) result.imports.push({ module, imported: "default", local: clause.name.text, line: line(statement) });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        result.imports.push({ module, imported: "*", local: clause.namedBindings.name.text, line: line(statement) });
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements) {
          if (safeSymbol(binding.name.text) && safeSymbol((binding.propertyName ?? binding.name).text)) {
            result.imports.push({ module, imported: (binding.propertyName ?? binding.name).text, local: binding.name.text, line: line(binding) });
          } else result.gaps.push({ line: line(binding), kind: "unsupported-binding" });
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      const module = moduleOf(statement.moduleSpecifier);
      if (statement.moduleSpecifier && !module) { result.gaps.push({ line: line(statement), kind: "unsupported-module" }); continue; }
      if (!statement.exportClause) result.exports.push({ local: "*", exported: "*", module, line: line(statement) });
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const binding of statement.exportClause.elements) {
          const local = (binding.propertyName ?? binding.name).text;
          if (safeSymbol(local) && safeSymbol(binding.name.text)) {
            result.exports.push({ local, exported: binding.name.text, ...(module ? { module } : {}), line: line(binding) });
          } else result.gaps.push({ line: line(binding), kind: "unsupported-binding" });
        }
      } else result.gaps.push({ line: line(statement), kind: "namespace-export" });
    } else if (ts.isExportAssignment(statement)) {
      const name = nameOf(statement.expression);
      if (name) result.exports.push({ local: name, exported: "default", line: line(statement) });
      else result.gaps.push({ line: line(statement), kind: "expression-export" });
    }
    const declarations = ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [statement];
    for (const node of declarations) {
      if (!ts.isVariableDeclaration(node) && !ts.isFunctionDeclaration(node) && !ts.isClassDeclaration(node)
        && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) continue;
      const name = nameOf(node.name) ?? (isDefault(statement) ? "default" : undefined);
      if (!name) { result.gaps.push({ line: line(node), kind: "unsupported-declaration" }); continue; }
      owners.set(node, name);
      result.declarations.push({ name, line: line(node), endLine: source.getLineAndCharacterOfPosition(node.end).line + 1,
        kind: ts.isVariableDeclaration(node) ? "variable" : ts.isFunctionDeclaration(node) ? "function" : ts.isClassDeclaration(node) ? "class" : "type" });
      if (exported(statement)) result.exports.push({ local: name, exported: isDefault(statement) ? "default" : name, line: line(node) });
    }
  }

  // Lexical scopes prevent an imported name from matching a parameter or local shadow.
  const scopes = new Map<ts.Node, Set<string>>();
  const scopeFor = new Map<ts.Node, ts.Node>();
  const parentScope = new Map<ts.Node, ts.Node>();
  const isScope = (node: ts.Node): boolean => ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node)
    || ts.isClassExpression(node) || ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForOfStatement(node)
    || ts.isForInStatement(node) || ts.isCaseBlock(node);
  const bindName = (name: ts.BindingName, scope: ts.Node): void => {
    if (ts.isIdentifier(name)) scopes.get(scope)?.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindName(element.name, scope);
  };
  const bind = (node: ts.Node, parent: ts.Node): void => {
    const scope = isScope(node) ? node : parent;
    if (scope !== parent) { scopes.set(scope, new Set()); parentScope.set(scope, parent); }
    scopeFor.set(node, scope);
    if (ts.isVariableDeclaration(node)) {
      let target = scope;
      if (ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)) {
        while (!ts.isSourceFile(target) && !ts.isFunctionLike(target)) target = parentScope.get(target) ?? source;
      }
      bindName(node.name, target);
    } else if (ts.isParameter(node) || ts.isBindingElement(node)) bindName(node.name, scope);
    else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) scopes.get(scope)?.add(node.name.text);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) scopes.get(parent)?.add(node.name.text);
    ts.forEachChild(node, (child) => bind(child, scope));
  };
  scopes.set(source, new Set());
  bind(source, source);
  const known = new Set([...result.declarations.map((declaration) => declaration.name), ...result.imports.map((binding) => binding.local)]);
  const visible = (node: ts.Node, name: string): boolean => {
    let scope = scopeFor.get(node) ?? source;
    while (scope !== source) {
      if (scopes.get(scope)?.has(name)) return false;
      scope = parentScope.get(scope) ?? source;
    }
    return true;
  };
  const ownerOf = (node: ts.Node): string => {
    for (let ancestor: ts.Node | undefined = node; ancestor; ancestor = ancestor.parent) {
      const owner = owners.get(ancestor);
      if (owner) return owner;
    }
    return "<module>";
  };
  const referencePosition = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return false;
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)
      || ts.isFunctionExpression(parent) || ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent)
      || ts.isTypeAliasDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) return false;
    return true;
  };
  const registrationHandlers = new Set<ts.Identifier>();
  const assignedNames = new Set<string>();
  const assigned = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) assignedNames.add(node.text);
    ts.forEachChild(node, assigned);
  };
  const mutations = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) assigned(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) assigned(node.operand);
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) assigned(node.initializer);
    ts.forEachChild(node, mutations);
  };
  mutations(source);
  // Only an unchanged plain parameter used directly by import() can carry a literal call argument.
  for (const [node, name] of owners) {
    const fn = ts.isFunctionDeclaration(node) ? node
      : ts.isVariableDeclaration(node) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? node.initializer : undefined;
    if (!fn?.body || assignedNames.has(name) || fn.parameters.length > 16) continue;
    let dynamicScope = false;
    const checkScope = (child: ts.Node): void => {
      if (ts.isWithStatement(child) || ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "eval") dynamicScope = true;
      ts.forEachChild(child, checkScope);
    };
    checkScope(fn.body);
    const parameterNames = fn.parameters.map(parameter => ts.isIdentifier(parameter.name) ? parameter.name.text : undefined);
    if (dynamicScope || new Set(parameterNames.filter(Boolean)).size !== parameterNames.filter(Boolean).length) continue;
    const loads: Array<{ line: number; parameter: number }> = [];
    fn.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) return;
      const parameterName = parameter.name.text;
      let unsupported = assignedNames.has(parameterName);
      const candidates: Array<{ line: number; parameter: number }> = [];
      const inspect = (child: ts.Node): void => {
        if (ts.isIdentifier(child) && child.text === parameterName) {
          const call = child.parent;
          let nested = false;
          for (let parent = child.parent; parent && parent !== fn; parent = parent.parent) {
            if (ts.isFunctionLike(parent)) nested = true;
          }
          if (!nested && ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword
            && call.arguments.length === 1 && call.arguments[0] === child) candidates.push({ line: line(call), parameter: index });
          else unsupported = true;
        }
        ts.forEachChild(child, inspect);
      };
      inspect(fn.body!);
      if (!unsupported) loads.push(...candidates);
    });
    const declaration = result.declarations.find(entry => entry.name === name && entry.line === line(node));
    if (declaration && loads.length && loads.length <= 16) declaration.runtimeLoads = loads;
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && known.has(node.text) && visible(node, node.text) && referencePosition(node)) {
      const parent = node.parent;
      const member = ts.isPropertyAccessExpression(parent) && parent.expression === node ? nameOf(parent.name) : undefined;
      const args = ts.isCallExpression(parent) && parent.expression === node && !assignedNames.has(node.text)
        && parent.arguments.length <= 16 && !parent.arguments.some(ts.isSpreadElement)
        ? parent.arguments.map(argument => {
          const module = moduleOf(argument);
          return module && safeRuntimeModule(module) ? module : null;
        }) : undefined;
      result.references.push({ name: node.text, line: line(node), owner: ownerOf(node), ...(member ? { member } : {}),
        ...(args?.some(argument => argument !== null) ? { callArguments: args } : {}),
        ...(registrationHandlers.has(node) ? { registration: true as const } : {}) });
    }
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
      if (ts.isIdentifier(callee) && /^(?:test|it|describe|expect|assert)$/.test(callee.text)) {
        result.tests.push({ line: line(node), kind: /^(?:expect|assert)$/.test(callee.text) ? "assertion" : "test-declaration" });
      }
      if (ts.isPropertyAccessExpression(node.expression) && /^(?:get|post|put|patch|delete|options|head|all|use)$/.test(node.expression.name.text)
        && node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0])) {
        const argument = node.arguments[node.arguments.length - 1];
        const handler = nameOf(argument);
        const linked = ts.isIdentifier(argument) && handler !== undefined && known.has(handler) && visible(argument, handler);
        if (linked) registrationHandlers.add(argument);
        result.routes.push({ line: line(argument), kind: `registration-candidate:${node.expression.name.text}`,
          ...(linked ? { handler } : {}) });
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        result.gaps.push({ line: line(node), kind: "runtime-module-loading" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  for (const diagnostic of diagnostics) result.gaps.push({ line: source.getLineAndCharacterOfPosition(diagnostic.start).line + 1, kind: "parse-error" });
  for (const field of ["declarations", "imports", "exports", "references", "tests", "routes"] as const) {
    if (result[field].length > structureLimit) {
      result[field].splice(structureLimit);
      result.gaps.push({ line: 1, kind: `metadata-limit:${field}` });
    }
  }
  if (result.gaps.length > structureLimit) {
    // A metadata cap must not discard the diagnostic that stops an unsafe trace.
    const parseError = result.gaps.find((gap) => gap.kind === "parse-error");
    const markers = [
      ...(parseError ? [parseError] : []),
      ...result.gaps.filter((gap) => gap.kind.startsWith("metadata-limit:")),
      { line: 1, kind: "diagnostic-truncation" },
    ];
    const kinds = new Set(markers.map((gap) => gap.kind));
    result.gaps = [...markers, ...result.gaps.filter((gap) => !kinds.has(gap.kind)).slice(0, structureLimit - markers.length)];
  }
  return result;
}
