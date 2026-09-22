import { constants } from "node:fs";
import { access, stat, symlink } from "node:fs/promises";
import path from "node:path";

// Preserve a prerequisite without exposing unrelated tools in an isolated PATH.
export async function preserveTestExecutable(command, directory) {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.resolve(entry, command);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
    } catch { continue; }
    await symlink(candidate, path.join(directory, command));
    return;
  }
  throw new Error(`Could not locate ${command} for the isolated PATH fixture.`);
}
