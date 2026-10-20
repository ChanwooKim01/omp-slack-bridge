/**
 * Where does a message the router receives go? Only a thread reply in another session's thread
 * leaves the router: a live owner gets it through its inbox, a dead one gets a notice, and
 * everything else is handled where it arrived.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as OsModule from 'os';

const ROUTER_SESSION = '/sessions/router.jsonl';
const OTHER_SESSION = '/sessions/other.jsonl';

describe('inbound routing', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'slk-bridge-routing-'));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function importRouting() {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof OsModule>('os');
      return { ...actual, homedir: () => home };
    });
    // Dynamic: the config module reads the home directory at import time, after the mock above.
    return await import('../../src/slack/routing');
  }

  const reply = (threadId: string | undefined, overrides: { content?: string; isThreadReply?: boolean } = {}) => ({
    chatId: 'D123',
    content: overrides.content ?? 'hello',
    threadId,
    isThreadReply: overrides.isThreadReply ?? true,
  });

  describe('decideInboundRoute', () => {
    it('keeps a reply in the router\'s own thread local', async () => {
      const { decideInboundRoute, rememberSlackThreadForSession } = await importRouting();
      rememberSlackThreadForSession('D123', 'T1', ROUTER_SESSION);

      expect(decideInboundRoute(reply('T1'), ROUTER_SESSION, () => true)).toEqual({ kind: 'local' });
    });

    it('hands a reply in another live session\'s thread to that session', async () => {
      const { decideInboundRoute, rememberSlackThreadForSession } = await importRouting();
      rememberSlackThreadForSession('D123', 'T1', OTHER_SESSION);
      const isLive = vi.fn((sessionPath: string) => sessionPath === OTHER_SESSION);

      expect(decideInboundRoute(reply('T1'), ROUTER_SESSION, isLive)).toEqual({ kind: 'inbox', sessionPath: OTHER_SESSION });
      expect(isLive).toHaveBeenCalledWith(OTHER_SESSION);
    });

    it('reports a reply in a thread whose session is not running', async () => {
      const { decideInboundRoute, rememberSlackThreadForSession } = await importRouting();
      rememberSlackThreadForSession('D123', 'T1', OTHER_SESSION);

      expect(decideInboundRoute(reply('T1'), ROUTER_SESSION, () => false)).toEqual({ kind: 'offline', sessionPath: OTHER_SESSION });
    });

    it('handles top-level and unmapped messages locally without asking who is live', async () => {
      const { decideInboundRoute, rememberSlackThreadForSession } = await importRouting();
      rememberSlackThreadForSession('D123', 'T1', OTHER_SESSION);
      const isLive = vi.fn(() => false);

      // Channel top-level message: no thread at all.
      expect(decideInboundRoute(reply(undefined, { isThreadReply: false }), ROUTER_SESSION, isLive)).toEqual({ kind: 'local' });
      // DM top-level message: the message itself roots a new thread, even if that ts collides with a mapped one.
      expect(decideInboundRoute(reply('T1', { isThreadReply: false }), ROUTER_SESSION, isLive)).toEqual({ kind: 'local' });
      // Reply in a thread nobody owns.
      expect(decideInboundRoute(reply('T-unmapped'), ROUTER_SESSION, isLive)).toEqual({ kind: 'local' });
      expect(isLive).not.toHaveBeenCalled();
    });

    it('keeps `.bridge resume` local even in another session\'s thread', async () => {
      const { decideInboundRoute, rememberSlackThreadForSession } = await importRouting();
      rememberSlackThreadForSession('D123', 'T1', OTHER_SESSION);

      for (const content of ['.bridge resume', '  .BRIDGE   resume 3', '.bridge resume list 20']) {
        expect(decideInboundRoute(reply('T1', { content }), ROUTER_SESSION, () => true)).toEqual({ kind: 'local' });
      }
      // Other bridge commands still belong to the thread's session.
      expect(decideInboundRoute(reply('T1', { content: '.bridge status' }), ROUTER_SESSION, () => true)).toEqual({
        kind: 'inbox',
        sessionPath: OTHER_SESSION,
      });
    });

    it('does not mix up the same thread timestamp in different chats', async () => {
      const { decideInboundRoute, rememberSlackThreadForSession } = await importRouting();
      rememberSlackThreadForSession('D123', 'T1', OTHER_SESSION);

      expect(decideInboundRoute({ ...reply('T1'), chatId: 'C999' }, ROUTER_SESSION, () => true)).toEqual({ kind: 'local' });
    });
  });

  describe('thread mapping updates', () => {
    const configFile = () => join(home, '.omp', 'agent', 'slk-bridge.json');

    it('adds to the mapping another process wrote instead of overwriting it', async () => {
      const { rememberSlackThreadForSession, getSlackThreadOwnerSession } = await importRouting();
      rememberSlackThreadForSession('D123', 'T1', ROUTER_SESSION);

      // Another process maps its own thread and changes an unrelated setting.
      const onDisk = JSON.parse(readFileSync(configFile(), 'utf-8'));
      onDisk.slackRouting.threadsByKey['D123:T2'] = { sessionPath: OTHER_SESSION, updatedAt: '2026-10-19T00:00:00.000Z' };
      onDisk.hideToolCalls = true;
      writeFileSync(configFile(), JSON.stringify(onDisk));

      rememberSlackThreadForSession('D123', 'T3', ROUTER_SESSION);

      expect(getSlackThreadOwnerSession('D123', 'T1')).toBe(ROUTER_SESSION);
      expect(getSlackThreadOwnerSession('D123', 'T2')).toBe(OTHER_SESSION);
      expect(getSlackThreadOwnerSession('D123', 'T3')).toBe(ROUTER_SESSION);
      expect(JSON.parse(readFileSync(configFile(), 'utf-8')).hideToolCalls).toBe(true);
    });

    it('remembers a session\'s latest thread per chat', async () => {
      const { rememberSlackThreadForSession, getRememberedSlackThreadForCurrentSession } = await importRouting();
      rememberSlackThreadForSession('D123', 'T1', OTHER_SESSION);
      rememberSlackThreadForSession('D123', 'T2', OTHER_SESSION);

      expect(getRememberedSlackThreadForCurrentSession('D123', () => OTHER_SESSION)).toBe('T2');
      expect(getRememberedSlackThreadForCurrentSession('D999', () => OTHER_SESSION)).toBeUndefined();
    });
  });

  describe('thread title and summary', () => {
    const configFile = () => join(home, '.omp', 'agent', 'slk-bridge.json');

    it('stores a title and summary per thread and merges later updates', async () => {
      const { getSlackThreadMeta, updateSlackThreadMeta } = await importRouting();
      expect(getSlackThreadMeta('D123', 'T1')).toBeUndefined();

      updateSlackThreadMeta('D123', 'T1', { title: '[VLM_Verifier] MoT' });
      updateSlackThreadMeta('D123', 'T1', { summary: '- 결정 하나', summaryTs: '1760000001.000100' });
      // An unset field in a patch keeps what is stored.
      updateSlackThreadMeta('D123', 'T1', { summary: '- 결정 둘', title: undefined });

      expect(getSlackThreadMeta('D123', 'T1')).toMatchObject({
        title: '[VLM_Verifier] MoT',
        summary: '- 결정 둘',
        summaryTs: '1760000001.000100',
      });
      expect(typeof getSlackThreadMeta('D123', 'T1')?.updatedAt).toBe('string');
      expect(getSlackThreadMeta('D123', 'T2')).toBeUndefined();
      expect(getSlackThreadMeta('C999', 'T1')).toBeUndefined();
    });

    it('keeps other threads, the thread mapping and other processes\' changes', async () => {
      const { rememberSlackThreadForSession, updateSlackThreadMeta, getSlackThreadMeta, getSlackThreadOwnerSession } = await importRouting();
      rememberSlackThreadForSession('D123', 'T1', ROUTER_SESSION);
      updateSlackThreadMeta('D123', 'T1', { title: 'one' });

      const onDisk = JSON.parse(readFileSync(configFile(), 'utf-8'));
      onDisk.slackRouting.threadMeta['D123:T2'] = { title: 'written elsewhere', updatedAt: '2026-10-19T00:00:00.000Z' };
      writeFileSync(configFile(), JSON.stringify(onDisk));
      updateSlackThreadMeta('D123', 'T3', { title: 'three' });

      expect(getSlackThreadMeta('D123', 'T1')?.title).toBe('one');
      expect(getSlackThreadMeta('D123', 'T2')?.title).toBe('written elsewhere');
      expect(getSlackThreadMeta('D123', 'T3')?.title).toBe('three');
      expect(getSlackThreadOwnerSession('D123', 'T1')).toBe(ROUTER_SESSION);
    });
  });
});
