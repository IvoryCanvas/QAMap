const digestWorkerEnabled = process.env.DIGEST_WORKER_ENABLED === "1";

export function createDigest(queue, accountId) {
  if (!digestWorkerEnabled) return;
  queue.enqueue("digest", { accountId });
}
