import ts from "typescript";
import { bindBriefSource, comparedBaseLines, type BriefHunk, type BriefSnapshot } from "./qa-brief-syntax.js";

interface Cell { root: ts.Symbol; path: string[]; text: string }
interface StateEdge { cell: Cell; from: string; to: string; guard: ts.Node; selector?: ts.Expression; write: ts.BinaryExpression; evidence: ts.Node[]; uncertain?: string }
interface ComparedSource { snapshot: BriefSnapshot; rows: Array<{ text: string; headLine?: number }> }

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

function nodeLines(node: ts.Node): number[] {
  const end = node.getSourceFile().getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1;
  return Array.from({ length: end - lineOf(node) + 1 }, (_, index) => lineOf(node) + index);
}

const touched = (node: ts.Node, changed: Set<number>): boolean => nodeLines(node).some(line => changed.has(line));
const removed = (node: ts.Node, rows: ComparedSource["rows"]): boolean => nodeLines(node).some(line => rows[line - 1]?.headLine === undefined);
const mapsTo = (before: ts.Node, after: ts.Node, rows: ComparedSource["rows"]): boolean =>
  rows[lineOf(before) - 1]?.headLine === lineOf(after) && columnOf(before) === columnOf(after);

// Snapshots have distinct symbols. Retain an indistinguishable candidate only
// at its surviving writer, never by matching a name in another scope.
const retainsEdge = (before: StateEdge, after: StateEdge, rows: ComparedSource["rows"]): boolean =>
  mapsTo(before.write, after.write, rows) && before.cell.text === after.cell.text
  && before.from === after.from && before.to === after.to;

// Assignment patterns do not establish state edges, but their targets still invalidate one.
function targetCells(node: ts.Node, checker: ts.TypeChecker): Cell[] {
  if (ts.isParenthesizedExpression(node)) return targetCells(node.expression, checker);
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const cell = cellOf(node, checker);
    return cell ? [cell] : [];
  }
  if (ts.isElementAccessExpression(node)) {
    const base = cellOf(node.expression, checker), key = node.argumentExpression;
    return base ? [{ ...base, path: key && ts.isStringLiteralLike(key) ? [...base.path, key.text] : base.path }] : [];
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(item => targetCells(item, checker));
  if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap(item => {
    if (ts.isShorthandPropertyAssignment(item)) {
      const root = checker.getShorthandAssignmentValueSymbol(item);
      return root ? [{ root, path: [], text: item.name.text }] : [];
    }
    return ts.isPropertyAssignment(item) ? targetCells(item.initializer, checker)
      : ts.isSpreadAssignment(item) ? targetCells(item.expression, checker) : [];
  });
  if (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node)) return node.elements.flatMap(item => ts.isBindingElement(item) ? targetCells(item.name, checker) : []);
  if (ts.isSpreadElement(node)) return targetCells(node.expression, checker);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return targetCells(node.left, checker);
  return [];
}

function mutationTargets(node: ts.Node, checker: ts.TypeChecker, initializers = false): Array<{ node: ts.Node; cell: Cell }> {
  let target: ts.Node | undefined;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = node.left;
  else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) target = node.operand;
  else if (initializers && ts.isVariableDeclaration(node) && node.initializer) target = node.name;
  else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const targets = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations.flatMap(item => targetCells(item.name, checker)) : targetCells(node.initializer, checker);
    return targets.map(cell => ({ node: node.initializer, cell }));
  }
  return target ? targetCells(target, checker).map(cell => ({ node, cell })) : [];
}

function stateEdges(snapshot: BriefSnapshot): StateEdge[] {
  const { source, checker } = snapshot;
  const writes: Array<{ node: ts.BinaryExpression; cell: Cell }> = [], awaits: ts.AwaitExpression[] = [];
  const mutations: Array<{ node: ts.Node; cell: Cell }> = [];
  walk(source, node => {
    if (ts.isAwaitExpression(node)) awaits.push(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const cell = cellOf(node.left, checker);
      if (cell) writes.push({ node, cell });
    }
    mutations.push(...mutationTargets(node, checker, true));
  });
  const edges: StateEdge[] = [];
  for (const { node: write, cell } of writes) {
    const to = literal(write.right), owner = ownerOf(write);
    if (write.operatorToken.kind !== ts.SyntaxKind.EqualsToken || to === undefined || ts.isSourceFile(owner)) continue;
    let node: ts.Node = write;
    while (node.parent && node.parent !== owner) {
      const parent = node.parent;
      let guard: ts.Node | undefined, selector: ts.Expression | undefined, from: string | undefined, fallthrough = false;
      const evidence: ts.Node[] = [];
      if (ts.isIfStatement(parent) && parent.thenStatement === node && ts.isBinaryExpression(parent.expression)
        && parent.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        if (sameCell(cellOf(parent.expression.left, checker), cell)) from = literal(parent.expression.right);
        else if (sameCell(cellOf(parent.expression.right, checker), cell)) from = literal(parent.expression.left);
        guard = parent.expression;
      } else if (ts.isCaseClause(parent) && ts.isCaseBlock(parent.parent) && ts.isSwitchStatement(parent.parent.parent)
        && sameCell(cellOf(parent.parent.parent.expression, checker), cell)) {
        guard = parent.expression; from = literal(parent.expression);
        selector = parent.parent.parent.expression;
        evidence.push(selector);
        const index = parent.parent.clauses.indexOf(parent), previous = parent.parent.clauses[index - 1];
        const last = previous?.statements.at(-1);
        fallthrough = index > 0 && (!last || !ts.isBreakStatement(last) && !ts.isReturnStatement(last) && !ts.isThrowStatement(last));
        if (previous) evidence.push(last ?? (ts.isCaseClause(previous) ? previous.expression : previous));
      }
      if (guard && from !== undefined) {
        const prior = mutations.filter(other => other.node !== write && other.node.getStart() > guard!.getEnd()
          && other.node.getStart() < write.getStart() && ownerOf(other.node) === owner && (overlaps(cell, other.cell) || overlaps(other.cell, cell)));
        const gaps = awaits.filter(item => item.getStart() > guard!.getEnd() && item.getStart() < write.getStart() && ownerOf(item) === owner);
        edges.push({ cell, from, to, guard, selector, write, evidence: [...evidence, ...prior.map(item => item.node), ...gaps],
          uncertain: fallthrough ? "case fallthrough" : prior.length ? `intervening write at ${lineOf(prior[0].node)}` : gaps.length ? `await at ${lineOf(gaps[0])}` : undefined });
        break;
      }
      if (ts.isFunctionLike(parent)) break;
      node = parent;
    }
  }
  return edges;
}

interface Dependency { inputs: Cell[]; nodes: ts.Node[]; shape: string }

function mapFacts(snapshot: BriefSnapshot): { maps: Map<ts.Symbol, ts.VariableDeclaration>; calls: ts.CallExpression[]; awaits: ts.AwaitExpression[]; assigned: Set<ts.Symbol> } {
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
  const calls: ts.CallExpression[] = [], awaits: ts.AwaitExpression[] = [], assigned = new Set<ts.Symbol>();
  walk(source, node => {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isAwaitExpression(node)) awaits.push(node);
    for (const mutation of mutationTargets(node, checker)) assigned.add(mutation.cell.root);
  });
  return { maps, calls, awaits, assigned };
}

const mapOf = (call: ts.CallExpression, checker: ts.TypeChecker): ts.Symbol | undefined => ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
  ? checker.getSymbolAtLocation(call.expression.expression) : undefined;
const method = (call: ts.CallExpression): string => ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "";

function directClearBefore(call: ts.CallExpression, read: ts.CallExpression, symbol: ts.Symbol, snapshot: BriefSnapshot): boolean {
  const owner = ownerOf(read);
  return mapOf(call, snapshot.checker) === symbol && method(call) === "clear" && ownerOf(call) === owner && call.getStart() < read.getStart()
    && ts.isExpressionStatement(call.parent) && ts.isBlock(call.parent.parent) && call.parent.parent.parent === owner;
}

function awaitsBetween(before: ts.Node, after: ts.Node, awaits: ts.AwaitExpression[]): ts.AwaitExpression[] {
  return awaits.filter(gap => ownerOf(gap) === ownerOf(after) && gap.getStart() > before.getEnd() && gap.getStart() < after.getStart());
}

function sharedMapSignals(snapshot: BriefSnapshot, changed: Set<number>, compared?: ComparedSource): string[] {
  const { source, checker } = snapshot, { maps, calls, awaits, assigned } = mapFacts(snapshot);
  if (!maps.size) return [];
  const previous = compared && mapFacts(compared.snapshot);
  const symbols = new Map<ts.Symbol, number>();
  const keyOf = (cell: Cell): string => {
    if (!symbols.has(cell.root)) symbols.set(cell.root, symbols.size);
    return `${symbols.get(cell.root)}:${cell.path.join(".")}`;
  };
  const signals: string[] = [];
  for (const write of calls) {
    if (signals.length >= 2) break;
    const symbol = mapOf(write, checker), owner = ownerOf(write), declaration = symbol && maps.get(symbol);
    if (!symbol || !declaration || assigned.has(symbol) || method(write) !== "set" || write.arguments.length !== 2 || !ts.isFunctionLike(owner)) continue;
    const parameters = new Set(owner.parameters.flatMap(parameter => ts.isIdentifier(parameter.name) ? [checker.getSymbolAtLocation(parameter.name)!].filter(Boolean) : []));
    const aliasOf = (binding: ts.Symbol | undefined, seen: Set<ts.Symbol>): ts.VariableDeclaration | undefined => {
      const value = binding?.valueDeclaration;
      return binding && !assigned.has(binding) && !seen.has(binding) && seen.size < 5 && value && ts.isVariableDeclaration(value)
        && value.initializer && ownerOf(value) === owner && ts.isVariableDeclarationList(value.parent) && (value.parent.flags & ts.NodeFlags.Const) ? value : undefined;
    };
    // Follow only constant aliases of a simple input path, including aliases used as a callee/base.
    const inputOf = (expression: ts.Expression, seen: Set<ts.Symbol>): { cell: Cell; nodes: ts.Node[] } | undefined => {
      const cell = cellOf(expression, checker);
      if (!cell || assigned.has(cell.root)) return undefined;
      if (parameters.has(cell.root)) return { cell, nodes: [expression] };
      const alias = aliasOf(cell.root, seen);
      if (!alias) return undefined;
      const base = inputOf(alias.initializer!, new Set([...seen, cell.root]));
      return base ? { cell: { ...base.cell, path: [...base.cell.path, ...cell.path], text: `${base.cell.text}${cell.path.map(part => `.${part}`).join("")}` },
        nodes: [expression, alias, ...base.nodes] } : undefined;
    };
    const resolve = (expression: ts.Expression, key: boolean, seen = new Set<ts.Symbol>()): Dependency | undefined => {
      if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)) return resolve(expression.expression, key, seen);
      const input = inputOf(expression, seen);
      if (input) return { inputs: [input.cell], nodes: input.nodes, shape: keyOf(input.cell) };
      if (ts.isIdentifier(expression)) {
        const binding = checker.getSymbolAtLocation(expression), value = aliasOf(binding, seen);
        if (!binding || !value) return undefined;
        const resolved = resolve(value.initializer!, key, new Set([...seen, binding]));
        return resolved ? { ...resolved, nodes: [...resolved.nodes, value] } : undefined;
      }
      if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) || literal(expression) !== undefined || expression.kind === ts.SyntaxKind.NullKeyword) {
        const shape = literal(expression) ?? (ts.isNumericLiteral(expression) ? `number:${Number(expression.text)}` : "null");
        return { inputs: [], nodes: [expression], shape };
      }
      let parts: ts.Expression[] | undefined;
      if (ts.isTemplateExpression(expression)) parts = expression.templateSpans.map(span => span.expression);
      else if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) parts = [expression.left, expression.right];
      else if (!key && ts.isCallExpression(expression)) {
        parts = [...expression.arguments];
        if (inputOf(expression.expression, seen)) parts.push(expression.expression);
      }
      if (!parts) return undefined;
      const dependencies = parts.map(part => resolve(part, key, seen));
      if (dependencies.some(part => !part)) return undefined;
      return { inputs: dependencies.flatMap(part => part!.inputs), nodes: [expression, ...dependencies.flatMap(part => part!.nodes)],
        shape: JSON.stringify([expression.kind, ts.isTemplateExpression(expression) ? [expression.head.text, ...expression.templateSpans.map(span => span.literal.text)] : [], dependencies.map(part => part!.shape)]) };
    };
    const key = resolve(write.arguments[0], true), value = resolve(write.arguments[1], false);
    if (!key || !value?.inputs.length) continue;
    const read = calls.find(call => mapOf(call, checker) === symbol && method(call) === "get" && ownerOf(call) === owner && call.getStart() < write.getStart()
      && call.arguments.length === 1 && resolve(call.arguments[0], true)?.shape === key.shape);
    if (!read) continue;
    const lastClear = calls.filter(call => directClearBefore(call, read, symbol, snapshot)).at(-1);
    const resetGaps = lastClear ? awaitsBetween(lastClear, read, awaits) : [];
    if (lastClear && !resetGaps.length) continue;
    let deletedClear: ts.CallExpression | undefined;
    if (compared && previous) {
      const oldRead = previous.calls.find(call => mapsTo(call, read, compared.rows) && method(call) === "get"), oldSymbol = oldRead && mapOf(oldRead, compared.snapshot.checker);
      const oldDeclaration = oldSymbol && previous.maps.get(oldSymbol);
      if (oldRead && oldSymbol && oldDeclaration && !previous.assigned.has(oldSymbol) && mapsTo(oldDeclaration, declaration, compared.rows)
        && previous.calls.some(call => mapsTo(call, write, compared.rows) && mapOf(call, compared.snapshot.checker) === oldSymbol && method(call) === "set" && ownerOf(call) === ownerOf(oldRead))) {
        deletedClear = previous.calls.find(call => directClearBefore(call, oldRead, oldSymbol, compared.snapshot)
          && !awaitsBetween(call, oldRead, previous.awaits).length && removed(call, compared.rows));
      }
    }
    if (![declaration, read, write, ...key.nodes, ...value.nodes, ...resetGaps].some(node => touched(node, changed)) && !deletedClear) continue;
    const missing = [...new Map(value.inputs.filter(input => !key.inputs.some(keyInput => overlaps(input, keyInput))).map(input => [keyOf(input), input])).values()];
    if (!missing.length) continue;
    const valueNode = ts.isIdentifier(write.arguments[1]) ? checker.getSymbolAtLocation(write.arguments[1])?.valueDeclaration : write.arguments[1];
    const resetGap = resetGaps.find(node => touched(node, changed)) ?? resetGaps[0];
    signals.push(`shared Map scope: \`${short(declaration.name.getText(source))}\` (module ${lineOf(declaration)}) key read ${lineOf(read)}, write ${lineOf(write)} omits value inputs ${missing.slice(0, 3).map(input => `\`${short(input.text)}\``).join(", ")} (value ${lineOf(valueNode ?? write)}${deletedClear ? `; base clear ${lineOf(deletedClear)} removed` : ""}${lastClear && resetGap ? `; clear ${lineOf(lastClear)}, await ${lineOf(resetGap)}` : ""}); review key scope`);
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
  const rows = hunks.some(hunk => hunk.lines.some(line => line.startsWith("-"))) ? comparedBaseLines(hunks, head) : undefined;
  const previous = rows && bindBriefSource(file, rows.map(row => row.text));
  const compared = rows && previous ? { snapshot: previous, rows } : undefined;
  const previousEdges = previous ? stateEdges(previous) : [];
  const edges = stateEdges(snapshot), signals: string[] = [];
  for (const edge of edges) {
    if (signals.length >= 2) break;
    const deletedEvidence = rows && previousEdges.some(old => mapsTo(old.guard, edge.guard, rows) && mapsTo(old.write, edge.write, rows)
      && old.evidence.some(node => removed(node, rows)));
    if (![edge.guard, edge.write, ...edge.evidence].some(node => touched(node, changed)) && !deletedEvidence) continue;
    signals.push(edge.uncertain
      ? `state draft unresolved: \`${short(edge.cell.text)}\` guard ${lineOf(edge.guard)}, write ${lineOf(edge.write)}${edge.selector ? `, selector ${lineOf(edge.selector)}` : ""} (${edge.uncertain}); human review required`
      : `state draft: \`${short(edge.cell.text)}\` ${short(edge.from)} -> ${short(edge.to)} (guard ${lineOf(edge.guard)}, write ${lineOf(edge.write)}${edge.selector ? `, selector ${lineOf(edge.selector)}` : ""}); review intended transition`);
  }
  if (signals.length < 2 && rows) {
    for (const edge of previousEdges) {
      if (signals.length >= 2) break;
      if (edge.uncertain || edges.some(current => retainsEdge(edge, current, rows))) continue;
      if ([edge.guard, edge.write, ...(edge.selector ? [edge.selector] : [])].some(node => removed(node, rows))) signals.push(`state draft removed: \`${short(edge.cell.text)}\` ${short(edge.from)} -> ${short(edge.to)} (base guard ${lineOf(edge.guard)}, base write ${lineOf(edge.write)}${edge.selector ? `, base selector ${lineOf(edge.selector)}` : ""}); review replacement`);
    }
  }
  return [...signals, ...sharedMapSignals(snapshot, changed, compared)];
}
