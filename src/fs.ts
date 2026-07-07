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

export async function collectProjectFiles(root: string, maxFiles: number): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  const normalizedRoot = path.resolve(root);

  async function walk(directory: string): Promise<void> {
    if (files.length >= maxFiles) {
      return;
    }

    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

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
