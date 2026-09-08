import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const maxBytes = 8 * 1024 * 1024;
const maxSnapshots = 8;
const ttlMs = 24 * 60 * 60 * 1000;
const managedName = /^[a-f0-9]{64}\.json$/;
const temporaryName = /^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/;

export interface ImportBlock {
  file: string;
  hash: string;
  imports: string[];
}

export interface ImportSnapshot {
  schema: 1;
  context: string;
  blocks: ImportBlock[];
}

type StorageState = "saved" | "unchanged" | "skipped" | "failed";

export interface ImportCache {
  state: "cold" | "loaded" | "invalid-cache" | "expired-cache" | "disabled" | "unavailable";
  previous?: ImportSnapshot;
  save: (snapshot: ImportSnapshot) => Promise<StorageState>;
}

function safeRelative(file: unknown): file is string {
  return typeof file === "string" && file.length > 0 && file.length <= 4096
    && !file.includes("\\") && !file.includes("\0") && !file.startsWith("/")
    && !file.split("/").some((part) => part === "." || part === ".." || part === "");
}

function validSnapshot(value: unknown): value is ImportSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as ImportSnapshot;
  if (Object.keys(snapshot).sort().join(",") !== "blocks,context,schema"
    || snapshot.schema !== 1 || typeof snapshot.context !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.context)
    || !Array.isArray(snapshot.blocks) || snapshot.blocks.length > 12000) return false;
  const files = new Set<string>();
  for (const block of snapshot.blocks) {
    if (!block || Object.keys(block).sort().join(",") !== "file,hash,imports"
      || !safeRelative(block.file) || files.has(block.file)
      || typeof block.hash !== "string" || !/^[a-f0-9]{64}$/.test(block.hash)
      || !Array.isArray(block.imports) || block.imports.length > 12000
      || !block.imports.every(safeRelative) || block.imports.includes(block.file)
      || new Set(block.imports).size !== block.imports.length) return false;
    files.add(block.file);
  }
  return true;
}

function isPrivate(stat: Awaited<ReturnType<typeof lstat>>): boolean {
  return (typeof process.getuid !== "function" || stat.uid === process.getuid())
    && (process.platform === "win32" || (Number(stat.mode) & 0o077) === 0);
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Only this private cache's named regular files are eligible for eviction.
async function prune(directory: string, keep: string): Promise<void> {
  const entries: Array<{ name: string; modified: number }> = [];
  for (const name of await readdir(directory)) {
    if (!managedName.test(name) && !temporaryName.test(name)) continue;
    const stat = await lstat(path.join(directory, name)).catch(() => undefined);
    if (!stat?.isFile() || stat.nlink !== 1 || !isPrivate(stat) || name === keep) continue;
    if (Date.now() - stat.mtimeMs > ttlMs) {
      await unlink(path.join(directory, name)).catch(() => undefined);
    } else if (managedName.test(name)) entries.push({ name, modified: stat.mtimeMs });
  }
  entries.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  for (const entry of entries.slice(maxSnapshots - 1)) {
    await unlink(path.join(directory, entry.name)).catch(() => undefined);
  }
}

export async function openImportCache(
  root: string, requestedDirectory?: string | false, available = true,
): Promise<ImportCache> {
  const inactive = (state: "disabled" | "unavailable"): ImportCache => ({ state, save: async () => "skipped" });
  if (requestedDirectory === false || process.env.QAMAP_IMPORT_CACHE === "off") return inactive("disabled");
  if (!available) return inactive("unavailable");
  try {
    const canonicalRoot = await realpath(root);
    const owner = typeof process.getuid === "function" ? String(process.getuid())
      : createHash("sha256").update(os.userInfo().username).digest("hex").slice(0, 16);
    const requested = path.resolve(requestedDirectory ?? path.join(os.tmpdir(), `qamap-import-index-${owner}`));
    const directory = path.join(await realpath(path.dirname(requested)), path.basename(requested));
    if (inside(canonicalRoot, directory)) return inactive("unavailable");
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || !isPrivate(directoryStat)) return inactive("unavailable");
    const name = `${createHash("sha256").update(canonicalRoot).digest("hex")}.json`;
    const filename = path.join(directory, name);
    let state: ImportCache["state"] = "cold";
    let previous: ImportSnapshot | undefined;
    const stat = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat) {
      if (!stat.isFile() || stat.nlink !== 1 || !isPrivate(stat)) return inactive("unavailable");
      state = "invalid-cache";
      if (Date.now() - stat.mtimeMs > ttlMs) state = "expired-cache";
      else if (stat.size <= maxBytes) {
        const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || !isPrivate(opened)) return inactive("unavailable");
          const bytes = Buffer.alloc(Math.min(opened.size, maxBytes) + 1);
          let length = 0;
          while (length < bytes.length) {
            const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length < bytes.length) {
            const parsed: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
            if (validSnapshot(parsed)) { previous = parsed; state = "loaded"; }
          }
        } catch { /* Invalid local state is disposable, never an analysis failure. */ }
        finally { await handle.close(); }
      }
    }
    return {
      state, previous,
      save: async (snapshot) => {
        const text = JSON.stringify(snapshot);
        if (Buffer.byteLength(text) > maxBytes || !validSnapshot(snapshot)) return "skipped";
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try {
          const currentDirectory = await lstat(directory);
          if (!currentDirectory.isDirectory() || !isPrivate(currentDirectory)
            || currentDirectory.ino !== directoryStat.ino || currentDirectory.dev !== directoryStat.dev) return "failed";
          if (previous && text === JSON.stringify(previous)) return "unchanged";
          const handle = await open(temporary, "wx", 0o600);
          try { await handle.writeFile(text); }
          finally { await handle.close(); }
          await rename(temporary, filename);
          await prune(directory, name).catch(() => undefined);
          return "saved";
        } catch { return "failed"; }
        finally { await unlink(temporary).catch(() => undefined); }
      },
    };
  } catch { return inactive("unavailable"); }
}
