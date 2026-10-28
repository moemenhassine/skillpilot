import { constants } from "node:fs";
import { open } from "node:fs/promises";

// O_NOFOLLOW is undefined on Windows; there the caller's lstat check is the only guard.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** Reads at most `maxBytes` (+1 to detect overflow) without following a final symlink. */
export async function readBounded(file: string, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const fh = await open(file, READ_FLAGS);
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return total > maxBytes ? { bytes: buf.subarray(0, maxBytes), truncated: true } : { bytes: buf.subarray(0, total), truncated: false };
  } finally {
    await fh.close();
  }
}
