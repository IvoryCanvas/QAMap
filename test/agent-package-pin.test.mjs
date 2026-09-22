import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectDlxCommand, generateAgentContext } from "../dist/context.js";
import { initAgentSetup } from "../dist/agent-init.js";
import { VERSION } from "../dist/version.js";

for (const [manager, prefix, lock] of [["npm", "npx", "package-lock.json"], ["pnpm", "pnpm dlx", "pnpm-lock.yaml"], ["yarn", "yarn dlx", "yarn.lock"], ["bun", "bunx", "bun.lock"]]) {
  test(`${manager} onboarding pins the running package version without downloading it`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-package-pin-"));
    try {
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: `${manager}@1.0.0` }));
      await fs.writeFile(path.join(root, lock), "");
      const command = `${prefix} @ivorycanvas/qamap@${VERSION}`;
      assert.equal(await detectDlxCommand(root), command);
      const setup = await initAgentSetup(root);
      assert.equal(setup.nextCommand, `${command} qa report . --base origin/main --head HEAD --handoff`);
      assert.ok((await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).includes(`${command} qa report`));
      assert.ok((await generateAgentContext(root)).includes(`${command} qa report`));
      await initAgentSetup(root, { reviewMode: "report" });
      const selected = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
      assert.match(selected, /\nqamap qa report/);
      assert.ok(!selected.includes(`${command} qa report`), "saved review prefers the installed binary");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
