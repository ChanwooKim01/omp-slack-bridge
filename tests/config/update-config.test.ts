/**
 * updateConfig is the only way the bridge writes slk-bridge.json. Several omp processes share that
 * file, so these tests check what protects it: a cross-process lock, a re-read under the lock,
 * atomic replacement, and refusing to write over a file it could not parse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as FsModule from 'fs';
import type * as OsModule from 'os';
import type * as AtomicWriteModule from '../../src/util/atomic-write';
import { buildChildModules, runChild, startChild } from '../helpers/child-process';

// Runs in separate OS processes started by the tests below. Their clock is real on purpose: fake
// timers cannot reach another process, and the point is real contention for the real lock file.
const WORKER = `
import * as fs from 'node:fs';
import * as path from 'node:path';
const { updateConfig } = await import('./config/index.js');
const [mode, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === 'increment') {
  const [key, count, startAt] = args;
  while (Date.now() < Number(startAt)) await sleep(1);
  for (let i = 0; i < Number(count); i++) {
    updateConfig((config) => {
      config.counters = config.counters ?? {};
      config.counters[key] = (config.counters[key] ?? 0) + 1;
      config.total = (config.total ?? 0) + 1;
    });
  }
} else if (mode === 'hold-lock') {
  const [lockPath, holdMs] = args;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'holder:1', { flag: 'wx' });
  console.log('locked');
  await sleep(Number(holdMs));
  fs.unlinkSync(lockPath);
}
`;

describe('updateConfig', () => {
  let home: string;
  const originalEnv = { ...process.env };

  const agentDir = () => join(home, '.omp', 'agent');
  const configFile = () => join(agentDir(), 'slk-bridge.json');
  const lockFile = () => `${configFile()}.lock`;
  const readStored = () => JSON.parse(readFileSync(configFile(), 'utf-8'));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'slk-bridge-update-config-'));
    delete process.env.PI_SLACK_BOT_TOKEN;
    delete process.env.PI_SLACK_APP_TOKEN;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(home, { recursive: true, force: true });
  });

  async function importConfig() {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof OsModule>('os');
      return { ...actual, homedir: () => home };
    });
    // Dynamic: the module reads the home directory at import time, after the mock above.
    return await import('../../src/config/index');
  }

  function seed(contents: string) {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(configFile(), contents);
  }

  it('applies the mutator to what is on disk and returns the stored config', async () => {
    seed(JSON.stringify({ autoConnect: false, joinedSessions: ['/s/a'] }));
    const { updateConfig } = await importConfig();

    const stored = updateConfig((config) => {
      config.joinedSessions = [...(config.joinedSessions ?? []), '/s/b'];
    });

    expect(stored).toEqual({ autoConnect: false, joinedSessions: ['/s/a', '/s/b'] });
    expect(readStored()).toEqual(stored);
  });

  it('re-reads the file for every update, so another writer\'s changes survive', async () => {
    seed(JSON.stringify({ autoConnect: false }));
    const { updateConfig } = await importConfig();
    updateConfig((config) => {
      config.hideToolCalls = true;
    });

    // Another process edits the file between this process's two updates.
    writeFileSync(configFile(), JSON.stringify({ ...readStored(), showWidget: false }));
    updateConfig((config) => {
      config.debug = true;
    });

    expect(readStored()).toEqual({ autoConnect: false, hideToolCalls: true, showWidget: false, debug: true });
  });

  it('leaves no lock or temp file behind', async () => {
    const { updateConfig } = await importConfig();
    updateConfig((config) => {
      config.autoConnect = true;
    });

    expect(readdirSync(agentDir())).toEqual(['slk-bridge.json']);
  });

  it('does not create or rewrite the file when the mutator changes nothing', async () => {
    const { updateConfig } = await importConfig();
    updateConfig(() => {});
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(lockFile())).toBe(false);
  });

  describe('when the file cannot be parsed', () => {
    it.each([
      ['truncated JSON', '{"slack": {"botToken": "xoxb-secret", '],
      ['an empty file', ''],
      ['a JSON array', '[1, 2]'],
      ['JSON null', 'null'],
    ])('refuses to write over %s and keeps the bytes', async (_label, contents) => {
      seed(contents);
      const { updateConfig } = await importConfig();
      const mutator = vi.fn();

      expect(() => updateConfig(mutator)).toThrow('Refusing to overwrite');

      expect(mutator).not.toHaveBeenCalled();
      expect(readFileSync(configFile(), 'utf-8')).toBe(contents);
      expect(existsSync(lockFile())).toBe(false);
    });
  });

  it('never writes env-provided tokens into the file', async () => {
    seed(JSON.stringify({ autoConnect: false }));
    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-env';
    process.env.PI_SLACK_APP_TOKEN = 'xapp-env';
    const { loadConfig, updateConfig } = await importConfig();
    expect(loadConfig().slack?.botToken).toBe('xoxb-env');

    updateConfig((config) => {
      config.hideToolCalls = true;
    });

    expect(readStored()).toEqual({ autoConnect: false, hideToolCalls: true });
  });

  it('writes nothing and releases the lock when the mutator throws', async () => {
    seed(JSON.stringify({ autoConnect: false }));
    const { updateConfig } = await importConfig();

    expect(() =>
      updateConfig((config) => {
        config.autoConnect = true;
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(readStored()).toEqual({ autoConnect: false });
    expect(existsSync(lockFile())).toBe(false);
    updateConfig((config) => {
      config.autoConnect = true;
    });
    expect(readStored()).toEqual({ autoConnect: true });
  });

  it('rejects a nested update instead of deadlocking on its own lock', async () => {
    const { updateConfig } = await importConfig();
    expect(() =>
      updateConfig(() => {
        updateConfig(() => {});
      }),
    ).toThrow('not re-entrant');
    expect(existsSync(lockFile())).toBe(false);
  });

  it('breaks a lock left behind by a crashed writer', async () => {
    seed(JSON.stringify({ autoConnect: false }));
    writeFileSync(lockFile(), 'dead-writer:1');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(), old, old);
    const { updateConfig } = await importConfig();

    updateConfig((config) => {
      config.autoConnect = true;
    });

    expect(readStored()).toEqual({ autoConnect: true });
    expect(existsSync(lockFile())).toBe(false);
  });

  // A stale lock that cannot be deleted (read-only or ACL-protected file, a handle held open) has to
  // be waited on like any other contention. It used to retry forever without ever reaching the
  // deadline, freezing the host's event loop. The waits run on a fake clock so the 8 s deadline is instant.
  it('gives up with a timeout when a stale lock cannot be removed', async () => {
    seed(JSON.stringify({ autoConnect: false }));
    writeFileSync(lockFile(), 'stuck-writer:1');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(), old, old);

    let lockOpenAttempts = 0;
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs');
      return {
        ...actual,
        openSync: (target: string, flags?: string, mode?: number) => {
          // Fail fast instead of hanging the run if acquisition never reaches its deadline.
          if (String(target).endsWith('.lock') && ++lockOpenAttempts > 10_000) {
            throw new Error('lock acquisition retried without a deadline');
          }
          return actual.openSync(target, flags, mode);
        },
        unlinkSync: (target: string) => {
          if (String(target).endsWith('.lock')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
          return actual.unlinkSync(target);
        },
      };
    });
    vi.doMock('../../src/util/atomic-write', async (importOriginal) => ({
      ...(await importOriginal<typeof AtomicWriteModule>()),
      sleepSync: (ms: number) => {
        vi.setSystemTime(Date.now() + ms);
      },
    }));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { updateConfig } = await importConfig();
      const mutator = vi.fn();

      expect(() => updateConfig(mutator)).toThrow('Timed out waiting for the slk-bridge config lock');
      expect(mutator).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.doUnmock('fs');
      vi.doUnmock('../../src/util/atomic-write');
    }

    expect(readStored()).toEqual({ autoConnect: false });
  });

  describe('across processes', () => {
    let modules: string;
    let worker: string;

    beforeEach(() => {
      modules = join(home, 'modules');
      buildChildModules(modules, ['config/index', 'util/atomic-write']);
      worker = join(modules, 'worker.mjs');
      writeFileSync(worker, WORKER);
    });

    it('waits while another process holds the lock, then applies the update', async () => {
      const holder = startChild(worker, ['hold-lock', lockFile(), '400'], home);
      await holder.waitForOutput('locked');
      const { updateConfig } = await importConfig();

      const startedAt = Date.now();
      updateConfig((config) => {
        config.autoConnect = true;
      });
      const waited = Date.now() - startedAt;

      expect((await holder.result).code).toBe(0);
      expect(waited).toBeGreaterThanOrEqual(150);
      expect(readStored()).toEqual({ autoConnect: true });
    }, 30_000);

    it('loses no update when many processes write at once', async () => {
      const processes = 6;
      const updatesEach = 20;
      const startAt = Date.now() + 1500;

      const results = await Promise.all(
        Array.from({ length: processes }, (_, index) =>
          runChild(worker, ['increment', `p${index}`, String(updatesEach), String(startAt)], home),
        ),
      );

      for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
      const stored = readStored();
      expect(stored.total).toBe(processes * updatesEach);
      expect(stored.counters).toEqual(
        Object.fromEntries(Array.from({ length: processes }, (_, index) => [`p${index}`, updatesEach])),
      );
      expect(readdirSync(agentDir()).filter((name) => name !== 'modules')).toEqual(['slk-bridge.json']);
    }, 60_000);
  });
});
