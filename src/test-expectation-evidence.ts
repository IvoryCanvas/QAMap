import ts from "typescript";

// Bind only this already verified text. No imports, config, libraries or repository code are loaded.
export function createTestExpectationReader(file: string, text: string): (line: number, symbol: string) => number[] {
  try {
    const read = bindTestExpectations(file, text);
    return (line, symbol) => { try { return read(line, symbol); } catch { return []; } };
  } catch { return () => []; }
}

function bindTestExpectations(file: string, text: string): (line: number, symbol: string) => number[] {
  const filename = `/${file}`;
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true };
  const host: ts.CompilerHost = {
    getSourceFile: name => name === filename ? source : undefined,
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "/",
    getDirectories: () => [], fileExists: name => name === filename,
    readFile: name => name === filename ? text : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  const program = ts.createProgram([filename], options, host);
  if (program.getSyntacticDiagnostics(source).length) return () => [];
  const checker = program.getTypeChecker();
  const start = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const end = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.end).line + 1;
  const root = (node: ts.Expression): ts.Identifier | undefined => {
    if (ts.isIdentifier(node)) return node;
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) return root(node.expression);
    return undefined;
  };
  const imported = (identifier: ts.Identifier, names: RegExp, modules: RegExp): boolean => {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) return names.test(identifier.text);
    return !!symbol.declarations?.some(declaration => {
      let name = identifier.text;
      if (ts.isImportSpecifier(declaration)) name = (declaration.propertyName ?? declaration.name).text;
      else if (!ts.isImportClause(declaration) && !ts.isNamespaceImport(declaration)) return false;
      let parent: ts.Node | undefined = declaration;
      while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
      if (parent && ts.isImportDeclaration(parent) && ts.isStringLiteral(parent.moduleSpecifier)
        && (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration))) {
        if (/^(?:node:)?assert(?:\/strict)?$/.test(parent.moduleSpecifier.text)) name = "assert";
        if (parent.moduleSpecifier.text === "node:test") name = "test";
      }
      return names.test(name) && !!parent && ts.isImportDeclaration(parent)
        && ts.isStringLiteral(parent.moduleSpecifier) && modules.test(parent.moduleSpecifier.text);
    });
  };
  const testRoot = (call: ts.CallExpression): boolean => {
    const identifier = root(call.expression);
    return !!identifier && imported(identifier, /^(?:test|it)$/, /^(?:node:test|vitest|@jest\/globals)$/);
  };
  const assertion = (call: ts.CallExpression): boolean => {
    const identifier = root(call.expression);
    return !!identifier && imported(identifier, /^(?:assert|expect)$/, /^(?:node:assert(?:\/strict)?|assert(?:\/strict)?|vitest|@jest\/globals)$/);
  };
  const callback = (node: ts.Node): ts.Node | undefined => {
    for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent)) {
        return ts.isCallExpression(parent.parent) && testRoot(parent.parent) ? parent : undefined;
      }
    }
    return undefined;
  };
  const identifiers = (node: ts.Node): Set<ts.Symbol> => {
    const symbols = new Set<ts.Symbol>();
    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child) && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)) {
        const symbol = checker.getSymbolAtLocation(child);
        if (symbol) symbols.add(symbol);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return symbols;
  };
  const references: ts.Identifier[] = [];
  const calls: ts.CallExpression[] = [];
  const constants: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) references.push(node);
    if (ts.isCallExpression(node) && assertion(node)) calls.push(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) constants.push(node);
    ts.forEachChild(node, collect);
  };
  collect(source);
  return (line, name) => {
    const lines = new Set<number>();
    for (const reference of references.filter(node => start(node) === line && node.text === name)) {
      const owner = callback(reference);
      const binding = checker.getSymbolAtLocation(reference);
      if (!owner || !binding) continue;
      // A namespace binding alone cannot distinguish its unrelated members.
      if (binding.declarations?.some(ts.isNamespaceImport)) continue;
      const related = new Set([binding]);
      const local = constants.filter(node => callback(node) === owner);
      const links = new Map<ts.Symbol, ts.VariableDeclaration>();
      for (const declaration of local) {
        if (![...identifiers(declaration.initializer!)].some(symbol => related.has(symbol))) continue;
        const symbol = checker.getSymbolAtLocation(declaration.name);
        if (symbol) { related.add(symbol); links.set(symbol, declaration); }
      }
      const addLines = (node: ts.Node): void => {
        for (let n = start(node); n <= end(node); n++) lines.add(n);
      };
      for (const call of calls.filter(node => callback(node) === owner)) {
        const used = identifiers(call);
        if (![...used].some(symbol => related.has(symbol))) continue;
        addLines(call);
        const seen = new Set<ts.Symbol>();
        const addBinding = (symbol: ts.Symbol): void => {
          if (seen.has(symbol)) return;
          seen.add(symbol);
          const declaration = links.get(symbol);
          if (!declaration) return;
          addLines(declaration);
          for (const dependency of identifiers(declaration.initializer!)) addBinding(dependency);
        };
        for (const symbol of used) addBinding(symbol);
      }
    }
    return [...lines].sort((a, b) => a - b);
  };
}
