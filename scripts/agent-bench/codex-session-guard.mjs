const fields = ["input_tokens", "cached_input_tokens", "output_tokens"];
const emptyUsage = () => Object.fromEntries(fields.map((field) => [field, 0]));

function usageValue(value) {
  for (const field of fields) {
    if (!Number.isSafeInteger(value?.[field]) || value[field] < 0) {
      throw new Error(`Invalid usage field: ${field}`);
    }
  }
  if (value.cached_input_tokens > value.input_tokens) throw new Error("Cached input is not a subset");
  const total = value.input_tokens + value.output_tokens;
  if (!Number.isSafeInteger(total)) throw new Error("Usage overflow");
  if (value.total_tokens !== undefined && value.total_tokens !== total) throw new Error("Inconsistent usage total");
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

// Rollouts span resumed processes; cumulative CLI counters need not span them.
// Only validated per-request increments are added. Cache is a subset of input.
export function measureCodexSession(rows) {
  if (!Array.isArray(rows)) throw new Error("Missing session rows");
  let turn = null;
  const previous = new Map();
  const usage = emptyUsage();
  const requests = [];
  let previousTotal = emptyUsage();
  for (const row of rows) {
    if (row.type === "turn_context") {
      turn = row.payload?.turn_id;
      if (typeof turn !== "string" || !turn) throw new Error("Missing turn identity");
    }
    if (row.type !== "event_msg" || row.payload?.type !== "token_count" || !row.payload.info) continue;
    if (!turn) throw new Error("Usage without turn context");
    const total = usageValue(row.payload.info.total_token_usage);
    const last = usageValue(row.payload.info.last_token_usage);
    const prior = previous.get(turn);
    const fingerprint = JSON.stringify(total);
    if (prior?.fingerprint === fingerprint) {
      if (JSON.stringify(prior.last) !== JSON.stringify(last)) throw new Error("Conflicting usage snapshot");
      continue;
    }
    // A new turn can continue cumulative counters or reset them. Within a turn,
    // a missing increment or a reset is ambiguous and must fail closed.
    if (prior && fields.some((field) => total[field] - prior.total[field] !== last[field])) {
      throw new Error("Discontinuous usage counters");
    }
    if (!prior && !fields.every((field) => total[field] === last[field]) &&
      !fields.every((field) => total[field] - previousTotal[field] === last[field])) {
      throw new Error("Missing initial usage increment");
    }
    if (fields.some((field) => total[field] < last[field])) throw new Error("Invalid cumulative usage");
    const next = usageValue(Object.fromEntries(fields.map((field) => [field, usage[field] + last[field]])));
    Object.assign(usage, next);
    requests.push({ turn, total, last });
    previous.set(turn, { fingerprint, total, last });
    previousTotal = total;
  }
  return { ...usage, total_tokens: usage.input_tokens + usage.output_tokens, requests };
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

export function createCodexSessionGuard({ tokenLimit, requestLimit, initialRows = [] }) {
  if (tokenLimit !== null) positiveInteger(tokenLimit, "tokenLimit");
  positiveInteger(requestLimit, "requestLimit");
  let known = measureCodexSession(initialRows);
  const initial = known;
  let stopReason = null;
  let usageError = false;
  const stop = (reason) => { stopReason ??= reason; };
  function checkLimits() {
    if (tokenLimit !== null && known.total_tokens >= tokenLimit) stop("session-token-limit");
    if (known.requests.length >= requestLimit) stop("session-request-limit");
  }
  checkLimits();
  return {
    get stopReason() { return stopReason; },
    observe(rows) {
      try {
        const measured = measureCodexSession(rows);
        if (measured.requests.length < known.requests.length || known.requests.some((request, index) =>
          JSON.stringify(request) !== JSON.stringify(measured.requests[index]))) {
          throw new Error("Session history changed or disappeared");
        }
        known = measured;
        checkLimits();
      } catch {
        usageError = true;
        stop("usage-invalid");
      }
      return stopReason;
    },
    fail(reason) {
      stop(reason);
    },
    finish({ exitCode, turnUsage }) {
      let receiptScope = null;
      try {
        const current = usageValue(turnUsage);
        if (fields.every((field) => known[field] - initial[field] === current[field])) {
          receiptScope = "stage";
        } else if (initial.requests.length > 0 && fields.every((field) =>
          current[field] === known[field] && current[field] === known.requests.at(-1)?.total[field])) {
          // Resumed CLI receipts may cover the session, but must match both the
          // request ledger and the final counter, not an assumed cumulative sum.
          receiptScope = "session";
        }
      } catch { /* A missing provider receipt is unavailable, not zero usage. */ }
      const reconciled = receiptScope !== null;
      if (!reconciled) stop("usage-unreconciled");
      if (known.requests.length === initial.requests.length) stop("usage-missing");
      if (exitCode !== 0) stop("process-failed");
      const usageComplete = !usageError && reconciled && exitCode === 0 && stopReason === null;
      const observedUsage = { ...Object.fromEntries(fields.map((field) => [field, known[field]])),
        total_tokens: known.total_tokens, requests: known.requests.length };
      return { usageComplete, stopReason, receiptScope,
        sessionUsage: usageComplete ? observedUsage : null,
        observedUsage,
        stageUsage: usageComplete ? { ...Object.fromEntries(fields.map((field) => [field, known[field] - initial[field]])),
          total_tokens: known.total_tokens - initial.total_tokens,
          requests: known.requests.length - initial.requests.length } : null,
        budget: { tokenLimit, requestLimit, enforcement: tokenLimit === null ? "request-limit-only" : "observed-usage-soft-stop",
          overrunTokens: tokenLimit === null ? 0 : Math.max(0, known.total_tokens - tokenLimit) } };
    },
  };
}

// Polling is local I/O, never a model request. Serialize samples so a late read
// cannot overwrite a newer snapshot or race the final receipt.
export function watchCodexSession({ guard, readRows, stop, inspectRows = () => null, intervalMs = 2000 }) {
  positiveInteger(intervalMs, "intervalMs");
  let closed = false;
  let timer;
  let pending = Promise.resolve();
  async function sample() {
    try {
      const rows = await readRows();
      guard.observe(rows);
      const reason = inspectRows(rows);
      if (reason) guard.fail(reason);
    } catch {
      guard.fail("session-read-failed");
    }
    if (guard.stopReason) stop(guard.stopReason);
  }
  function schedule() {
    timer = setTimeout(() => {
      pending = sample().finally(() => { if (!closed && !guard.stopReason) schedule(); });
    }, intervalMs);
  }
  schedule();
  return {
    async finish() {
      closed = true;
      clearTimeout(timer);
      await pending;
      await sample();
    },
  };
}
