import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as OsModule from 'os';
import type { ExternalMessage } from '../../src/types/index';

describe('session inbox', () => {
  let home: string;
  const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');
  const inboxDir = (sessionPath: string) => join(home, '.omp', 'agent', 'slk-bridge-inbox', sha1(sessionPath));

  const message = (overrides: Partial<ExternalMessage> = {}): ExternalMessage => ({
    chatId: 'D123',
    content: 'hello',
    username: 'testuser',
    userId: 'U123',
    timestamp: new Date('2026-10-19T12:00:00.250Z'),
    messageId: '1760000000.000100',
    isGroupChat: false,
    wasMentioned: false,
    threadId: '1760000000.000001',
    isThreadReply: true,
    ...overrides,
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'slk-bridge-inbox-'));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function importInbox() {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof OsModule>('os');
      return { ...actual, homedir: () => home };
    });
    // Dynamic: the module reads the home directory at import time, after the mock above.
    return await import('../../src/session/inbox');
  }

  it('queues one atomic <ts>-<rand>.json file per message under the session\'s hashed directory', async () => {
    const { enqueueInboxMessage } = await importInbox();
    enqueueInboxMessage('/sessions/a.jsonl', message());

    const names = readdirSync(inboxDir('/sessions/a.jsonl'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\d{13}-[a-z0-9]+\.json$/);
    expect(JSON.parse(readFileSync(join(inboxDir('/sessions/a.jsonl'), names[0]), 'utf-8'))).toMatchObject({
      chatId: 'D123',
      content: 'hello',
      messageId: '1760000000.000100',
    });
  });

  it('delivers messages oldest first with timestamps revived to Date, and removes each file', async () => {
    const { enqueueInboxMessage, drainInbox } = await importInbox();
    enqueueInboxMessage('/sessions/a.jsonl', message({ content: 'first', messageId: '1.1' }));
    enqueueInboxMessage('/sessions/a.jsonl', message({ content: 'second', messageId: '1.2' }));
    enqueueInboxMessage('/sessions/a.jsonl', message({ content: 'third', messageId: '1.3' }));

    const delivered = drainInbox('/sessions/a.jsonl');

    expect(delivered.map((entry) => entry.content)).toEqual(['first', 'second', 'third']);
    expect(delivered[0].timestamp).toBeInstanceOf(Date);
    expect(delivered[0].timestamp.toISOString()).toBe('2026-10-19T12:00:00.250Z');
    expect(readdirSync(inboxDir('/sessions/a.jsonl'))).toEqual([]);
    expect(drainInbox('/sessions/a.jsonl')).toEqual([]);
  });

  it('keeps optional fields and drops a thread that was never set', async () => {
    const { enqueueInboxMessage, drainInbox } = await importInbox();
    enqueueInboxMessage('/sessions/a.jsonl', message({ threadId: undefined, isThreadReply: undefined, wasMentioned: true }));

    const [delivered] = drainInbox('/sessions/a.jsonl');

    expect(delivered).toMatchObject({ wasMentioned: true, isGroupChat: false });
    expect(delivered.threadId).toBeUndefined();
  });

  it('keeps each session\'s messages apart', async () => {
    const { enqueueInboxMessage, drainInbox } = await importInbox();
    enqueueInboxMessage('/sessions/a.jsonl', message({ content: 'for a' }));
    enqueueInboxMessage('/sessions/b.jsonl', message({ content: 'for b' }));

    expect(drainInbox('/sessions/a.jsonl').map((entry) => entry.content)).toEqual(['for a']);
    expect(drainInbox('/sessions/b.jsonl').map((entry) => entry.content)).toEqual(['for b']);
  });

  it('returns nothing for a session that never received a message', async () => {
    const { drainInbox } = await importInbox();
    expect(drainInbox('/sessions/never.jsonl')).toEqual([]);
  });

  it('ignores a file that is still being written', async () => {
    const { enqueueInboxMessage, drainInbox } = await importInbox();
    enqueueInboxMessage('/sessions/a.jsonl', message({ content: 'complete' }));
    writeFileSync(join(inboxDir('/sessions/a.jsonl'), '0000000000001-pending.json.123.abc.tmp'), '{"half');

    expect(drainInbox('/sessions/a.jsonl').map((entry) => entry.content)).toEqual(['complete']);
    expect(readdirSync(inboxDir('/sessions/a.jsonl'))).toEqual(['0000000000001-pending.json.123.abc.tmp']);
  });

  it('drops messages that are too old to act on, and malformed files', async () => {
    const { enqueueInboxMessage, drainInbox, INBOX_MAX_AGE_MS } = await importInbox();
    enqueueInboxMessage('/sessions/a.jsonl', message({ content: 'stale' }));
    writeFileSync(join(inboxDir('/sessions/a.jsonl'), `${String(Date.now() + 1).padStart(13, '0')}-broken.json`), '{not json');
    writeFileSync(join(inboxDir('/sessions/a.jsonl'), `${String(Date.now() + 2).padStart(13, '0')}-shape.json`), JSON.stringify({ hello: 'world' }));

    expect(drainInbox('/sessions/a.jsonl', Date.now() + INBOX_MAX_AGE_MS + 5_000)).toEqual([]);
    expect(readdirSync(inboxDir('/sessions/a.jsonl'))).toEqual([]);
  });

  it('clears everything pending when the session leaves', async () => {
    const { enqueueInboxMessage, clearInbox, drainInbox } = await importInbox();
    enqueueInboxMessage('/sessions/a.jsonl', message());

    clearInbox('/sessions/a.jsonl');

    expect(existsSync(inboxDir('/sessions/a.jsonl'))).toBe(false);
    expect(drainInbox('/sessions/a.jsonl')).toEqual([]);
    expect(() => clearInbox('/sessions/a.jsonl')).not.toThrow();
  });
});
