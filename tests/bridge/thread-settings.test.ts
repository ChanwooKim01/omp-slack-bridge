/**
 * How many recent interactions a thread keeps, and when it is pruned: defaults, the limits, and
 * the `keep` / `pruneat` commands that change them (global, stored in slk-bridge.json).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as OsModule from 'os';

describe('thread pruning settings', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'slk-bridge-settings-'));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function importSettings() {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof OsModule>('os');
      return { ...actual, homedir: () => home };
    });
    // Dynamic: the config module reads the home directory at import time, after the mock above.
    return await import('../../src/bridge/thread-settings');
  }
  const stored = () => JSON.parse(readFileSync(join(home, '.omp', 'agent', 'slk-bridge.json'), 'utf-8'));

  describe('resolvePruneSettings', () => {
    it('keeps 5 interactions and prunes at 10 by default', async () => {
      const { resolvePruneSettings } = await importSettings();
      expect(resolvePruneSettings({})).toEqual({ keep: 5, pruneAt: 10 });
    });

    it('prunes at twice the stored keep unless a threshold is stored', async () => {
      const { resolvePruneSettings } = await importSettings();
      expect(resolvePruneSettings({ threadKeep: 3 })).toEqual({ keep: 3, pruneAt: 6 });
      expect(resolvePruneSettings({ threadKeep: 3, threadPruneAt: 9 })).toEqual({ keep: 3, pruneAt: 9 });
    });

    it('ignores stored values that are out of range or not whole numbers', async () => {
      const { resolvePruneSettings } = await importSettings();
      expect(resolvePruneSettings({ threadKeep: 0 })).toEqual({ keep: 5, pruneAt: 10 });
      expect(resolvePruneSettings({ threadKeep: 51 })).toEqual({ keep: 5, pruneAt: 10 });
      expect(resolvePruneSettings({ threadKeep: 2.5 })).toEqual({ keep: 5, pruneAt: 10 });
      // A threshold must exceed `keep`: otherwise nothing could ever be pruned.
      expect(resolvePruneSettings({ threadKeep: 4, threadPruneAt: 4 })).toEqual({ keep: 4, pruneAt: 8 });
      expect(resolvePruneSettings({ threadKeep: 4, threadPruneAt: 1000 })).toEqual({ keep: 4, pruneAt: 8 });
    });

    it('defaults the threshold to max(2N, N+1)', async () => {
      const { defaultPruneAt } = await importSettings();
      expect([1, 2, 5, 50].map(defaultPruneAt)).toEqual([2, 4, 10, 100]);
    });
  });

  describe('keep', () => {
    it('stores the number and moves the threshold to twice that', async () => {
      const { runKeepCommand, resolvePruneSettings } = await importSettings();

      const reply = runKeepCommand('3', '.bridge');

      expect(reply.ok).toBe(true);
      expect(reply.text).toContain('3개');
      expect(reply.text).toContain('6개');
      expect(stored()).toMatchObject({ threadKeep: 3, threadPruneAt: 6 });
      expect(resolvePruneSettings(stored())).toEqual({ keep: 3, pruneAt: 6 });
    });

    it.each(['0', '51', '-2', 'abc', '2.5', '1e1'])('refuses %s and changes nothing', async (arg) => {
      const { runKeepCommand } = await importSettings();
      runKeepCommand('4', '.bridge');

      const reply = runKeepCommand(arg, '.bridge');

      expect(reply.ok).toBe(false);
      expect(reply.text).toContain('.bridge keep');
      expect(stored()).toMatchObject({ threadKeep: 4, threadPruneAt: 8 });
    });

    it('accepts the limits 1 and 50', async () => {
      const { runKeepCommand } = await importSettings();
      expect(runKeepCommand('1', '.bridge').ok).toBe(true);
      expect(stored()).toMatchObject({ threadKeep: 1, threadPruneAt: 2 });
      expect(runKeepCommand('50', '.bridge').ok).toBe(true);
      expect(stored()).toMatchObject({ threadKeep: 50, threadPruneAt: 100 });
    });

    it('without an argument shows the current settings and writes nothing', async () => {
      const { runKeepCommand } = await importSettings();

      const reply = runKeepCommand('', '/slk-bridge');

      expect(reply.ok).toBe(true);
      expect(reply.text).toContain('5개');
      expect(reply.text).toContain('10개');
      expect(reply.text).toContain('/slk-bridge keep');
      expect(() => stored()).toThrow();
    });
  });

  describe('pruneat', () => {
    it('stores a threshold above keep', async () => {
      const { runKeepCommand, runPruneAtCommand, resolvePruneSettings } = await importSettings();
      runKeepCommand('3', '.bridge');

      const reply = runPruneAtCommand('12', '.bridge');

      expect(reply.ok).toBe(true);
      expect(resolvePruneSettings(stored())).toEqual({ keep: 3, pruneAt: 12 });
    });

    it('refuses a threshold that is not above keep, or not a number, and changes nothing', async () => {
      const { runKeepCommand, runPruneAtCommand } = await importSettings();
      runKeepCommand('3', '.bridge');

      for (const arg of ['3', '2', '0', 'many', '501']) {
        const reply = runPruneAtCommand(arg, '.bridge');
        expect(reply.ok, arg).toBe(false);
        expect(reply.text, arg).toContain('남길 대화 수(3)');
      }
      expect(stored()).toMatchObject({ threadKeep: 3, threadPruneAt: 6 });
    });

    it('is reset to twice keep when keep changes afterwards', async () => {
      const { runKeepCommand, runPruneAtCommand } = await importSettings();
      runPruneAtCommand('30', '.bridge');
      expect(stored().threadPruneAt).toBe(30);

      runKeepCommand('4', '.bridge');

      expect(stored()).toMatchObject({ threadKeep: 4, threadPruneAt: 8 });
    });
  });

  describe('looksLikeUserToken', () => {
    it('accepts user tokens and refuses bot and app tokens', async () => {
      const { looksLikeUserToken } = await importSettings();
      expect(looksLikeUserToken('xoxp-1-abc')).toBe(true);
      expect(looksLikeUserToken('xoxe.xoxp-1-abc')).toBe(true);
      expect(looksLikeUserToken('xoxb-1-abc')).toBe(false);
      expect(looksLikeUserToken('xapp-1-abc')).toBe(false);
      expect(looksLikeUserToken('')).toBe(false);
    });
  });
});
