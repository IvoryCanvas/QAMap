import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listFilesAtRef, readFileAtRef } from "./git-context.js";
import type {
  ChangeIntent,
  ChangeIntentEvidence,
  IntentQaScenario,
} from "./change-intent.js";
import type {
  AddedDiffEvidence,
  AddedDiffHunk,
  TestPlanChangedFile,
} from "./test-plan.js";

interface MigrationDependency {
  app: string;
  migration: string;
  line: number;
}

interface MigrationNode {
  appPath: string;
  appLabel: string;
  migration: string;
  file: string;
  gitPath: string;
  dependencies: MigrationDependency[];
  classLine: number;
}

interface MigrationPath {
  appPath: string;
  appLabel: string;
  migration: string;
}

interface BranchOrigin {
  node: MigrationNode;
  dependency: MigrationDependency;
}

export interface DjangoMigrationGraphConflict {
  app: string;
  changedMigration: string;
  changedFile: string;
  dependency: string;
  baseLeaves: string[];
  combinedLeaves: string[];
  intent: ChangeIntent;
}

export interface DjangoMigrationGraphAnalysis {
  conflicts: DjangoMigrationGraphConflict[];
  diagnostics: string[];
}

export interface DjangoMigrationGraphOptions {
  root: string;
  workspaceRoot?: string;
  base: string;
  head: string;
  includeWorkingTree: boolean;
  changedFiles: TestPlanChangedFile[];
  addedDiffEvidence: AddedDiffEvidence;
}

export async function analyzeDjangoMigrationGraph(
  options: DjangoMigrationGraphOptions,
): Promise<DjangoMigrationGraphAnalysis> {
  const root = path.resolve(options.root);
  const gitRoot = path.resolve(options.workspaceRoot ?? root);
  const scopePrefix = options.workspaceRoot
    ? toPosixPath(path.relative(gitRoot, root)).replace(/^\.\/+|\/+$/g, "")
    : "";
  const scopeAppLabel = path.basename(root);
  const changedMigrations = options.changedFiles
    .map((file) => ({ file, migration: parseMigrationPath(file.path, scopeAppLabel) }))
    .filter((item): item is { file: TestPlanChangedFile; migration: MigrationPath } => Boolean(item.migration));

  if (changedMigrations.length === 0 || !(await hasDjangoProjectEvidence(root, gitRoot))) {
    return { conflicts: [], diagnostics: [] };
  }

  const changedAppPaths = new Set(changedMigrations.map((item) => item.migration.appPath));
  const baseGitPaths = (await listFilesAtRef(gitRoot, options.base, scopePrefix || undefined))
    .filter((gitPath) => {
      const scoped = toScopePath(gitPath, scopePrefix);
      const migration = scoped ? parseMigrationPath(scoped, scopeAppLabel) : undefined;
      return Boolean(migration && changedAppPaths.has(migration.appPath));
    });
  const baseNodes = new Map<string, MigrationNode>();
  const unsupportedApps = new Set<string>();

  for (const gitPath of baseGitPaths) {
    const file = toScopePath(gitPath, scopePrefix);
    if (!file) {
      continue;
    }
    const content = await readFileAtRef(gitRoot, options.base, gitPath);
    const parsed = content ? parseMigrationNode(file, gitPath, content, scopeAppLabel) : undefined;
    if (!parsed) {
      const migration = parseMigrationPath(file, scopeAppLabel);
      if (migration) {
        unsupportedApps.add(migration.appPath);
      }
      continue;
    }
    baseNodes.set(nodeKey(parsed), parsed);
  }

  const combinedNodes = new Map(baseNodes);
  const changedNodes = new Map<string, MigrationNode>();
  for (const { file, migration } of changedMigrations) {
    if (file.previousPath) {
      removeNodeByFile(combinedNodes, file.previousPath);
    }
    if (file.status.startsWith("D")) {
      removeNodeByFile(combinedNodes, file.path);
      continue;
    }
    const gitPath = toGitPath(file.path, scopePrefix);
    const content = options.includeWorkingTree
      ? await readWorkingTreeFile(root, file.path)
      : await readFileAtRef(gitRoot, options.head, gitPath);
    const parsed = content ? parseMigrationNode(file.path, gitPath, content, scopeAppLabel) : undefined;
    if (!parsed) {
      unsupportedApps.add(migration.appPath);
      continue;
    }
    combinedNodes.set(nodeKey(parsed), parsed);
    changedNodes.set(nodeKey(parsed), parsed);
  }

  const conflicts: DjangoMigrationGraphConflict[] = [];
  const diagnostics: string[] = [];
  for (const appPath of [...changedAppPaths].sort()) {
    if (unsupportedApps.has(appPath)) {
      diagnostics.push(`Skipped ${appPath} migration graph because its dependency structure is dynamic or unsupported.`);
      continue;
    }
    const baseAppNodes = nodesForApp(baseNodes, appPath);
    const combinedAppNodes = nodesForApp(combinedNodes, appPath);
    const changedAppNodes = nodesForApp(changedNodes, appPath);
    if (baseAppNodes.length === 0 || changedAppNodes.length === 0) {
      continue;
    }

    const baseLeaves = graphLeaves(baseAppNodes);
    const combinedLeaves = graphLeaves(combinedAppNodes);
    if (combinedLeaves.length <= baseLeaves.length) {
      continue;
    }

    const baseNodeMap = new Map(baseAppNodes.map((node) => [nodeKey(node), node]));
    const combinedNodeMap = new Map(combinedAppNodes.map((node) => [nodeKey(node), node]));
    const baseLeafKeys = new Set(baseLeaves.map(nodeKey));
    const origins = changedAppNodes
      .map((node) => findBranchOrigin(node, combinedNodeMap, baseNodeMap, baseLeafKeys))
      .filter((origin): origin is BranchOrigin => Boolean(origin));
    const origin = origins[0];
    if (!origin) {
      continue;
    }

    const directEvidence = dependencyDiffEvidence(
      origin.node,
      origin.dependency,
      options.addedDiffEvidence[origin.node.file] ?? [],
    );
    if (!directEvidence) {
      diagnostics.push(`Skipped ${origin.node.file} because the branching dependency was not located in the diff.`);
      continue;
    }
    const baseLeafEvidence = baseLeaves.map((leaf) => sourceEvidenceForLeaf(leaf));
    const intent = buildMigrationGraphIntent(
      origin,
      baseLeaves,
      combinedLeaves,
      directEvidence,
      baseLeafEvidence,
    );
    conflicts.push({
      app: origin.node.appLabel,
      changedMigration: origin.node.migration,
      changedFile: origin.node.file,
      dependency: origin.dependency.migration,
      baseLeaves: baseLeaves.map((leaf) => leaf.migration),
      combinedLeaves: combinedLeaves.map((leaf) => leaf.migration),
      intent,
    });
  }

  return { conflicts, diagnostics };
}

function buildMigrationGraphIntent(
  origin: BranchOrigin,
  baseLeaves: MigrationNode[],
  combinedLeaves: MigrationNode[],
  directEvidence: ChangeIntentEvidence,
  baseLeafEvidence: ChangeIntentEvidence[],
): ChangeIntent {
  const app = origin.node.appLabel;
  const evidence = [directEvidence, ...baseLeafEvidence];
  const id = stableId("migration-graph", app, origin.node.file, origin.dependency.migration);
  const leafSummary = combinedLeaves.map((leaf) => `${leaf.appLabel}.${leaf.migration}`).join(", ");
  const baseLeafSummary = baseLeaves.map((leaf) => `${leaf.appLabel}.${leaf.migration}`).join(", ");
  const scenario: IntentQaScenario = {
    id: stableId(id, "single-leaf"),
    kind: "primary",
    priority: "critical",
    title: `${app} migration graph keeps one deployable leaf`,
    rationale:
      `The target branch ends at ${baseLeafSummary}, but the changed dependency branches from ` +
      `${app}.${origin.dependency.migration}; merging would leave ${leafSummary} as competing leaves.`,
    setup: [
      "Compare the target branch migration graph with the changed migration dependencies without importing project code.",
    ],
    steps: [
      `Inspect ${origin.node.file} and the target branch leaf ${baseLeaves[0]?.file ?? baseLeafSummary}.`,
      "Rebase the changed migration onto the current leaf or add a reviewed merge migration that reconnects every leaf.",
      "Run the repository's declared migration graph or deployment-plan validation before merge.",
    ],
    assertions: [
      `Verify the combined ${app} migration graph has exactly one leaf.`,
      "Verify migration ordering is unambiguous before deployment.",
    ],
    edgeCases: [
      "A reviewed merge migration depends on every competing leaf.",
      "Squashed or dynamically declared dependencies require manual graph review.",
    ],
    evidence,
    confidence: "high",
    reviewRequired: false,
  };

  return {
    id,
    title: `Resolve divergent ${app} migration graph leaves`,
    summary:
      `The target branch has ${baseLeaves.length} ${app} migration leaf, while the proposed merge has ` +
      `${combinedLeaves.length}: ${leafSummary}.`,
    confidence: "high",
    commits: [],
    files: [origin.node.file],
    keywords: [app, "migration", "graph", "leaf", "deployment"],
    evidence,
    lifecycle: [
      {
        id: stableId(id, "trigger"),
        kind: "trigger",
        label: "Combine the changed migration with the target branch migration graph",
        confidence: "high",
        evidence: [directEvidence],
        files: [origin.node.file],
      },
      {
        id: stableId(id, "condition"),
        kind: "condition",
        label: `${origin.node.migration} depends on non-leaf ${origin.dependency.migration}`,
        confidence: "high",
        evidence: [directEvidence, ...baseLeafEvidence],
        files: [origin.node.file],
      },
      {
        id: stableId(id, "outcome"),
        kind: "observable-outcome",
        label: "The combined migration graph has one unambiguous deployable leaf",
        confidence: "high",
        evidence,
        files: [origin.node.file],
      },
    ],
    scenarios: [scenario],
    reviewRequired: false,
  };
}

function dependencyDiffEvidence(
  node: MigrationNode,
  dependency: MigrationDependency,
  hunks: AddedDiffHunk[],
): ChangeIntentEvidence | undefined {
  for (const hunk of hunks) {
    const line = hunk.lines.find((item) => item.line === dependency.line) ??
      hunk.lines.find((item) => item.text.includes(dependency.app) && item.text.includes(dependency.migration));
    if (!line) {
      continue;
    }
    return {
      kind: "diff",
      value: `Changed migration ${node.appLabel}.${node.migration} depends on non-leaf ${dependency.app}.${dependency.migration}.`,
      sourceRole: "configuration",
      file: node.file,
      relation: "direct",
      side: "head",
      startLine: line.line,
      endLine: line.line,
      hunkHeader: hunk.hunkHeader,
    };
  }
  return undefined;
}

function sourceEvidenceForLeaf(node: MigrationNode): ChangeIntentEvidence {
  return {
    kind: "source",
    value: `Target branch migration leaf is ${node.appLabel}.${node.migration}.`,
    sourceRole: "configuration",
    file: node.file,
    relation: "supporting",
    side: "base",
    startLine: node.classLine,
    endLine: node.classLine,
  };
}

function findBranchOrigin(
  start: MigrationNode,
  combined: Map<string, MigrationNode>,
  base: Map<string, MigrationNode>,
  baseLeafKeys: Set<string>,
  visited = new Set<string>(),
): BranchOrigin | undefined {
  const key = nodeKey(start);
  if (visited.has(key)) {
    return undefined;
  }
  visited.add(key);
  for (const dependency of start.dependencies) {
    if (dependency.app !== start.appLabel) {
      continue;
    }
    const dependencyKey = `${start.appPath}:${dependency.migration}`;
    if (base.has(dependencyKey)) {
      if (!baseLeafKeys.has(dependencyKey)) {
        return { node: start, dependency };
      }
      continue;
    }
    const dependencyNode = combined.get(dependencyKey);
    if (dependencyNode) {
      const nested = findBranchOrigin(dependencyNode, combined, base, baseLeafKeys, visited);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function graphLeaves(nodes: MigrationNode[]): MigrationNode[] {
  const byKey = new Map(nodes.map((node) => [nodeKey(node), node]));
  const referenced = new Set<string>();
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (dependency.app !== node.appLabel) {
        continue;
      }
      const key = `${node.appPath}:${dependency.migration}`;
      if (byKey.has(key)) {
        referenced.add(key);
      }
    }
  }
  return nodes
    .filter((node) => !referenced.has(nodeKey(node)))
    .sort((left, right) => left.migration.localeCompare(right.migration));
}

function parseMigrationNode(
  file: string,
  gitPath: string,
  content: string,
  scopeAppLabel: string,
): MigrationNode | undefined {
  const migration = parseMigrationPath(file, scopeAppLabel);
  if (!migration || !/\bclass\s+Migration\s*\([^)]*migrations\.Migration[^)]*\)\s*:/s.test(content)) {
    return undefined;
  }
  if (/\breplaces\s*=/.test(content)) {
    return undefined;
  }
  const block = assignmentList(content, "dependencies");
  if (!block) {
    return undefined;
  }
  const dependencies: MigrationDependency[] = [];
  const tuplePattern = /\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*,?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = tuplePattern.exec(block.text)) !== null) {
    dependencies.push({
      app: match[2],
      migration: match[4],
      line: lineNumberAt(content, block.start + match.index),
    });
  }
  const residual = block.text
    .replace(tuplePattern, "")
    .replace(/#[^\n]*/g, "")
    .replace(/[\s,]/g, "");
  if (residual.length > 0) {
    return undefined;
  }
  const classIndex = content.search(/\bclass\s+Migration\b/);
  return {
    ...migration,
    file,
    gitPath,
    dependencies,
    classLine: classIndex >= 0 ? lineNumberAt(content, classIndex) : 1,
  };
}

function assignmentList(content: string, name: string): { text: string; start: number } | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*\\[`).exec(content);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const open = content.indexOf("[", match.index);
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = open; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return { text: content.slice(open + 1, index), start: open + 1 };
      }
    }
  }
  return undefined;
}

function parseMigrationPath(fileInput: string, scopeAppLabel?: string): MigrationPath | undefined {
  const file = toPosixPath(fileInput).replace(/^\.\/+/, "");
  const match = file.match(/^(.*)\/migrations\/([0-9]{4}_[^/]+)\.py$/);
  const scopedMatch = file.match(/^migrations\/([0-9]{4}_[^/]+)\.py$/);
  if (!match && !scopedMatch) {
    return undefined;
  }
  const appPath = match?.[1] ?? ".";
  return {
    appPath,
    appLabel: match ? path.posix.basename(match[1]) : (scopeAppLabel ?? "app"),
    migration: match?.[2] ?? scopedMatch?.[1] ?? "",
  };
}

function nodesForApp(nodes: Map<string, MigrationNode>, appPath: string): MigrationNode[] {
  return [...nodes.values()]
    .filter((node) => node.appPath === appPath)
    .sort((left, right) => left.migration.localeCompare(right.migration));
}

function removeNodeByFile(nodes: Map<string, MigrationNode>, file: string): void {
  for (const [key, node] of nodes) {
    if (node.file === file) {
      nodes.delete(key);
    }
  }
}

function nodeKey(node: Pick<MigrationNode, "appPath" | "migration">): string {
  return `${node.appPath}:${node.migration}`;
}

async function hasDjangoProjectEvidence(root: string, gitRoot: string): Promise<boolean> {
  const roots = [...new Set([root, gitRoot])];
  for (const candidateRoot of roots) {
    if (await fileExists(path.join(candidateRoot, "manage.py"))) {
      return true;
    }
    for (const file of ["requirements.txt", "pyproject.toml", "Pipfile", "setup.cfg"]) {
      try {
        if (/\bdjango\b/i.test(await fs.readFile(path.join(candidateRoot, file), "utf8"))) {
          return true;
        }
      } catch {
        // Missing or unreadable project markers are not evidence.
      }
    }
  }
  return false;
}

async function readWorkingTreeFile(root: string, file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(root, file), "utf8");
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toScopePath(gitPath: string, scopePrefix: string): string | undefined {
  const normalized = toPosixPath(gitPath).replace(/^\.\/+/, "");
  if (!scopePrefix) {
    return normalized;
  }
  const prefix = `${scopePrefix}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}

function toGitPath(file: string, scopePrefix: string): string {
  return scopePrefix ? `${scopePrefix}/${toPosixPath(file)}` : toPosixPath(file);
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
