import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildChildModules, runChild } from '../helpers/child-process';

describe('lock', () => {
  let tmpDir: string;
  const g = global as any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slk-bridge-lock-'));
    delete g.__slkBridgeInstanceId;
    delete g.__slkBridgeConnected;
    delete g.__slkBridgeOwner;
    vi.resetModules();
  });

  afterEach(() => {
    delete g.__slkBridgeConnected;
    delete g.__slkBridgeOwner;
    delete g.__slkBridgeInstanceId;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importLock(lockDir: string) {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => lockDir };
    });
    return await import('../../src/session/lock');
  }

  it('acquires lock and writes lock file', async () => {
    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    expect(g.__slkBridgeConnected).toBe(true);

    const lockPath = join(tmpDir, '.omp', 'agent', 'slk-bridge.lock');
    const content = readFileSync(lockPath, 'utf-8');
    const [pid, owner] = content.split(':');
    expect(parseInt(pid, 10)).toBe(process.pid);
    expect(owner).toBe(g.__slkBridgeInstanceId);
  });

  it('allows same instance to re-acquire (idempotent)', async () => {
    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    expect(acquireLock()).toBe(true);
  });

  it('release clears global state and removes lock file', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);
    acquireLock();

    releaseLock();
    expect(g.__slkBridgeConnected).toBe(false);
    expect(g.__slkBridgeOwner).toBeUndefined();
    expect(existsSync(join(tmpDir, '.omp', 'agent', 'slk-bridge.lock'))).toBe(false);
  });

  it('acquire → release → re-acquire works', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);

    expect(acquireLock()).toBe(true);
    releaseLock();
    expect(g.__slkBridgeConnected).toBe(false);

    expect(acquireLock()).toBe(true);
    expect(g.__slkBridgeConnected).toBe(true);
    expect(existsSync(join(tmpDir, '.omp', 'agent', 'slk-bridge.lock'))).toBe(true);
  });

  it('blocks a different instance in the same process (layer 1)', async () => {
    const { acquireLock } = await importLock(tmpDir);
    acquireLock();

    vi.resetModules();
    delete g.__slkBridgeInstanceId;
    const lock2 = await importLock(tmpDir);

    expect(lock2.acquireLock()).toBe(false);
  });

  it('overwrites stale lock from dead process (layer 2)', async () => {
    const piDir = join(tmpDir, '.omp', 'agent');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'slk-bridge.lock'), '1073741824:stale-owner');

    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
  });

  it('blocks when a live process holds the lock (layer 2)', async () => {
    const piDir = join(tmpDir, '.omp', 'agent');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'slk-bridge.lock'), `${process.pid}:other-instance`);

    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(false);
  });

  it('releaseLock is a no-op for non-owner', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);
    acquireLock();

    const realOwner = g.__slkBridgeOwner;
    g.__slkBridgeOwner = 'someone-else';
    releaseLock();

    g.__slkBridgeOwner = realOwner;
    expect(g.__slkBridgeConnected).toBe(true);
    expect(existsSync(join(tmpDir, '.omp', 'agent', 'slk-bridge.lock'))).toBe(true);
  });


  it('forceAcquireLock overwrites another owner', async () => {
    const piDir = join(tmpDir, '.omp', 'agent');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'slk-bridge.lock'), `${process.pid}:other-instance`);

    const { forceAcquireLock } = await importLock(tmpDir);
    const previousOwner = forceAcquireLock();

    expect(previousOwner).toEqual({ pid: process.pid, owner: 'other-instance' });
    expect(readFileSync(join(piDir, 'slk-bridge.lock'), 'utf-8')).toBe(`${process.pid}:${g.__slkBridgeInstanceId}`);
    expect(g.__slkBridgeConnected).toBe(true);
    expect(g.__slkBridgeOwner).toBe(g.__slkBridgeInstanceId);
  });

  it('reports whether lock is held locally and currently owned', async () => {
    const { acquireLock, isCurrentLockOwner, isLockHeldLocally } = await importLock(tmpDir);

    expect(isLockHeldLocally()).toBe(false);
    expect(isCurrentLockOwner()).toBe(false);

    acquireLock();
    expect(isLockHeldLocally()).toBe(true);
    expect(isCurrentLockOwner()).toBe(true);
  });

  it('detects when local ownership has been stolen', async () => {
    const { acquireLock, getInstanceId, isCurrentLockOwner, isLockHeldLocally } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    expect(isCurrentLockOwner()).toBe(true);

    writeFileSync(
      join(tmpDir, '.omp', 'agent', 'slk-bridge.lock'),
      `${process.pid}:someone-else`,
    );

    expect(getInstanceId()).toBe(g.__slkBridgeInstanceId);
    expect(isLockHeldLocally()).toBe(true);
    expect(isCurrentLockOwner()).toBe(false);
  });

  it('reports whether a process is alive', async () => {
    const { isProcessAlive } = await importLock(tmpDir);

    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(1073741824)).toBe(false);
  });

  it('replaces an old unreadable lock record instead of staying locked out forever', async () => {
    const piDir = join(tmpDir, '.omp', 'agent');
    mkdirSync(piDir, { recursive: true });
    const lockFile = join(piDir, 'slk-bridge.lock');
    writeFileSync(lockFile, 'not-a-lock-record');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);

    const { acquireLock } = await importLock(tmpDir);

    expect(acquireLock()).toBe(true);
    expect(readFileSync(lockFile, 'utf-8')).toBe(`${process.pid}:${g.__slkBridgeInstanceId}`);
  });

  // The exclusive create happens before the record is written, so another claimant can see an
  // empty file for a moment. That file is a claim in progress, not garbage to clean up.
  it('leaves a freshly created, still empty lock file to the claimant that is writing it', async () => {
    const piDir = join(tmpDir, '.omp', 'agent');
    mkdirSync(piDir, { recursive: true });
    const lockFile = join(piDir, 'slk-bridge.lock');
    writeFileSync(lockFile, '');

    const { acquireLock } = await importLock(tmpDir);

    expect(acquireLock()).toBe(false);
    expect(g.__slkBridgeConnected).toBeFalsy();
    expect(existsSync(lockFile)).toBe(true);
    expect(readFileSync(lockFile, 'utf-8')).toBe('');
  });

  // Real clock and real processes on purpose: the claim race only exists between OS processes,
  // and fake timers cannot reach them. Many rounds, each with its own lock file and every process
  // firing within the same millisecond, make an unguarded check-then-write fail reliably.
  it('lets exactly one of several simultaneous claimants win, round after round', async () => {
    const modules = join(tmpDir, 'modules');
    buildChildModules(modules, ['session/lock']);
    const worker = join(modules, 'claimant.mjs');
    writeFileSync(worker, `
      import * as path from 'node:path';
      const [base, startAt, rounds, holdUntil] = process.argv.slice(2);
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // One module instance per round, each bound to that round's home directory (its own lock file).
      const claims = [];
      for (let round = 0; round < Number(rounds); round++) {
        process.env.HOME = process.env.USERPROFILE = path.join(base, 'round-' + round);
        claims.push((await import('./session/lock.js?round=' + round)).acquireLock);
      }

      // Sleep until shortly before the first round; only the last stretch is spun for precision.
      await sleep(Math.max(0, Number(startAt) - Date.now() - 50));
      const results = [];
      for (let round = 0; round < claims.length; round++) {
        const roundStart = Number(startAt) + round * 25;
        while (Date.now() < roundStart) { /* spin: every process fires in the same millisecond */ }
        results.push(claims[round]());
      }
      // Stay alive until every process has finished, so a winner's lock cannot look stale mid-race.
      while (Date.now() < Number(holdUntil)) await sleep(5);
      console.log('results:' + JSON.stringify(results));
    `);

    const claimants = 6;
    const rounds = 30;
    const startAt = Date.now() + 3000;
    const holdUntil = startAt + rounds * 25 + 1500;
    const results = await Promise.all(
      Array.from({ length: claimants }, () =>
        runChild(worker, [tmpDir, String(startAt), String(rounds), String(holdUntil)], tmpDir),
      ),
    );

    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
    const claimsByProcess: boolean[][] = results.map((result) => {
      const line = result.stdout.split('\n').find((entry) => entry.startsWith('results:'));
      return JSON.parse(line?.slice('results:'.length) ?? '[]');
    });
    for (let round = 0; round < rounds; round++) {
      const winners = claimsByProcess.filter((claims) => claims[round]).length;
      expect(winners, `round ${round}`).toBe(1);
    }
  }, 60_000);
});
