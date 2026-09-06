import { isInstructionLikeRepositoryText } from "./qa-contract.js";
import type { AddedDiffEvidence } from "./test-plan.js";
import type { ChangedTestContract } from "./test-evidence.js";

export interface LifecycleFact {
  kind: "condition" | "action" | "state-change" | "observable-outcome";
  text: string;
  line: number;
  label: string;
}

export interface LifecycleTestContract extends ChangedTestContract {
  body?: { facts: LifecycleFact[]; assertionLine: number };
}

export interface SourceLifecycleContract {
  file: string;
  line: number;
  title: string;
  facts: LifecycleFact[];
  missing: string[];
}

export function connectTestLifecycleBodies(
  contracts: ChangedTestContract[],
  evidence: AddedDiffEvidence,
): LifecycleTestContract[] {
  return contracts.map((contract) => {
    if (!contract.assertion) return contract;
    const lines = (evidence[contract.file] ?? []).flatMap((hunk) => hunk.lines);
    const start = lines.findIndex((line) => line.line === contract.line);
    if (start < 0) return contract;
    const indentation = indent(lines[start].text);
    const facts: LifecycleFact[] = [];
    let previous = contract.line;
    for (const line of lines.slice(start + 1, start + 7)) {
      // A missing line can hide a scope boundary or fixture dependency.
      if (line.line !== previous + 1 || indent(line.text) <= indentation) break;
      previous = line.line;
      const text = line.text.trim().replace(/;$/, "");
      if (normalize(text.replace(/^await\s+/, "")) === normalize(contract.assertion)) {
        return facts.length > 0 ? { ...contract, body: { facts, assertionLine: line.line } } : contract;
      }
      if (!text || /^(?:\/\/|#)/.test(text)) continue;
      if (!completeStatement(text) || /\b(?:function|if|unless|until|for|while|do|case|when|begin|rescue|ensure|else|elsif|end|switch|try|catch)\b|=>\s*\{|\/\*|\*\//.test(codeMask(text))) break;
      const kind = testFactKind(contract.framework, text);
      if (kind && !isInstructionLikeRepositoryText(text)) {
        facts.push({ kind, text, line: line.line, label: factLabel(kind, text) });
      }
    }
    return contract;
  });
}

function testFactKind(framework: ChangedTestContract["framework"], text: string): LifecycleFact["kind"] | undefined {
  const call = text.replace(/^await\s+/, "");
  if (framework === "javascript") {
    if (/^(?:render|mount)\s*\(/.test(call) || /^(?:const|let)\s+\w+\s*=\s*(?:screen|page)\.getBy\w+\(/.test(call)) return "condition";
    if (/^(?:user|userEvent|fireEvent)\.(?:type|paste|click|dblClick|change|input|blur|focus|clear|keyboard|selectOptions)\(/.test(call) ||
      /^page\.(?:goto|click|fill|press|check|uncheck|selectOption)\(/.test(call) ||
      /^page\.(?:getBy\w+|locator)\(.+\)\.(?:click|fill|press|check|uncheck)\(/.test(call)) return "action";
  }
  if (framework === "dart") {
    if (/^tester\.pumpWidget\(/.test(call)) return "condition";
    if (/^tester\.(?:tap|enterText|drag|fling|longPress)\(/.test(call)) return "action";
    if (/^tester\.(?:pump|pumpAndSettle)\(/.test(call)) return "action";
  }
  if (framework === "minitest") {
    if (/^\w+\s*=\s*\{.*\}$/.test(call)) return "condition";
    if (/^(?:(?:\w+\s*=\s*)?\w+\.call\(|(?:get|post|patch|put|delete|visit|click_on|fill_in)\s)/.test(call)) return "action";
  }
  return undefined;
}

function factLabel(kind: LifecycleFact["kind"], text: string): string {
  if (kind === "condition") return `Use repository setup \`${text}\`.`;
  if (/^(?:await\s+)?tester\.(?:pump|pumpAndSettle)\(/.test(text)) return `Wait using repository synchronization \`${text}\`.`;
  if (kind === "state-change") return `Apply repository transition \`${text}\`.`;
  return `Perform repository action \`${text}\`.`;
}

export function collectSourceLifecycleContracts(
  sources: Record<string, string>,
  evidence: AddedDiffEvidence,
): SourceLifecycleContract[] {
  const contracts: SourceLifecycleContract[] = [];
  for (const [file, source] of Object.entries(sources).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (!/\.[jt]sx$/.test(file)) continue;
    const changed = new Set((evidence[file] ?? []).flatMap((hunk) => hunk.lines.map((line) => line.line)));
    if (changed.size === 0) continue;
    const lines = source.split(/\r?\n/);
    const masked = codeMask(source).split(/\r?\n/);
    for (const scope of componentScopes(lines, masked)) {
      const direct = scope.lines.filter((line) => lines[line].trim().length <= 240);
      const hooksByState = new Map<string, { line: number; setter: string; initial: string }[]>();
      const actionsByTransition = new Map<string, { line: number; label: string; call: string }[]>();
      // Index the component once instead of re-reading it for every outcome.
      for (const line of direct) {
        const text = lines[line].trim();
        if (isInstructionLikeRepositoryText(text)) continue;
        const hook = text.match(/^const\s+\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*(?:React\.)?useState(?:<[^>]+>)?\((["'])([^"'\\]*)\3\);?$/);
        if (hook) {
          const entries = hooksByState.get(hook[1]) ?? [];
          entries.push({ line, setter: hook[2], initial: hook[4] });
          hooksByState.set(hook[1], entries);
        }
        const action = text.match(/^<button\s+onClick=\{\(\)\s*=>\s*(\w+)\((["'])([^"'\\]+)\2\)\}>\s*([^<>{}]+)\s*<\/button>$/);
        if (action) {
          const key = `${action[1]}:${action[3]}`;
          const entries = actionsByTransition.get(key) ?? [];
          entries.push({ line, label: action[4].trim(), call: `${action[1]}(${action[2]}${action[3]}${action[2]})` });
          actionsByTransition.set(key, entries);
        }
      }
      for (const index of direct) {
        const match = lines[index].trim().match(/^\{\s*([A-Za-z_$][\w$]*)\s*===\s*(["'])([^"'\\]+)\2\s*&&\s*<([a-z][\w-]*)(?:\s+[^>{}]*)?>\s*([^<>{}]+)\s*<\/\4>\s*\}$/);
        if (!match || isInstructionLikeRepositoryText(lines[index])) continue;
        const [, state, , value, , copy] = match;
        const hooks = hooksByState.get(state) ?? [];
        const hook = hooks.length === 1 ? hooks[0] : undefined;
        const actions = hook ? actionsByTransition.get(`${hook.setter}:${value}`) ?? [] : [];
        const proofLines = [index, ...(hook ? [hook.line] : []), ...actions.map((action) => action.line)];
        if (!proofLines.some((line) => changed.has(line + 1))) continue;
        const condition = `${state} === ${match[2]}${value}${match[2]}`;
        const facts: LifecycleFact[] = [{
          kind: "observable-outcome", text: lines[index].trim(), line: index + 1,
          label: `When \`${condition}\`, observe ${copy.trim()}.`,
        }];
        if (hook) facts.unshift({
          kind: "condition", text: lines[hook.line].trim(), line: hook.line + 1,
          label: `Use the declared initial ${state} state \`${hook.initial}\`.`,
        });
        if (actions.length === 1) {
          const action = actions[0];
          facts.splice(facts.length - 1, 0,
            { kind: "action", text: lines[action.line].trim(), line: action.line + 1, label: `Activate button ${JSON.stringify(action.label)} (onClick).` },
            { kind: "state-change", text: lines[action.line].trim(), line: action.line + 1, label: `Apply repository transition \`${action.call}\`.` },
          );
        }
        const missing = [
          ...(!hook ? ["Missing repository evidence: initial fixture state."] : []),
          ...(actions.length !== 1 ? [actions.length > 1
            ? "Ambiguous repository action: multiple controls reach this state; a person must choose the scenario."
            : "Missing repository evidence: action and state transition reaching this condition."] : []),
        ];
        contracts.push({ file, line: index + 1, title: `${scope.name}: ${condition}`, facts, missing });
        if (contracts.length >= 24) return contracts;
      }
    }
  }
  return contracts;
}

function componentScopes(lines: string[], masked: string[]): { name: string; lines: number[] }[] {
  const scopes: { name: string; lines: number[] }[] = [];
  let depth = 0;
  let active: { name: string; lines: number[] } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const code = masked[index];
    if (depth === 0) {
      const declaration = code.match(/^\s*(?:export\s+(?:default\s+)?)?(?:function\s+([A-Z]\w*)\s*\([^)]*\)|const\s+([A-Z]\w*)\s*=\s*\([^)]*\)\s*=>)\s*\{\s*$/);
      active = declaration ? { name: declaration[1] ?? declaration[2], lines: [] } : undefined;
    } else if (depth === 1 && active && code.trim()) {
      active.lines.push(index);
    }
    for (const character of code) {
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }
    if (depth === 0 && active) {
      scopes.push(active);
      active = undefined;
    }
    if (depth < 0) break;
  }
  return scopes;
}

function completeStatement(text: string): boolean {
  if (text.length > 240 || text.includes("/*") || text.includes("*/") || text.includes("`")) return false;
  const mask = codeMask(text);
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const character of mask) {
    if ("([{".includes(character)) stack.push(character);
    if (pairs[character] && stack.pop() !== pairs[character]) return false;
  }
  return stack.length === 0;
}

// Preserve offsets while removing comments and quoted payloads from structural
// matching. Template interpolation is deliberately unsupported, not evaluated.
function codeMask(text: string): string {
  let quote = "";
  let block = false;
  let lineComment = false;
  let escaped = false;
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === "\n") {
      lineComment = false;
      result += character;
      continue;
    }
    if (lineComment) { result += " "; continue; }
    if (block) {
      if (character === "*" && next === "/") { block = false; index += 1; result += "  "; }
      else result += " ";
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      result += " ";
      continue;
    }
    if (character === "/" && next === "*") { block = true; index += 1; result += "  "; }
    else if (character === "/" && next === "/") { lineComment = true; index += 1; result += "  "; }
    else if (character === "'" || character === '"' || character === "`") { quote = character; result += " "; }
    else result += character;
  }
  return result;
}

function indent(text: string): number { return text.match(/^\s*/)?.[0].length ?? 0; }
function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }
