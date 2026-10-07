import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectFile } from "./types.js";

const ignoredDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".dart_tool",
  ".worktree",
  ".worktrees",
  ".pub-cache",
  "vendor",
  // Mobile vendor/derived trees: on React Native and Expo repos these hold
  // tens of thousands of files and, because the walk is alphabetical and
  // capped, they can starve the scan before it ever reaches src/.
  "Pods",
  ".expo",
  ".gradle",
  "DerivedData",
  "Carthage",
]);

const textExtensions = new Set([
  ".bash",
  ".cjs",
  ".conf",
  ".cts",
  ".dart",
  ".env",
  ".go",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mdc",
  ".mjs",
  ".mts",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".svelte",
  ".yaml",
  ".yml",
  ".zsh",
]);

const textBasenames = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "Dockerfile",
  "Makefile",
  "setup.cfg",
]);

const maxReadableBytes = 256 * 1024;

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

interface ProjectWalk<T> {
  maxFiles: number;
  items: Promise<T[]>;
}

interface ProjectScanMemo {
  files: Map<string, ProjectWalk<ProjectFile>>;
  paths: Map<string, ProjectWalk<string>>;
  values: Map<string, Promise<unknown>>;
}

const projectScanMemo = new AsyncLocalStorage<ProjectScanMemo>();

// Scans are shared only inside one analysis run, so a caller that edits the
// tree between runs never receives a stale inventory or import graph.
export function withProjectScanMemo<T>(run: () => Promise<T>): Promise<T> {
  if (projectScanMemo.getStore()) {
    return run();
  }
  return projectScanMemo.run({ files: new Map(), paths: new Map(), values: new Map() }, run);
}

export function memoizeProjectScan<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const memo = projectScanMemo.getStore();
  if (!memo) {
    return compute();
  }
  const cached = memo.values.get(key) as Promise<T> | undefined;
  if (cached) {
    return cached;
  }
  const value = compute();
  memo.values.set(key, value);
  value.catch(() => {
    if (memo.values.get(key) === value) memo.values.delete(key);
  });
  return value;
}

// The walk is a sorted depth-first prefix that stops at maxFiles, so a larger
// walk, or one that ended before its own limit, already holds every smaller answer.
async function reuseWalk<T>(walk: ProjectWalk<T> | undefined, maxFiles: number): Promise<T[] | undefined> {
  const items = await walk?.items.catch(() => undefined);
  return walk && items && (maxFiles <= walk.maxFiles || items.length < walk.maxFiles) ? items.slice(0, maxFiles) : undefined;
}

async function memoizedWalk<T>(walks: Map<string, ProjectWalk<T>>, key: string, maxFiles: number, walk: () => Promise<T[]>): Promise<T[]> {
  const reused = await reuseWalk(walks.get(key), maxFiles);
  if (reused) {
    return reused;
  }
  const entry = { maxFiles, items: walk() };
  const current = walks.get(key);
  if (!current || maxFiles > current.maxFiles) {
    walks.set(key, entry);
  }
  entry.items.catch(() => {
    if (walks.get(key) === entry) walks.delete(key);
  });
  return entry.items;
}

export async function collectProjectFiles(root: string, maxFiles: number): Promise<ProjectFile[]> {
  const memo = projectScanMemo.getStore();
  if (!memo || !Number.isSafeInteger(maxFiles) || maxFiles < 0) {
    return walkProjectFiles(root, maxFiles, true);
  }
  // Callers receive their own records, so filtering or annotating one never leaks into another.
  const files = await memoizedWalk(memo.files, path.resolve(root), maxFiles, () => walkProjectFiles(root, maxFiles, true));
  return files.map((file) => ({ ...file }));
}

// Same order and limit as collectProjectFiles, without stat calls or text reads.
export async function collectProjectFilePaths(root: string, maxFiles: number): Promise<string[]> {
  const memo = projectScanMemo.getStore();
  if (!memo || !Number.isSafeInteger(maxFiles) || maxFiles < 0) {
    return (await walkProjectFiles(root, maxFiles, false)).map((file) => file.path);
  }
  const key = path.resolve(root);
  const files = await reuseWalk(memo.files.get(key), maxFiles);
  if (files) {
    return files.map((file) => file.path);
  }
  const paths = await memoizedWalk(memo.paths, key, maxFiles,
    async () => (await walkProjectFiles(root, maxFiles, false)).map((file) => file.path));
  return [...paths];
}

async function walkProjectFiles(root: string, maxFiles: number, withContents: boolean): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  const normalizedRoot = path.resolve(root);

  async function walk(directory: string): Promise<void> {
    if (files.length >= maxFiles) {
      return;
    }

    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (
      directory !== normalizedRoot &&
      entries.some((entry) => entry.name === ".git" && (entry.isFile() || entry.isDirectory()))
    ) {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }

      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosixPath(path.relative(normalizedRoot, absolutePath));

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!withContents) {
        files.push({ path: relativePath, absolutePath, size: 0 });
        continue;
      }

      const stat = await fs.stat(absolutePath);
      const file: ProjectFile = {
        path: relativePath,
        absolutePath,
        size: stat.size,
      };

      if (shouldReadTextFile(relativePath, stat.size)) {
        file.text = await fs.readFile(absolutePath, "utf8");
      }

      files.push(file);
    }
  }

  await walk(normalizedRoot);
  return files;
}

export function shouldReadTextFile(relativePath: string, size: number): boolean {
  if (size > maxReadableBytes) {
    return false;
  }

  const basename = path.basename(relativePath);
  if (textBasenames.has(basename)) {
    return true;
  }

  if (basename.startsWith(".env") && basename !== ".env.example") {
    return false;
  }

  return textExtensions.has(path.extname(relativePath));
}

export function getFile(files: ProjectFile[], relativePath: string): ProjectFile | undefined {
  return files.find((file) => file.path === relativePath);
}

export function getFilesUnder(files: ProjectFile[], directory: string): ProjectFile[] {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return files.filter((file) => file.path.startsWith(prefix));
}
