import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeFileAtomic } from "../util/atomic-write.js";
import { getInstanceId, isProcessAlive } from "./lock.js";

/**
 * Registry of sessions currently joined to the bridge, one file per session:
 * ~/.omp/agent/slk-bridge-sessions/<sha1(sessionPath)>.json. The router consults it to decide
 * whether the owner of a Slack thread is a live process it can hand the message to.
 */
const SESSIONS_DIR = path.join(os.homedir(), ".omp", "agent", "slk-bridge-sessions");

export interface SessionRegistration {
  sessionPath: string;
  pid: number;
  instanceId: string;
  updatedAt: string;
}

interface RegistrationOwner {
  pid: number;
  instanceId: string;
}

/** Stable per-session key shared by the registry and the inbox. */
export function sessionKey(sessionPath: string): string {
  return crypto.createHash("sha1").update(sessionPath).digest("hex");
}

function registrationPath(sessionPath: string): string {
  return path.join(SESSIONS_DIR, `${sessionKey(sessionPath)}.json`);
}

/** `owner` defaults to this process; tests register other processes explicitly. */
export function registerSession(
  sessionPath: string,
  owner: RegistrationOwner = { pid: process.pid, instanceId: getInstanceId() },
): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const entry: SessionRegistration = { sessionPath, ...owner, updatedAt: new Date().toISOString() };
  writeFileAtomic(registrationPath(sessionPath), JSON.stringify(entry), 0o600);
}

export function readRegistration(sessionPath: string): SessionRegistration | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registrationPath(sessionPath), "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const entry = parsed as Partial<SessionRegistration>;
  if (typeof entry.pid !== "number" || typeof entry.instanceId !== "string") return null;
  return {
    sessionPath: typeof entry.sessionPath === "string" ? entry.sessionPath : sessionPath,
    pid: entry.pid,
    instanceId: entry.instanceId,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
  };
}

/** A registration is live while the process that wrote it is alive. A dead one is removed. */
export function isSessionLive(sessionPath: string): boolean {
  const entry = readRegistration(sessionPath);
  if (!entry) return false;
  if (isProcessAlive(entry.pid)) return true;
  // Re-read before deleting so a session that restarted in the meantime keeps its fresh record.
  if (readRegistration(sessionPath)?.pid === entry.pid) {
    try {
      fs.unlinkSync(registrationPath(sessionPath));
    } catch {
      // Already removed.
    }
  }
  return false;
}

/**
 * Re-assert this process's registration when the file vanished or points to a dead process.
 * A record held by another live process is left alone so two processes never fight over a session.
 */
export function ensureRegistered(sessionPath: string): void {
  const entry = readRegistration(sessionPath);
  if (!entry || !isProcessAlive(entry.pid)) registerSession(sessionPath);
}

/** Remove this process's registration; a record written by another process is never touched. */
export function unregisterSession(sessionPath: string): void {
  const entry = readRegistration(sessionPath);
  if (!entry || entry.pid !== process.pid || entry.instanceId !== getInstanceId()) return;
  try {
    fs.unlinkSync(registrationPath(sessionPath));
  } catch {
    // Already removed.
  }
}
