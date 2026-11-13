import ts from "typescript";
import { bindBriefSource, comparedBaseLines, type BriefHunk } from "./qa-brief-syntax.js";

export interface ReviewQuestionDraft { key: string[]; observation: string; question: string; next: string }
interface Exit { key: string; line: number; text: string; kind: "return" | "throw" }
const excerpt = (value: string): string => Array.from(value).length > 140 ? `${Array.from(value).slice(0, 137).join("")}...` : value;

// Only named lexical owners establish identity; do not equate unrelated callbacks.
function owner(node: ts.Node): string | undefined {
  const names: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      const name = (parent as ts.FunctionDeclaration).name;
      if (name) names.unshift(name.getText());
      else if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
        && ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) names.unshift(parent.parent.name.text);
      else return undefined;
    } else if (ts.isClassDeclaration(parent)) {
      if (!parent.name) return undefined;
      names.unshift(parent.name.text);
    }
  }
  return JSON.stringify(names);
}

function exits(source: ts.SourceFile): { guards: Exit[]; throws: Exit[] } {
  const guards: Exit[] = [], throws: Exit[] = [];
  const printer = ts.createPrinter({ removeComments: true });
  const text = (node: ts.Node): string => printer.printNode(ts.EmitHint.Unspecified, node, source).trim();
  const visit = (node: ts.Node): void => {
    const scope = ts.isIfStatement(node) || ts.isThrowStatement(node) ? owner(node) : undefined;
    if (scope !== undefined && ts.isIfStatement(node)) {
      const last = ts.isBlock(node.thenStatement) ? node.thenStatement.statements.at(-1) : node.thenStatement;
      if (last && (ts.isReturnStatement(last) || ts.isThrowStatement(last))) {
        const kind = ts.isReturnStatement(last) ? "return" : "throw";
        guards.push({ key: JSON.stringify([scope, text(node.expression), kind]),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          text: text(node.expression), kind });
      }
    }
    if (scope !== undefined && ts.isThrowStatement(node)) {
      throws.push({ key: JSON.stringify([scope, text(node)]),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: text(node), kind: "throw" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { guards, throws };
}

function unmatched(previous: Exit[], current: Exit[]): Exit[] {
  const counts = new Map<string, number>();
  for (const item of current) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  return previous.filter(item => {
    const count = counts.get(item.key) ?? 0;
    if (count) { counts.set(item.key, count - 1); return false; }
    return true;
  });
}

/** Bounded syntax evidence, not product requirements or control-flow proof. */
export function controlFlowQuestions(file: string, hunks: Array<BriefHunk & { oldStart: number }>, head: string[]): ReviewQuestionDraft[] {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
  if (!hunks.some(hunk => hunk.lines.some(line => /^[+-]/.test(line) && /\b(?:if|throw)\b/.test(line)))) return [];
  const removed = new Set<number>(), added = new Set<number>();
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("-")) removed.add(oldLine++);
      else if (line.startsWith("+")) added.add(newLine++);
      else { oldLine++; newLine++; }
    }
  }
  if (!removed.size && !added.size) return [];
  const base = comparedBaseLines(hunks, head);
  if (!base) return [];
  const before = bindBriefSource(file, base.map(row => row.text)), after = bindBriefSource(file, head);
  if (!before || !after) return [];
  const oldExits = exits(before.source), newExits = exits(after.source);
  const questions: ReviewQuestionDraft[] = [];
  for (const guard of unmatched(oldExits.guards, newExits.guards).filter(item => removed.has(item.line))) {
    questions.push({ key: ["changed-exit-guard", file, guard.key],
      observation: `Base guard at ${file}:${guard.line} (base): if (${excerpt(guard.text)}); its branch ended in ${guard.kind}. This condition was removed or rewritten.`,
      question: `Should inputs matching this base guard still ${guard.kind === "return" ? "return" : "raise an error"} before the remaining work?`,
      next: "Find the reviewed policy for these inputs; record its source and input -> expected result before proposing a check. Tests remain not-run.",
    });
  }
  for (const item of unmatched(newExits.throws, oldExits.throws).filter(item => added.has(item.line))) {
    questions.push({ key: ["new-throw", file, item.key], observation: `Added throw at ${file}:${item.line} (head): ${excerpt(item.text)}`,
      question: "Which caller-visible outcome is intended for this new error path?",
      next: "Read the callers and their error handling, then record the reviewed outcome and policy source. Existing assertions are unexecuted evidence.",
    });
  }
  return questions.slice(0, 2);
}
