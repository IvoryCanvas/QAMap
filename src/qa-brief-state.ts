import ts from "typescript";
import { bindBriefSource, comparedBaseLines, type BriefHunk, type BriefSnapshot } from "./qa-brief-syntax.js";

interface Cell { root: ts.Symbol; path: string[]; text: string }
interface StateEdge { cell: Cell; from: string; to: string; guard: ts.Node; write: ts.BinaryExpression; uncertain?: string }

function ownerOf(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (parent && !ts.isFunctionLike(parent) && !ts.isSourceFile(parent)) parent = parent.parent;
  return parent ?? node.getSourceFile();
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node); ts.forEachChild(node, child => walk(child, visit));
}

function cellOf(expression: ts.Expression, checker: ts.TypeChecker): Cell | undefined {
  if (ts.isParenthesizedExpression(expression)) return cellOf(expression.expression, checker);
  if (expression.kind === ts.SyntaxKind.ThisKeyword) {
    const declaration = ts.findAncestor(expression, ts.isClassLike);
    const root = declaration?.name ? checker.getSymbolAtLocation(declaration.name) : undefined;
    return root ? { root, path: [], text: "this" } : undefined;
  }
  if (ts.isIdentifier(expression)) {
    const root = checker.getSymbolAtLocation(expression);
    return root ? { root, path: [], text: expression.text } : undefined;
  }
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const base = cellOf(expression.expression, checker);
  return base ? { ...base, path: [...base.path, expression.name.text], text: `${base.text}.${expression.name.text}` } : undefined;
}

function sameCell(left: Cell | undefined, right: Cell | undefined): boolean {
  return !!left && !!right && left.root === right.root && left.path.join(".") === right.path.join(".");
}

function overlaps(left: Cell, right: Cell): boolean {
  return left.root === right.root && left.path.slice(0, right.path.length).join(".") === right.path.join(".");
}

function literal(expression: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(expression) ? JSON.stringify(expression.text)
    : expression.kind === ts.SyntaxKind.TrueKeyword ? "true" : expression.kind === ts.SyntaxKind.FalseKeyword ? "false" : undefined;
}

const lineOf = (node: ts.Node): number => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
const columnOf = (node: ts.Node): number => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).character;
const short = (text: string): string => text.length > 60 ? `${text.slice(0, 57)}...` : text;

function stateEdges(snapshot: BriefSnapshot): StateEdge[] {
  const { source, checker } = snapshot;
  const writes: Array<{ node: ts.BinaryExpression; cell: Cell }> = [], awaits: ts.AwaitExpression[] = [];
  const mutations: Array<{ node: ts.Node; cell: Cell }> = [];
  walk(source, node => {
    if (ts.isAwaitExpression(node)) awaits.push(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const cell = cellOf(node.left, checker);
      if (cell) { writes.push({ node, cell }); mutations.push({ node, cell }); }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      const cell = cellOf(node.operand, checker);
      if (cell) mutations.push({ node, cell });
    }
  });
  const edges: StateEdge[] = [];
  for (const { node: write, cell } of writes) {
    const to = literal(write.right), owner = ownerOf(write);
    if (write.operatorToken.kind !== ts.SyntaxKind.EqualsToken || to === undefined || ts.isSourceFile(owner)) continue;
    let node: ts.Node = write;
    while (node.parent && node.parent !== owner) {
      const parent = node.parent;
      let guard: ts.Node | undefined, from: string | undefined, fallthrough = false;
      if (ts.isIfStatement(parent) && parent.thenStatement === node && ts.isBinaryExpression(parent.expression)
        && parent.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        if (sameCell(cellOf(parent.expression.left, checker), cell)) from = literal(parent.expression.right);
        else if (sameCell(cellOf(parent.expression.right, checker), cell)) from = literal(parent.expression.left);
        guard = parent.expression;
      } else if (ts.isCaseClause(parent) && ts.isCaseBlock(parent.parent) && ts.isSwitchStatement(parent.parent.parent)
        && sameCell(cellOf(parent.parent.parent.expression, checker), cell)) {
        guard = parent.expression; from = literal(parent.expression);
        const index = parent.parent.clauses.indexOf(parent), previous = parent.parent.clauses[index - 1];
        const last = previous?.statements.at(-1);
        fallthrough = index > 0 && (!last || !ts.isBreakStatement(last) && !ts.isReturnStatement(last) && !ts.isThrowStatement(last));
      }
      if (guard && from !== undefined) {
        const prior = mutations.find(other => other.node !== write && other.node.getStart() > guard!.getEnd()
          && other.node.getStart() < write.getStart() && ownerOf(other.node) === owner && (overlaps(cell, other.cell) || overlaps(other.cell, cell)));
        const gap = awaits.find(item => item.getStart() > guard!.getEnd() && item.getStart() < write.getStart() && ownerOf(item) === owner);
        edges.push({ cell, from, to, guard, write, uncertain: fallthrough ? "case fallthrough" : prior ? `intervening write at ${lineOf(prior.node)}` : gap ? `await at ${lineOf(gap)}` : undefined });
        break;
      }
      if (ts.isFunctionLike(parent)) break;
      node = parent;
    }
  }
  return edges;
}

interface Dependency { inputs: Cell[]; lines: number[]; shape: string }

function sharedMapSignals(snapshot: BriefSnapshot, changed: Set<number>): string[] {
  const { source, checker } = snapshot;
  const maps = new Map<ts.Symbol, ts.VariableDeclaration>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || !init || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression)
        || init.expression.text !== "Map" || checker.getSymbolAtLocation(init.expression)) continue;
      const symbol = checker.getSymbolAtLocation(declaration.name);
      if (symbol) maps.set(symbol, declaration);
    }
  }
  if (!maps.size) return [];
  const calls: ts.CallExpression[] = [], awaits: ts.AwaitExpression[] = [], assigned = new Set<ts.Symbol>();
  walk(source, node => {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isAwaitExpression(node)) awaits.push(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const cell = cellOf(node.left, checker);
      if (cell) assigned.add(cell.root);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      const cell = cellOf(node.operand, checker);
      if (cell) assigned.add(cell.root);
    }
  });
  const mapOf = (call: ts.CallExpression): ts.Symbol | undefined => ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
    ? checker.getSymbolAtLocation(call.expression.expression) : undefined;
  const method = (call: ts.CallExpression): string => ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "";
  const symbols = new Map<ts.Symbol, number>();
  const keyOf = (cell: Cell): string => {
    if (!symbols.has(cell.root)) symbols.set(cell.root, symbols.size);
    return `${symbols.get(cell.root)}:${cell.path.join(".")}`;
  };
  const signals: string[] = [];
  for (const write of calls) {
    if (signals.length >= 2) break;
    const symbol = mapOf(write), owner = ownerOf(write), declaration = symbol && maps.get(symbol);
    if (!symbol || !declaration || assigned.has(symbol) || method(write) !== "set" || write.arguments.length !== 2 || !ts.isFunctionLike(owner)) continue;
    const parameters = new Set(owner.parameters.flatMap(parameter => ts.isIdentifier(parameter.name) ? [checker.getSymbolAtLocation(parameter.name)!].filter(Boolean) : []));
    const resolve = (expression: ts.Expression, key: boolean, seen = new Set<ts.Symbol>()): Dependency | undefined => {
      if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)) return resolve(expression.expression, key, seen);
      const cell = cellOf(expression, checker);
      if (cell && parameters.has(cell.root)) return assigned.has(cell.root) ? undefined : { inputs: [cell], lines: [lineOf(expression)], shape: keyOf(cell) };
      if (ts.isIdentifier(expression)) {
        const binding = checker.getSymbolAtLocation(expression), value = binding?.valueDeclaration;
        if (!binding || assigned.has(binding) || seen.has(binding) || seen.size >= 5 || !value || !ts.isVariableDeclaration(value)
          || !value.initializer || ownerOf(value) !== owner || !ts.isVariableDeclarationList(value.parent) || !(value.parent.flags & ts.NodeFlags.Const)) return undefined;
        const resolved = resolve(value.initializer, key, new Set([...seen, binding]));
        return resolved ? { ...resolved, lines: [...resolved.lines, lineOf(value)] } : undefined;
      }
      if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) || literal(expression) !== undefined || expression.kind === ts.SyntaxKind.NullKeyword) {
        const shape = literal(expression) ?? (ts.isNumericLiteral(expression) ? `number:${Number(expression.text)}` : "null");
        return { inputs: [], lines: [lineOf(expression)], shape };
      }
      let parts: ts.Expression[] | undefined;
      if (ts.isTemplateExpression(expression)) parts = expression.templateSpans.map(span => span.expression);
      else if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) parts = [expression.left, expression.right];
      else if (!key && ts.isCallExpression(expression)) {
        parts = [...expression.arguments];
        if (cellOf(expression.expression, checker) && parameters.has(cellOf(expression.expression, checker)!.root)) parts.push(expression.expression);
      }
      if (!parts) return undefined;
      const dependencies = parts.map(part => resolve(part, key, seen));
      if (dependencies.some(part => !part)) return undefined;
      return { inputs: dependencies.flatMap(part => part!.inputs), lines: [lineOf(expression), ...dependencies.flatMap(part => part!.lines)],
        shape: JSON.stringify([expression.kind, ts.isTemplateExpression(expression) ? [expression.head.text, ...expression.templateSpans.map(span => span.literal.text)] : [], dependencies.map(part => part!.shape)]) };
    };
    const key = resolve(write.arguments[0], true), value = resolve(write.arguments[1], false);
    if (!key || !value?.inputs.length) continue;
    const read = calls.find(call => mapOf(call) === symbol && method(call) === "get" && ownerOf(call) === owner && call.getStart() < write.getStart()
      && call.arguments.length === 1 && resolve(call.arguments[0], true)?.shape === key.shape);
    if (!read) continue;
    const cleared = calls.some(call => mapOf(call) === symbol && method(call) === "clear" && ownerOf(call) === owner && call.getStart() < read.getStart()
      && ts.isExpressionStatement(call.parent) && ts.isBlock(call.parent.parent) && call.parent.parent.parent === owner
      && !awaits.some(gap => ownerOf(gap) === owner && gap.getStart() > call.getEnd() && gap.getStart() < read.getStart()));
    if (cleared) continue;
    const relevant = [lineOf(declaration), lineOf(read), lineOf(write), ...key.lines, ...value.lines];
    if (!relevant.some(line => changed.has(line))) continue;
    const missing = [...new Map(value.inputs.filter(input => !key.inputs.some(keyInput => overlaps(input, keyInput))).map(input => [keyOf(input), input])).values()];
    if (!missing.length) continue;
    const valueNode = ts.isIdentifier(write.arguments[1]) ? checker.getSymbolAtLocation(write.arguments[1])?.valueDeclaration : write.arguments[1];
    signals.push(`shared Map scope: \`${short(declaration.name.getText(source))}\` (module ${lineOf(declaration)}) key read ${lineOf(read)}, write ${lineOf(write)} omits value inputs ${missing.slice(0, 3).map(input => `\`${short(input.text)}\``).join(", ")} (value ${lineOf(valueNode ?? write)}); review key scope`);
  }
  return signals;
}

export function stateCacheSignals(file: string, hunks: BriefHunk[], head: string[]): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
  const changed = new Set<number>();
  for (const hunk of hunks) {
    let line = hunk.newStart;
    for (const row of hunk.lines) { if (row.startsWith("+")) changed.add(line); if (!row.startsWith("-")) line++; }
  }
  const snapshot = bindBriefSource(file, head);
  if (!snapshot) return [];
  const touched = (node: ts.Node): boolean => {
    const start = lineOf(node), end = node.getSourceFile().getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1;
    for (let line = start; line <= end; line++) if (changed.has(line)) return true;
    return false;
  };
  const edges = stateEdges(snapshot), signals: string[] = [];
  for (const edge of edges) {
    if (signals.length >= 2) break;
    if (!touched(edge.guard) && !touched(edge.write)) continue;
    signals.push(edge.uncertain
      ? `state draft unresolved: \`${short(edge.cell.text)}\` guard ${lineOf(edge.guard)}, write ${lineOf(edge.write)} (${edge.uncertain}); human review required`
      : `state draft: \`${short(edge.cell.text)}\` ${short(edge.from)} -> ${short(edge.to)} (guard ${lineOf(edge.guard)}, write ${lineOf(edge.write)}); review intended transition`);
  }
  if (signals.length < 2 && hunks.some(hunk => hunk.lines.some(line => line.startsWith("-")))) {
    const base = comparedBaseLines(hunks, head), previous = base && bindBriefSource(file, base.map(row => row.text));
    if (base && previous) for (const edge of stateEdges(previous)) {
      if (signals.length >= 2) break;
      if (edge.uncertain || edges.some(current => base[lineOf(edge.write) - 1]?.headLine === lineOf(current.write) && columnOf(edge.write) === columnOf(current.write))) continue;
      const removed = [edge.guard, edge.write].some(node => {
        const end = node.getSourceFile().getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1;
        return base.slice(lineOf(node) - 1, end).some(row => row.headLine === undefined);
      });
      if (removed) signals.push(`state draft removed: \`${short(edge.cell.text)}\` ${short(edge.from)} -> ${short(edge.to)} (base guard ${lineOf(edge.guard)}, base write ${lineOf(edge.write)}); review replacement`);
    }
  }
  return [...signals, ...sharedMapSignals(snapshot, changed)];
}
