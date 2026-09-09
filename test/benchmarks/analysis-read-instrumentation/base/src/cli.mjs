import { readChunk } from "./inspection-tools.mjs";

process.stdout.write(readChunk(Buffer.from(process.argv[2] ?? ""), 3, {
  read() {},
  directRead() {},
}));
