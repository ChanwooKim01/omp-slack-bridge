import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as OsModule from 'os';

/** A PID that cannot belong to a running process (same convention as the lock tests). */
const DEAD_PID = 1073741824;
const g = global as unknown as Record<string, unknown>;

describe('session registry', () => {
  let home: string;
  const sessionsDir = () => join(home, '.omp', 'agent', 'slk-bridge-sessions');
  const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'slk-bridge-registry-'));
    delete g.__slkBridgeInstanceId;
    delete g.__slkBridgeConnected;
    delete g.__slkBridgeOwner;
    vi.resetModules();
  });

  afterEach(() => {
    delete g.__slkBridgeInstanceId;
    delete g.__slkBridgeConnected;
    delete g.__slkBridgeOwner;
    rmSync(home, { recursive: true, force: true });
  });

  async function importRegistry() {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof OsModule>('os');
      return { ...actual, homedir: () => home };
    });
    // Dynamic: the modules read the home directory at import time, after the mock above.
    const registry = await import('../../src/session/registry');
    const lock = await import('../../src/session/lock');
    return { ...registry, getInstanceId: lock.getInstanceId };
  }

  it('writes one file per session named by the sha1 of its path', async () => {
    const { registerSession, getInstanceId } = await importRegistry();
    registerSession('/sessions/a.jsonl');

    expect(readdirSync(sessionsDir())).toEqual([`${sha1('/sessions/a.jsonl')}.json`]);
    const entry = JSON.parse(readFileSync(join(sessionsDir(), `${sha1('/sessions/a.jsonl')}.json`), 'utf-8'));
    expect(entry).toMatchObject({ sessionPath: '/sessions/a.jsonl', pid: process.pid, instanceId: getInstanceId() });
    expect(Number.isNaN(Date.parse(entry.updatedAt))).toBe(false);
  });

  it('reports a session live only while its process is alive, and clears a dead record', async () => {
    const { registerSession, isSessionLive } = await importRegistry();
    registerSession('/sessions/live.jsonl');
    registerSession('/sessions/dead.jsonl', { pid: DEAD_PID, instanceId: 'gone' });

    expect(isSessionLive('/sessions/live.jsonl')).toBe(true);
    expect(isSessionLive('/sessions/never-registered.jsonl')).toBe(false);
    expect(isSessionLive('/sessions/dead.jsonl')).toBe(false);
    expect(existsSync(join(sessionsDir(), `${sha1('/sessions/dead.jsonl')}.json`))).toBe(false);
  });

  it('treats an unreadable record as not live', async () => {
    const { registerSession, isSessionLive } = await importRegistry();
    registerSession('/sessions/a.jsonl');
    writeFileSync(join(sessionsDir(), `${sha1('/sessions/a.jsonl')}.json`), '{not json');

    expect(isSessionLive('/sessions/a.jsonl')).toBe(false);
  });

  it('unregisters this process\'s record but never another process\'s', async () => {
    const { registerSession, unregisterSession, isSessionLive } = await importRegistry();
    registerSession('/sessions/mine.jsonl');
    registerSession('/sessions/theirs.jsonl', { pid: process.pid, instanceId: 'another-process' });

    unregisterSession('/sessions/mine.jsonl');
    unregisterSession('/sessions/theirs.jsonl');

    expect(isSessionLive('/sessions/mine.jsonl')).toBe(false);
    expect(isSessionLive('/sessions/theirs.jsonl')).toBe(true);
  });

  describe('ensureRegistered', () => {
    it('re-creates a record that vanished or points to a dead process', async () => {
      const { registerSession, ensureRegistered, readRegistration } = await importRegistry();

      ensureRegistered('/sessions/a.jsonl');
      expect(readRegistration('/sessions/a.jsonl')?.pid).toBe(process.pid);

      registerSession('/sessions/a.jsonl', { pid: DEAD_PID, instanceId: 'gone' });
      ensureRegistered('/sessions/a.jsonl');
      expect(readRegistration('/sessions/a.jsonl')?.pid).toBe(process.pid);
    });

    it('leaves a record held by another live process alone', async () => {
      const { registerSession, ensureRegistered, readRegistration } = await importRegistry();
      registerSession('/sessions/a.jsonl', { pid: process.pid, instanceId: 'another-process' });

      ensureRegistered('/sessions/a.jsonl');

      expect(readRegistration('/sessions/a.jsonl')?.instanceId).toBe('another-process');
    });
  });
});
