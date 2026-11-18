import ts from "typescript";
import { bindBriefSource } from "./qa-brief-syntax.js";
import { collectSourceStructure, type SourceStructure, type SymbolImport } from "./source-structure.js";

export interface BriefReferenceBinding {
  name: string;
  member?: string;
  line: number;
  owner?: string;
  call: boolean;
  declaration?: { name: string; line: number; start: number; topLevel: boolean; callable: boolean };
  imported?: SymbolImport;
}

export interface BriefTestBody {
  title: string;
  titleLine: number;
  firstLine: number;
  lastLine: number;
  asyncThrowAssertions: Set<number>;
}

export interface BriefBindings {
  structure: SourceStructure;
  references: BriefReferenceBinding[];
  avaTests?: BriefTestBody[];
}

// Bind only the supplied snapshot. Imports, compiler configuration and repository
// code are never loaded or evaluated to resolve a name.
export function collectBriefBindings(file: string, lines: string[]): BriefBindings | undefined {
  const bound = bindBriefSource(file, lines);
  if (!bound) return undefined;
  const { source, checker } = bound;
  const structure = collectSourceStructure(file, lines.join("\n"));
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  // Index coordinates identify eligible module declarations, but only their
  // actual AST nodes identify bindings. A parameter or local can share a name
  // and line with a module declaration without belonging to that declaration.
  const moduleDeclarations = new Set<ts.Node>();
  for (const statement of source.statements) {
    const declarations = ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [statement];
    for (const declaration of declarations) if ((ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration)
      || ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))
      && declaration.name && ts.isIdentifier(declaration.name) && structure.declarations.some(entry =>
        entry.name === declaration.name!.getText(source) && entry.line === lineOf(declaration))) moduleDeclarations.add(declaration);
  }
  // TypeScript may synthesize a CommonJS alias at `exports.member`. Such a
  // property declaration is not a lexical binding that shadows the global.
  const unshadowed = (node: ts.Identifier): boolean => !checker.getSymbolAtLocation(node)?.declarations?.some(declaration =>
    !ts.isPropertyAccessExpression(declaration) && !ts.isElementAccessExpression(declaration) && !ts.isSourceFile(declaration));
  const requireOf = (node: ts.Expression | undefined): string | undefined => node && ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === "require" && unshadowed(node.expression)
    && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined;
  const importedOf = (declaration: ts.Declaration, name: string): SymbolImport | undefined => {
    const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
    if (statement && ts.isStringLiteral(statement.moduleSpecifier)) {
      const imported = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text
        : ts.isNamespaceImport(declaration) ? "*" : ts.isImportClause(declaration) ? "default" : undefined;
      if (imported) return { module: statement.moduleSpecifier.text, imported, local: name, line: lineOf(declaration) };
    }
    const variable = ts.isVariableDeclaration(declaration) ? declaration : ts.findAncestor(declaration, ts.isVariableDeclaration);
    const module = variable && requireOf(variable.initializer);
    if (!variable || !module) return undefined;
    const imported = ts.isIdentifier(variable.name) ? "*" : ts.isBindingElement(declaration) && declaration.parent === variable.name
      && (!declaration.propertyName || ts.isIdentifier(declaration.propertyName)) ? (declaration.propertyName ?? declaration.name).getText(source) : undefined;
    return imported ? { module, imported, local: name, line: lineOf(declaration) } : undefined;
  };
  // Literal CommonJS bindings use the same local/imported identities as ES imports.
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      const names = ts.isIdentifier(declaration.name) ? [declaration.name]
        : ts.isObjectBindingPattern(declaration.name) ? declaration.name.elements.filter(element => !element.dotDotDotToken).map(element => element.name).filter(ts.isIdentifier) : [];
      for (const name of names) {
        const symbol = checker.getSymbolAtLocation(name);
        const value = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        const imported = value && importedOf(value, name.text);
        if (imported && !structure.imports.some(entry => entry.local === imported.local && entry.line === imported.line)) structure.imports.push(imported);
      }
    }
  }
  const exportIdentifiers = new Set<ts.Node>();
  const exportTarget = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) exportIdentifiers.add(node);
    ts.forEachChild(node, exportTarget);
  };
  const exportName = (expression: ts.Expression): string | undefined => ts.isPropertyAccessExpression(expression)
    && (ts.isIdentifier(expression.expression) && expression.expression.text === "exports" && unshadowed(expression.expression)
      || ts.isPropertyAccessExpression(expression.expression) && ts.isIdentifier(expression.expression.expression)
        && expression.expression.expression.text === "module" && unshadowed(expression.expression.expression)
        && expression.expression.name.text === "exports") ? expression.name.text : undefined;
  for (const statement of source.statements) if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
    && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const { left, right } = statement.expression;
    const name = exportName(left);
    if (name && ts.isIdentifier(right)) {
      structure.exports.push({ local: right.text, exported: name, line: lineOf(statement) });
      exportTarget(left); exportIdentifiers.add(right);
    }
    else if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "module"
      && unshadowed(left.expression) && left.name.text === "exports") {
      exportTarget(left);
      if (ts.isIdentifier(right)) { structure.exports.push({ local: right.text, exported: "default", line: lineOf(statement) }); exportIdentifiers.add(right); }
      else if (ts.isObjectLiteralExpression(right)) for (const property of right.properties) {
        if (ts.isShorthandPropertyAssignment(property)) { structure.exports.push({ local: property.name.text, exported: property.name.text, line: lineOf(property) }); exportIdentifiers.add(property.name); }
        else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && ts.isIdentifier(property.initializer)) {
          structure.exports.push({ local: property.initializer.text, exported: property.name.text, line: lineOf(property) });
          exportIdentifiers.add(property.initializer);
        }
      }
    }
  }
  const references: BriefReferenceBinding[] = [];
  const ownerOf = (node: ts.Node): string | undefined => {
    for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
      if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name && ts.isIdentifier(parent.name)
        && moduleDeclarations.has(parent)) return parent.name.text;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !exportIdentifiers.has(node)) {
      const parent = node.parent;
      const declarationName = (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)
        || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent)
        || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node;
      const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node
        || (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node;
      if (!declarationName && !propertyName && !ts.isImportSpecifier(parent) && !ts.isImportClause(parent)
        && !ts.isNamespaceImport(parent) && !ts.isExportSpecifier(parent)) {
        const symbol = ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        const imported = declaration && importedOf(declaration, node.text);
        const member = ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent.name.text : undefined;
        let expression: ts.Node = member ? parent : node;
        while ((ts.isParenthesizedExpression(expression.parent) || ts.isAsExpression(expression.parent)
          || ts.isTypeAssertionExpression(expression.parent) || ts.isNonNullExpression(expression.parent)
          || ts.isSatisfiesExpression(expression.parent)) && expression.parent.expression === expression) expression = expression.parent;
        const callExpression = expression.parent;
        const call = (ts.isCallExpression(callExpression) || ts.isNewExpression(callExpression)) && callExpression.expression === expression;
        const topLevel = declaration && moduleDeclarations.has(declaration);
        references.push({ name: node.text, line: lineOf(node), owner: ownerOf(node), call, ...(member ? { member } : {}), ...(imported ? { imported } : {}),
          ...(declaration && !imported ? { declaration: { name: node.text, line: lineOf(declaration), start: declaration.getStart(source), topLevel: !!topLevel,
            callable: ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration) || ts.isVariableDeclaration(declaration) && !!declaration.initializer
              && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) } } : {}) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const avaTests = collectAvaTestBodies(source, checker, lineOf);
  return { structure, references, ...(avaTests ? { avaTests } : {}) };
}

// Recognize declarations through AVA's imported binding and immutable aliases.
// A name or a call outside the callback cannot establish test ownership.
function collectAvaTestBodies(source: ts.SourceFile, checker: ts.TypeChecker,
  lineOf: (node: ts.Node) => number): BriefTestBody[] | undefined {
  const runners = new Set<ts.Symbol>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "ava") continue;
    const clause = statement.importClause;
    const runner = clause?.name && !clause.isTypeOnly ? checker.getSymbolAtLocation(clause.name) : undefined;
    if (runner) runners.add(runner);
  }
  if (!runners.size) return undefined;

  const modifiers = new Set(["failing", "only", "serial", "skip"]);
  const isRunner = (expression: ts.Expression): boolean => {
    while (ts.isPropertyAccessExpression(expression) && modifiers.has(expression.name.text)) expression = expression.expression;
    const symbol = ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression) : undefined;
    return symbol !== undefined && runners.has(symbol);
  };
  const tests: BriefTestBody[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0 && node.initializer) {
      const value = node.initializer;
      const alias = ts.isConditionalExpression(value) ? isRunner(value.whenTrue) && isRunner(value.whenFalse) : isRunner(value);
      const symbol = alias ? checker.getSymbolAtLocation(node.name) : undefined;
      if (symbol) runners.add(symbol);
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && isRunner(node.expression.expression)) {
      const [title, callback] = node.expression.arguments;
      if (title && ts.isStringLiteralLike(title) && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const body = callback.body;
        const parameter = callback.parameters[0]?.name;
        const receiver = parameter && ts.isIdentifier(parameter) ? checker.getSymbolAtLocation(parameter) : undefined;
        const asyncThrowAssertions = new Set<number>();
        if (receiver) {
          const collectAssertions = (child: ts.Node): void => {
            if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
              const access = child.expression;
              if ((access.name.text === "throwsAsync" || access.name.text === "notThrowsAsync")
                && ts.isIdentifier(access.expression) && checker.getSymbolAtLocation(access.expression) === receiver) {
                asyncThrowAssertions.add(lineOf(access));
              }
            }
            ts.forEachChild(child, collectAssertions);
          };
          collectAssertions(body);
        }
        // The brief stores use coordinates by line. Leave shared boundary
        // lines unassigned rather than attributing a neighboring statement.
        let firstLine = lineOf(body);
        let lastLine = source.getLineAndCharacterOfPosition(body.getEnd() - 1).line + 1;
        const statementStart = node.getStart(source);
        const statementEnd = node.getEnd();
        if (lineOf(node) === firstLine
          && source.text.slice(source.getPositionOfLineAndCharacter(firstLine - 1, 0), statementStart).trim()) firstLine++;
        if (source.getLineAndCharacterOfPosition(statementEnd).line + 1 === lastLine) {
          const newline = source.text.indexOf("\n", statementEnd);
          const after = source.text.slice(statementEnd, newline === -1 ? undefined : newline).trimStart();
          if (after && !after.startsWith("//")) lastLine--;
        }
        if (firstLine <= lastLine) tests.push({ title: title.text, titleLine: lineOf(title), firstLine, lastLine, asyncThrowAssertions });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tests;
}
