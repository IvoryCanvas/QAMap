import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DiscoverySkipReason =
  | "excluded-directory"
  | "nested-repository"
  | "symlink"
  | "unreadable"
  | "unsupported-language"
  | "non-source"
  | "oversized"
  | "binary"
  | "source-limit"
  | "package-limit"
  | "invalid-path";

export interface DiscoveryGap {
  path: string;
  reason: DiscoverySkipReason;
}

export interface RepositoryDiscovery {
  discovery: "git" | "filesystem" | "unavailable";
  inventoryComplete: boolean;
  files: string[];
  skipped: DiscoveryGap[];
}

export async function discoverRepositoryPaths(
  root: string,
  excludedDirectories: ReadonlySet<string>,
): Promise<RepositoryDiscovery> {
  try {
    const { stdout } = await execFileAsync("git", [
      "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    ], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
    return {
      discovery: "git",
      inventoryComplete: true,
      files: [...new Set(stdout.split("\0").filter(Boolean))].sort(),
      skipped: [],
    };
  } catch (error) {
    const failure = error as { stderr?: string };
    // Only a confirmed non-repository can use the broader filesystem fallback.
    if (!/not a git repository/i.test(failure.stderr ?? "")) {
      return { discovery: "unavailable", inventoryComplete: false, files: [], skipped: [] };
    }
  }

  const result: RepositoryDiscovery = {
    discovery: "filesystem", inventoryComplete: true, files: [], skipped: [],
  };
  const queue = [""];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const directory = queue[cursor];
    let entries;
    try {
      entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
    } catch {
      result.inventoryComplete = false;
      result.skipped.push({ path: directory || ".", reason: "unreadable" });
      continue;
    }
    if (directory && entries.some((entry) => entry.name === ".git")) {
      result.skipped.push({ path: directory, reason: "nested-repository" });
      continue;
    }
    for (const entry of entries.sort((left, right) => comparePaths(left.name, right.name))) {
      const file = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name) || entry.name.startsWith(".")) {
          result.skipped.push({ path: file, reason: "excluded-directory" });
        } else {
          queue.push(file);
        }
      } else {
        result.files.push(file);
      }
    }
  }
  result.files.sort();
  return result;
}

export function createRepositoryTextReader(root: string, skipped: DiscoveryGap[], maxBytes: number) {
  const directories = new Map<string, DiscoverySkipReason | undefined>();
  return async (file: string): Promise<string | undefined> => {
    if (!file || path.isAbsolute(file) || file.split("/").some((part) => part === ".." || part === ".")) {
      skipped.push({ path: "<invalid-path>", reason: "invalid-path" });
      return undefined;
    }
    let parent = "";
    for (const part of file.split("/").slice(0, -1)) {
      parent = parent ? `${parent}/${part}` : part;
      if (!directories.has(parent)) {
        let reason: DiscoverySkipReason | undefined;
        try {
          const stat = await fs.lstat(path.join(root, parent));
          if (stat.isSymbolicLink()) reason = "symlink";
          else if (!stat.isDirectory()) reason = "unreadable";
          else if (await fs.lstat(path.join(root, parent, ".git")).then(() => true, () => false)) {
            reason = "nested-repository";
          }
        } catch {
          reason = "unreadable";
        }
        directories.set(parent, reason);
      }
      const reason = directories.get(parent);
      if (reason) {
        skipped.push({ path: file, reason });
        return undefined;
      }
    }
    let handle;
    try {
      const stat = await fs.lstat(path.join(root, file));
      if (stat.isSymbolicLink()) {
        skipped.push({ path: file, reason: "symlink" });
        return undefined;
      }
      if (!stat.isFile()) {
        skipped.push({ path: file, reason: "nested-repository" });
        return undefined;
      }
      if (stat.size > maxBytes) {
        skipped.push({ path: file, reason: "oversized" });
        return undefined;
      }
      handle = await fs.open(path.join(root, file), constants.O_RDONLY | constants.O_NOFOLLOW);
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) {
        skipped.push({ path: file, reason: "oversized" });
        return undefined;
      }
      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) {
        skipped.push({ path: file, reason: "binary" });
        return undefined;
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        skipped.push({ path: file, reason: "binary" });
        return undefined;
      }
    } catch {
      skipped.push({ path: file, reason: "unreadable" });
      return undefined;
    } finally {
      await handle?.close();
    }
  };
}

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
