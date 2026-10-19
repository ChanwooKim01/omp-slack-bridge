import * as fs from "fs";

/** Windows reports these while another process (antivirus, indexer, reader) briefly holds the destination. */
const TRANSIENT_RENAME_CODES: Record<string, true> = { EPERM: true, EACCES: true, EBUSY: true };
const RENAME_ATTEMPTS = 8;

/** Block the current thread without spinning; callers are synchronous by design (config/lock paths). */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Replace `target` with `contents` so that concurrent readers see either the old or the new file,
 * never a partial one: write a sibling temp file, then rename it over the target.
 */
export function writeFileAtomic(target: string, contents: string, mode = 0o600): void {
  const tmp = `${target}.${process.pid}.${randomSuffix()}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { mode });
    renameOverTarget(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The temp file may never have been created.
    }
    throw err;
  }
}

function renameOverTarget(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_ATTEMPTS || !code || !TRANSIENT_RENAME_CODES[code]) throw err;
      sleepSync(attempt * 10);
    }
  }
}
