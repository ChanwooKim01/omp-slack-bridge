import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadStream, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Fail-fast guard for Socket Mode connect.
 *
 * The underlying @slack/socket-mode client retries `apps.connections.open`
 * with exponential backoff (retries: 100, factor: 1.3, maxTimeout: Infinity),
 * so an unreachable Slack can otherwise block connect() — and anything that
 * awaits it (e.g. the extension's session_start) — for a very long time.
 * These tests verify connect() rejects with a timeout instead of hanging.
 */

// Minimal ChallengeAuth stub — the client only stores it, never calls it in connect().
const stubAuth = {} as any;

// A fake @slack/bolt App whose start() never resolves (simulates an unreachable
// Slack socket). stop() resolves so abortPartialConnect can tear down cleanly.
class HangingApp {
  client = { auth: { test: async () => ({ user_id: 'U123' }) } };
  message() {}
  error() {}
  start() {
    return new Promise(() => {}); // never settles
  }
  async stop() {}
}

// A working App whose start() resolves immediately.
class WorkingApp {
  client = { auth: { test: async () => ({ user_id: 'U123' }) } };
  message() {}
  error() {}
  async start() {}
  async stop() {}
}

let boltMock: any;
let useHangingApp = true;

// A constructor that can be invoked with `new` (as the client does: new App(...))
// and that returns an app instance based on the current mode.
class MockApp {
  constructor() {
    return useHangingApp ? new HangingApp() : new WorkingApp();
  }
}

beforeEach(() => {
  useHangingApp = true;
  boltMock = {
    App: MockApp,
    LogLevel: { ERROR: 0 },
  };
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

async function importClient() {
  vi.doMock('@slack/bolt', () => boltMock);
  return await import('../../src/slack/client');
}

describe('SlackClient.connect timeout', () => {
  it('rejects with a timeout when the socket connect hangs', async () => {
    const { SlackClient } = await importClient();
    const client = new SlackClient(
      { botToken: 'xoxb-test', appToken: 'xapp-test' },
      stubAuth,
      50, // tiny timeout for a fast test
    );

    await expect(client.connect()).rejects.toThrow('Slack connection timed out');
    expect(client.isConnected).toBe(false);
  });

  it('resolves normally when the socket connects within the timeout', async () => {
    useHangingApp = false;
    const { SlackClient } = await importClient();
    const client = new SlackClient(
      { botToken: 'xoxb-test', appToken: 'xapp-test' },
      stubAuth,
      500,
    );

    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.isConnected).toBe(true);
  });

  it('can reconnect after a timeout (partial state is torn down)', async () => {
    const { SlackClient } = await importClient();
    const client = new SlackClient(
      { botToken: 'xoxb-test', appToken: 'xapp-test' },
      stubAuth,
      50,
    );

    await expect(client.connect()).rejects.toThrow('Slack connection timed out');

    // Now the socket "comes back" — a fresh connect should succeed.
    useHangingApp = false;
    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.isConnected).toBe(true);
  });
});

/**
 * Only the router holds the Socket Mode connection, but every joined session must be able to
 * post. These tests never call connect(): posting, reactions and uploads work from the bot token alone.
 */
describe('SlackClient without a socket', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slk-bridge-client-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importClientWithWebApi() {
    const api = {
      constructedWith: [] as string[],
      postMessage: vi.fn(async (_args: Record<string, unknown>) => ({ ts: '111.222' })),
      addReaction: vi.fn(async (_args: Record<string, unknown>) => ({})),
      removeReaction: vi.fn(async (_args: Record<string, unknown>) => ({})),
      // Like the real client, read the stream to the end so the file is released before cleanup.
      uploadV2: vi.fn(async (args: Record<string, unknown>) => {
        if (args.file instanceof ReadStream) {
          for await (const _chunk of args.file) {
            // drain
          }
        }
        return {};
      }),
    };
    class FakeWebClient {
      chat = { postMessage: api.postMessage };
      reactions = { add: api.addReaction, remove: api.removeReaction };
      files = { uploadV2: api.uploadV2 };
      constructor(token: string) {
        api.constructedWith.push(token);
      }
    }
    vi.doMock('@slack/web-api', () => ({ WebClient: FakeWebClient, LogLevel: { ERROR: 'error' } }));
    // Dynamic: the mock above must be in place before the client module loads.
    const { SlackClient } = await import('../../src/slack/client');
    return { api, client: new SlackClient({ botToken: 'xoxb-bot', appToken: 'xapp-app' }, stubAuth) };
  }

  it('posts into a thread with the bot token alone', async () => {
    const { api, client } = await importClientWithWebApi();
    const onPosted = vi.fn();

    const rootTs = await client.sendMessageInThread('D1', 'hello', undefined, 'my footer', onPosted);
    const replyTs = await client.sendMessageInThread('D1', 'again', rootTs);

    expect(rootTs).toBe('111.222');
    expect(replyTs).toBe('111.222');
    expect(onPosted).toHaveBeenCalledWith('111.222');
    expect(api.constructedWith).toEqual(['xoxb-bot']);
    expect(api.postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ channel: 'D1', text: 'hello', thread_ts: undefined }));
    expect(api.postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ channel: 'D1', text: 'again', thread_ts: '111.222' }));
    const firstBlocks = api.postMessage.mock.calls[0][0].blocks as Array<{ type: string }>;
    expect(firstBlocks.at(-1)).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: 'my footer' }] });
    expect(client.isConnected).toBe(false);
  });

  it('adds and removes a reaction, treating "already there" and "already gone" as success', async () => {
    const { api, client } = await importClientWithWebApi();
    api.addReaction.mockRejectedValueOnce({ data: { error: 'already_reacted' } });
    api.removeReaction.mockRejectedValueOnce({ data: { error: 'no_reaction' } });

    await client.addReaction('D1', '111.222', 'hourglass_flowing_sand');
    await client.removeReaction('D1', '111.222', 'hourglass_flowing_sand');

    expect(api.addReaction).toHaveBeenCalledWith({ channel: 'D1', timestamp: '111.222', name: 'hourglass_flowing_sand' });
    expect(api.removeReaction).toHaveBeenCalledWith({ channel: 'D1', timestamp: '111.222', name: 'hourglass_flowing_sand' });

    api.addReaction.mockRejectedValueOnce({ data: { error: 'channel_not_found' } });
    await expect(client.addReaction('D1', '111.222', 'eyes')).rejects.toThrow('channel_not_found');
    expect(client.isConnected).toBe(false);
  });

  it('uploads a file into a thread', async () => {
    const { api, client } = await importClientWithWebApi();
    const file = join(tmpDir, 'report.txt');
    writeFileSync(file, 'contents');

    await client.sendFile('D1', file, { title: 'Report', initialComment: 'see attached', threadId: '111.222' });

    expect(api.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: 'D1', filename: 'report.txt', title: 'Report', initial_comment: 'see attached', thread_ts: '111.222' }),
    );
    expect(client.isConnected).toBe(false);
  });

  it('refuses to post without a bot token', async () => {
    await importClientWithWebApi();
    const { SlackClient } = await import('../../src/slack/client');
    const client = new SlackClient({ botToken: '', appToken: 'xapp-app' }, stubAuth);

    await expect(client.sendMessageInThread('D1', 'hello')).rejects.toThrow('Slack bot token is not configured');
  });
});
