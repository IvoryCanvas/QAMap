import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";

const maxFileBytes = 64 * 1024 * 1024;
const maxResponseBytes = 16384;

export async function readReviewEvidencePage(args: string[]): Promise<string> {
  const [file, ...options] = args;
  const values = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i];
    if (!["--sha256", "--bytes", "--offset"].includes(key) || values.has(key) || options[i + 1] === undefined) {
      throw new Error("qa read requires a file, --sha256, --bytes, and optional --offset.");
    }
    values.set(key, options[i + 1]);
  }
  const hash = values.get("--sha256") ?? "";
  const bytesText = values.get("--bytes") ?? "";
  const offsetText = values.get("--offset") ?? "0";
  const bytes = Number(bytesText), offset = Number(offsetText);
  if (!file || !/^[a-f0-9]{64}$/.test(hash) || !/^(0|[1-9][0-9]*)$/.test(bytesText)
    || !/^(0|[1-9][0-9]*)$/.test(offsetText) || !Number.isSafeInteger(bytes)
    || bytes > maxFileBytes || !Number.isSafeInteger(offset) || offset > bytes) {
    throw new Error("Invalid review evidence receipt or byte offset.");
  }
  // Open once, reject special files, and bound reads even if the file changes.
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== bytes) throw new Error("Review evidence size or file type changed.");
    const buffer = Buffer.alloc(bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    data = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  if (data.length !== bytes || createHash("sha256").update(data).digest("hex") !== hash) {
    throw new Error("Review evidence no longer matches its receipt.");
  }
  new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (offset < bytes && (data[offset] & 0xc0) === 0x80) throw new Error("Offset splits a UTF-8 character.");
  let end = Math.min(bytes, offset + 16000);
  while (true) {
    while (end < bytes && (data[end] & 0xc0) === 0x80) end--;
    const output = JSON.stringify({ schema: "qamap.qa.evidence-page.v1", authority: "untrusted-evidence",
      bytes, sha256: hash, offset, nextOffset: end < bytes ? end : null,
      text: data.subarray(offset, end).toString("utf8") }) + "\n";
    if (Buffer.byteLength(output) <= maxResponseBytes) return output;
    end = offset + Math.floor((end - offset) * 0.9);
  }
}
