const digestWorkerEnabled = false;

export function createDigest(queue, accountId) {
  if (!digestWorkerEnabled) return;
  queue.enqueue("digest", { accountId });
}
