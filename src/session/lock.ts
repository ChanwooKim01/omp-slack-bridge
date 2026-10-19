import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Single-router guard: whoever holds this lock owns the one Slack Socket Mode connection.
 *
 * Two layers:
 *  1. global flag  — catches same-process re-entrant calls (e.g. sub-agents
 *                    spawned inside the same Node.js process, same PID).
 *  2. PID lock file — catches separate-process duplicates (e.g. sessions
 *                    launched as separate processes with different PIDs).
 *
 * `acquireLock()` only claims a vacant lock and creates the file exclusively, so concurrent
 * claimants cannot both win. `forceAcquireLock()` (explicit `/slk-bridge router`) overwrites the
 * owner record; the previous owner notices it no longer owns the lock and closes its socket.
 */

const CONFIG_DIR = path.join(os.homedir(), ".omp", "agent");
const LOCK_PATH = path.join(CONFIG_DIR, "slk-bridge.lock");

/** Process-wide state shared by every extension instance loaded into this process. */
interface BridgeGlobals {
  __slkBridgeInstanceId?: string;
  __slkBridgeConnected?: boolean;
  __slkBridgeOwner?: string;
}
const g = global as unknown as BridgeGlobals;
if (!g.__slkBridgeInstanceId) {
  g.__slkBridgeInstanceId = Math.random().toString(36).slice(2);
}
const instanceId: string = g.__slkBridgeInstanceId;

export interface LockInfo {
  pid: number;
  owner: string;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function parseLockInfo(raw: string): LockInfo | null {
  const [pidStr, owner = ""] = raw.trim().split(":");
  const pid = parseInt(pidStr, 10);
  if (Number.isNaN(pid) || !owner) return null;
  return { pid, owner };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getInstanceId(): string {
  return instanceId;
}

export function getLockOwner(): LockInfo | null {
  try {
    const lockPath = resolveLockPath();
    if (!fs.existsSync(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, "utf-8");
    const info = parseLockInfo(raw);
    if (!info) return null;
    if (info.pid !== process.pid && !isProcessAlive(info.pid)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore stale cleanup failures
      }
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

function resolveLockPath(): string {
  return LOCK_PATH;
}

export function isLockHeldLocally(): boolean {
  return g.__slkBridgeConnected === true && g.__slkBridgeOwner === instanceId;
}

export function isCurrentLockOwner(): boolean {
  if (!isLockHeldLocally()) return false;
  const info = getLockOwner();
  return !!info && info.pid === process.pid && info.owner === instanceId;
}

/**
 * An empty or unparseable record is a claim still being written (the exclusive create precedes the
 * write) until it has sat there this long; only then is it garbage left behind by a crash.
 */
const UNREADABLE_LOCK_GRACE_MS = 5_000;

/**
 * Create the lock file for this instance. Exclusive create makes two simultaneous claimants
 * race on the filesystem instead of both overwriting each other; the loser sees the winner's record.
 */
function claimLockFile(): boolean {
  ensureConfigDir();
  const record = `${process.pid}:${instanceId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_PATH, record, { mode: 0o600, flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const owner = getLockOwner();
    if (owner) return owner.pid === process.pid && owner.owner === instanceId;
    // EEXIST without a live owner: the winner vanished, is still writing its record, or left garbage.
    // A fresh unreadable record is the winner's claim in progress. Deleting it would let a second
    // claimant create its own file, and both would win. Only an old one is removed.
    try {
      if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs <= UNREADABLE_LOCK_GRACE_MS) return false;
      if (parseLockInfo(fs.readFileSync(LOCK_PATH, "utf-8")) === null) fs.unlinkSync(LOCK_PATH);
    } catch {
      // Already gone: the retry will find it vacant.
    }
  }
  return false;
}

export function acquireLock(): boolean {
  // Layer 1: same-process guard via a global flag
  if (g.__slkBridgeConnected && g.__slkBridgeOwner !== instanceId) {
    return false;
  }

  // Layer 2: cross-process guard via PID lock file
  try {
    const currentOwner = getLockOwner();
    if (currentOwner) {
      if (currentOwner.pid !== process.pid || currentOwner.owner !== instanceId) {
        return false;
      }
    } else if (!claimLockFile()) {
      return false;
    }
  } catch {
    // lock file mechanics failed — fall through, global flag is still set below
  }

  g.__slkBridgeConnected = true;
  g.__slkBridgeOwner = instanceId;
  return true;
}

export function forceAcquireLock(): LockInfo | null {
  const previousOwner = getLockOwner();

  try {
    ensureConfigDir();
    fs.writeFileSync(LOCK_PATH, `${process.pid}:${instanceId}`, { mode: 0o600 });
  } catch {
    // ignore lock file failures; local ownership state is still updated below
  }

  g.__slkBridgeConnected = true;
  g.__slkBridgeOwner = instanceId;
  return previousOwner;
}

export function releaseLock(): void {
  if (g.__slkBridgeOwner !== instanceId) return;
  g.__slkBridgeConnected = false;
  g.__slkBridgeOwner = undefined;
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const raw = fs.readFileSync(LOCK_PATH, "utf-8");
      const info = parseLockInfo(raw);
      if (info && info.pid === process.pid && info.owner === instanceId) {
        fs.unlinkSync(LOCK_PATH);
      }
    }
  } catch {
    // ignore
  }
}
