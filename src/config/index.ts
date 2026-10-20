import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SlackBridgeConfig } from "../types/index.js";
import { randomSuffix, sleepSync, writeFileAtomic } from "../util/atomic-write.js";

const CONFIG_DIR = path.join(os.homedir(), ".omp", "agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "slk-bridge.json");
const CONFIG_LOCK_PATH = `${CONFIG_PATH}.lock`;

/** A writer holds the lock for milliseconds; a lock this old belongs to a crashed process. */
const LOCK_STALE_MS = 5_000;
/** Longer than the stale threshold so a crashed holder's lock is always broken before we give up. */
const LOCK_WAIT_MS = 8_000;
const LOCK_BUSY_CODES: Record<string, true> = { EEXIST: true, EPERM: true, EACCES: true, EBUSY: true };

/** The file exists but is not a JSON object. Writing now would wipe tokens and routing state. */
export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigParseError";
  }
}

/**
 * Load config from file and env vars (env vars override file).
 */
export function loadConfig(): SlackBridgeConfig {
  const config: SlackBridgeConfig = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const stats = fs.statSync(CONFIG_PATH);
      const mode = stats.mode & 0o777;
      // Windows protects this file with an ACL; stat().mode does not report that ACL.
      if (process.platform !== "win32" && (mode & 0o077) !== 0) {
        console.warn(`⚠️  Config file ${CONFIG_PATH} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
      }

      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      Object.assign(config, fileConfig);
    } catch (err) {
      console.error("Failed to load config file:", err);
    }
  }

  // Environment variables override file config (higher priority)
  const envBotToken = process.env.PI_SLACK_BOT_TOKEN;
  const envAppToken = process.env.PI_SLACK_APP_TOKEN;
  const envUserToken = process.env.PI_SLACK_USER_TOKEN;
  if (envBotToken && envAppToken) {
    // The user token is optional and independent: keep the file's unless the environment provides one.
    const userToken = envUserToken || config.slack?.userToken;
    config.slack = {
      botToken: envBotToken,
      appToken: envAppToken,
      ...(userToken ? { userToken } : {}),
    };
  } else if (envUserToken && config.slack) {
    config.slack = { ...config.slack, userToken: envUserToken };
  }

  return config;
}

/** Read the file only, without the env overlay, so env-provided tokens are never written back. */
function readConfigFile(): SlackBridgeConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigParseError(`Refusing to overwrite ${CONFIG_PATH}: it is not valid JSON (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigParseError(`Refusing to overwrite ${CONFIG_PATH}: it is not a JSON object`);
  }
  return parsed as SlackBridgeConfig;
}

function isLockStale(): boolean {
  try {
    return Date.now() - fs.statSync(CONFIG_LOCK_PATH).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Cross-process mutex: O_EXCL create, bounded backoff, and stale-lock recovery. Returns the owner token. */
function acquireConfigLock(): string {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomSuffix()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let delayMs = 2;
  for (;;) {
    try {
      const fd = fs.openSync(CONFIG_LOCK_PATH, "wx", 0o600);
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !LOCK_BUSY_CODES[code]) throw err;
    }
    if (isLockStale()) {
      try {
        fs.unlinkSync(CONFIG_LOCK_PATH);
        continue;
      } catch (err) {
        // Gone already (another waiter broke it first): retry at once. Any other failure (EPERM/EACCES:
        // read-only or ACL-protected file, EBUSY: held open) means this lock cannot be broken right now,
        // so wait on it like any other contention: the deadline below must still apply.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the slk-bridge config lock (${CONFIG_LOCK_PATH})`);
    }
    sleepSync(delayMs + Math.floor(Math.random() * delayMs));
    delayMs = Math.min(delayMs * 2, 50);
  }
}

function releaseConfigLock(token: string): void {
  try {
    // If our lock was broken as stale, the file now belongs to someone else.
    if (fs.readFileSync(CONFIG_LOCK_PATH, "utf-8") === token) fs.unlinkSync(CONFIG_LOCK_PATH);
  } catch {
    // Already gone.
  }
}

let updating = false;
let directoryHardened = false;

/**
 * Atomically read-modify-write the config file.
 *
 * Takes a cross-process lock, re-reads the file (so concurrent writers never lose each other's
 * updates), applies `mutator`, and replaces the file via temp file + rename. Nothing is written
 * when the file is unparseable or the mutator changed nothing. Env-provided tokens are not part
 * of the file and therefore never persisted. Returns the config as stored on disk.
 */
export function updateConfig(mutator: (config: SlackBridgeConfig) => void): SlackBridgeConfig {
  if (updating) throw new Error("updateConfig is not re-entrant");
  updating = true;
  try {
    const token = acquireConfigLock();
    try {
      const config = readConfigFile();
      const before = JSON.stringify(config);
      mutator(config);
      if (JSON.stringify(config) === before) return config;
      writeFileAtomic(CONFIG_PATH, JSON.stringify(config, null, 2), 0o600);
      if (!directoryHardened) {
        try {
          fs.chmodSync(CONFIG_DIR, 0o700);
          directoryHardened = true;
        } catch (err) {
          console.warn("Failed to set directory permissions:", err);
        }
      }
      return config;
    } finally {
      releaseConfigLock(token);
    }
  } finally {
    updating = false;
  }
}

/**
 * Changes whenever the config file is rewritten. Lets a reader that caches parsed state (the
 * router's auth) notice another process's save without re-parsing on every call.
 */
export function getConfigVersion(): string {
  try {
    const stats = fs.statSync(CONFIG_PATH);
    return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
  } catch {
    return "";
  }
}
