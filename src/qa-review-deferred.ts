import ts from "typescript";
import type { BriefSnapshot } from "./qa-brief-syntax.js";

interface StateField { receiver: ts.Symbol; name: string }

function assignment(statement: ts.Statement | undefined): ts.BinaryExpression | undefined {
  if (!statement || !ts.isExpressionStatement(statement)) return undefined;
  const expression = statement.expression;
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? expression : undefined;
}

function functionScope(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return parent;
  }
  return undefined;
}

function constant(declaration: ts.Node | undefined): declaration is ts.VariableDeclaration {
  return !!declaration && ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const);
}

function stateField(checker: ts.TypeChecker, expression: ts.Expression): StateField | undefined {
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && !expression.questionDotToken) {
    const receiver = checker.getSymbolAtLocation(expression.expression);
    if (receiver) return { receiver, name: expression.name.text };
  }
  return undefined;
}

function guardField(checker: ts.TypeChecker, expression: ts.Expression): StateField | undefined {
  if (!ts.isIdentifier(expression)) return stateField(checker, expression);
  const binding = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (!binding || !ts.isBindingElement(binding) || binding.initializer || binding.dotDotDotToken
    || !ts.isObjectBindingPattern(binding.parent) || !constant(binding.parent.parent)) return undefined;
  const receiver = binding.parent.parent.initializer;
  const name = binding.propertyName ?? binding.name;
  if (receiver && ts.isIdentifier(receiver) && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
    const symbol = checker.getSymbolAtLocation(receiver);
    if (symbol) return { receiver: symbol, name: name.text };
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function sameField(field: StateField | undefined, expected: StateField): boolean {
  return field?.receiver === expected.receiver && field.name === expected.name;
}

// Follow only boolean forms that make the state value necessary on the chosen arm.
function requiresField(checker: ts.TypeChecker, condition: ts.Expression, arm: boolean, field: StateField, value: boolean): boolean {
  const expression = unwrap(condition);
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return requiresField(checker, expression.operand, !arm, field, value);
  }
  const necessary = arm ? ts.SyntaxKind.AmpersandAmpersandToken : ts.SyntaxKind.BarBarToken;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === necessary) {
    return requiresField(checker, expression.left, arm, field, value)
      || requiresField(checker, expression.right, arm, field, value);
  }
  return arm === value && sameField(guardField(checker, expression), field);
}

function earlyReturn(statement: ts.Statement): statement is ts.IfStatement {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const body = statement.thenStatement;
  return ts.isBlock(body) ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!)
    : ts.isReturnStatement(body);
}

function existingGuard(checker: ts.TypeChecker, call: ts.CallExpression, pending: StateField, companion: StateField):
  ts.IfStatement | undefined {
  let companionGuard: ts.IfStatement | undefined;
  for (let child: ts.Node = call, parent = call.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent)) {
      const inThen = child === parent.thenStatement;
      if (inThen || child === parent.elseStatement) {
        if (requiresField(checker, parent.expression, inThen, pending, false)) return undefined;
        if (requiresField(checker, parent.expression, inThen, companion, true)) companionGuard ??= parent;
      }
    }
    if (ts.isBlock(parent)) {
      for (const statement of parent.statements) {
        if (statement === child) break;
        if (earlyReturn(statement) && requiresField(checker, statement.expression, false, pending, false)) return undefined;
      }
    }
  }
  return companionGuard;
}

function callbackBody(checker: ts.TypeChecker, expression: ts.Expression): ts.Block | undefined {
  if (!ts.isIdentifier(expression)) return undefined;
  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (declaration && ts.isFunctionDeclaration(declaration)) return declaration.body;
  if (!constant(declaration)) return undefined;
  const callback = declaration.initializer;
  if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) {
    return callback.body;
  }
  return undefined;
}

function updateHelper(checker: ts.TypeChecker, statement: ts.Statement, receiver: ts.Symbol):
  { symbol: ts.Symbol; write: ts.BinaryExpression } | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return undefined;
  const { expression, arguments: [first] } = statement.expression;
  if (!first || !ts.isIdentifier(expression) || !ts.isIdentifier(first)
    || checker.getSymbolAtLocation(first) !== receiver) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  const helper = symbol?.valueDeclaration;
  if (!symbol || !helper || !ts.isFunctionDeclaration(helper) || !helper.body) return undefined;
  const parameter = helper.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name)) return undefined;
  const object = checker.getSymbolAtLocation(parameter.name);
  for (const item of helper.body.statements) {
    const write = assignment(item);
    const target = write && stateField(checker, write.left);
    if (write && target && target.receiver === object) return { symbol, write };
  }
  return undefined;
}

export interface DeferredUpdate {
  pending: string;
  companion: string;
  helper: string;
  opened: number;
  registered: number;
  write: number;
  consumers: Array<{ guard: number; call: number }>;
}

/** Connect new callback state to unchanged writes through the same local helper. */
export function deferredUpdate(snapshot: BriefSnapshot, added: Set<number>, unchanged: Set<number>): DeferredUpdate | undefined {
  const { source, checker } = snapshot;
  const line = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visitedCalls = new Map<ts.Symbol, ts.CallExpression[]>();
  const openings: ts.Block[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) && node.statements.some(statement => {
      const write = assignment(statement);
      return write?.right.kind === ts.SyntaxKind.TrueKeyword && added.has(line(write));
    })) openings.push(node);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && unchanged.has(line(node))) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol) {
        const calls = visitedCalls.get(symbol);
        if (calls) calls.push(node);
        else visitedCalls.set(symbol, [node]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  for (const block of openings) {
    const scope = functionScope(block);
    if (!scope) continue;
    for (const [index, statement] of block.statements.entries()) {
      const open = assignment(statement);
      if (!open || open.right.kind !== ts.SyntaxKind.TrueKeyword || !added.has(line(open))) continue;
      const pending = stateField(checker, open.left);
      const register = assignment(block.statements[index + 1]);
      if (!pending || !register || !ts.isPropertyAccessExpression(register.left)) continue;
      const body = callbackBody(checker, register.right);
      if (!body || body.pos >= register.pos || functionScope(body.parent) !== scope) continue;

      const [first, guard, ...rest] = body.statements;
      const close = assignment(first);
      if (!close || close.right.kind !== ts.SyntaxKind.FalseKeyword || !added.has(line(close))
        || !sameField(stateField(checker, close.left), pending) || !guard || !earlyReturn(guard)) continue;
      const condition = unwrap(guard.expression);
      if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) continue;
      const companion = stateField(checker, unwrap(condition.operand));
      if (!companion || companion.receiver !== pending.receiver || companion.name === pending.name) continue;

      for (const callbackStatement of rest) {
        const helper = updateHelper(checker, callbackStatement, pending.receiver);
        if (!helper || !unchanged.has(line(helper.write))) continue;
        const consumers: DeferredUpdate["consumers"] = [];
        for (const call of visitedCalls.get(helper.symbol) ?? []) {
          const receiver = call.arguments[0];
          const caller = functionScope(call);
          if (!caller || caller === scope || caller === body.parent || !receiver || !ts.isIdentifier(receiver)) continue;
          const symbol = checker.getSymbolAtLocation(receiver);
          if (!symbol) continue;
          const guard = existingGuard(checker, call, { ...pending, receiver: symbol }, { ...companion, receiver: symbol });
          if (!guard || !unchanged.has(line(guard))) continue;
          consumers.push({ guard: line(guard), call: line(call) });
          if (consumers.length === 2) break;
        }
        if (consumers.length) {
          return { pending: pending.name, companion: companion.name, helper: helper.symbol.name,
            opened: line(open), registered: line(register), write: line(helper.write), consumers };
        }
      }
    }
  }
  return undefined;
}
