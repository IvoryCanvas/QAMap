import { performance } from "node:perf_hooks";

export function createRunTiming({ enabled = true, now = () => performance.now() } = {}) {
  const startedAt = enabled ? now() : null;
  const phases = { fixtureSetupMs: null, agentMs: null, judgeMs: null, cleanupMs: null };
  return {
    async measure(phase, operation) {
      if (!Object.hasOwn(phases, phase)) throw new Error(`Unknown timing phase "${phase}".`);
      const start = enabled ? now() : null;
      try { return await operation(); }
      finally { if (enabled) phases[phase] = now() - start; }
    },
    snapshot: () => ({ ...phases, totalMs: enabled ? now() - startedAt : null }),
  };
}
