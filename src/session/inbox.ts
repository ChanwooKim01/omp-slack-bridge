import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExternalMessage } from "../types/index.js";
import { randomSuffix, writeFileAtomic } from "../util/atomic-write.js";
import { sessionKey } from "./registry.js";

/**
 * Per-session inbox the router uses to hand Slack messages to another session's process:
 * ~/.omp/agent/slk-bridge-inbox/<sha1(sessionPath)>/<ts>-<rand>.json. Files are written
 * atomically and consumed (deleted) by the owning session, oldest first.
 */
const INBOX_ROOT = path.join(os.homedir(), ".omp", "agent", "slk-bridge-inbox");

/**
 * Messages older than this are dropped when drained. Running an hours-old instruction because
 * a session restarted late is worse than losing it.
 */
export const INBOX_MAX_AGE_MS = 10 * 60_000;

function inboxDir(sessionPath: string): string {
  return path.join(INBOX_ROOT, sessionKey(sessionPath));
}

/** Orders messages queued by this process within the same millisecond. */
let sequence = 0;

export function enqueueInboxMessage(sessionPath: string, message: ExternalMessage): void {
  const dir = inboxDir(sessionPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Zero-padded millisecond prefix, then a per-process counter, makes lexicographic order chronological.
  const order = (sequence++ % 36 ** 4).toString(36).padStart(4, "0");
  const name = `${Date.now().toString().padStart(13, "0")}-${order}${randomSuffix()}.json`;
  writeFileAtomic(path.join(dir, name), JSON.stringify(message), 0o600);
}

function reviveMessage(raw: string): ExternalMessage | null {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const { chatId, content, username, userId, messageId, isGroupChat } = parsed;
  if (
    typeof chatId !== "string" ||
    typeof content !== "string" ||
    typeof username !== "string" ||
    typeof userId !== "string" ||
    typeof messageId !== "string" ||
    typeof isGroupChat !== "boolean"
  ) {
    return null;
  }
  // JSON turned the Date into an ISO string.
  const timestamp = new Date(typeof parsed.timestamp === "string" || typeof parsed.timestamp === "number" ? parsed.timestamp : NaN);
  return {
    chatId,
    content,
    username,
    userId,
    messageId,
    isGroupChat,
    timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
    ...(typeof parsed.wasMentioned === "boolean" ? { wasMentioned: parsed.wasMentioned } : {}),
    ...(typeof parsed.threadId === "string" ? { threadId: parsed.threadId } : {}),
    ...(typeof parsed.isThreadReply === "boolean" ? { isThreadReply: parsed.isThreadReply } : {}),
  };
}

/**
 * Take every pending message, oldest first. Each file is deleted as it is read; only the reader
 * whose delete succeeds delivers it, so competing readers never deliver a message twice.
 * Expired and malformed files are deleted without being delivered.
 */
export function drainInbox(sessionPath: string, now: number = Date.now()): ExternalMessage[] {
  const dir = inboxDir(sessionPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const messages: ExternalMessage[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
      fs.unlinkSync(file);
    } catch {
      // Another reader took it first.
      continue;
    }
    const queuedAt = Number(name.split("-")[0]);
    if (Number.isFinite(queuedAt) && now - queuedAt > INBOX_MAX_AGE_MS) continue;
    const message = reviveMessage(raw);
    if (message) messages.push(message);
  }
  return messages;
}

/** Discard everything pending for a session that left the bridge. */
export function clearInbox(sessionPath: string): void {
  fs.rmSync(inboxDir(sessionPath), { recursive: true, force: true });
}
