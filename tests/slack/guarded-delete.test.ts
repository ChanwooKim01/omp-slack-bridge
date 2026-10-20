/**
 * The Slack user token can delete the user's messages anywhere in the workspace, so the code
 * around it must not. These tests drive the guarded deleter with a fake token backend and assert
 * what reaches Slack: only a reply of the given thread, in the paired DM, written by the token's
 * own identity. Everything else is refused before any request is sent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  type DeleteBackend,
  type DeleteRefusalReason,
  DeletePacer,
  type SlackIdentity,
  createGuardedDeleter,
} from '../../src/slack/guarded-delete';

const PAIRED = 'D0PAIRED01';
const OTHER_DM = 'D0OTHERDM9';
const THREAD = '1760000000.000100';
const REPLY = '1760000001.000200';
const TRUSTED = 'U0TRUSTED1';
const BOT = 'U0BOTUSER1';
const BOT_ID = 'B0BOTID001';

/** A pacer that never waits, for tests that are not about pacing. */
const instantPacer = () => new DeletePacer(0, async () => {}, () => 0);

function fakeBackend(self: SlackIdentity) {
  const removed: Array<{ channel: string; ts: string }> = [];
  const backend: DeleteBackend = {
    whoAmI: vi.fn(async () => self),
    deleteMessage: vi.fn(async (channel: string, ts: string) => {
      removed.push({ channel, ts });
    }),
  };
  return { backend, removed };
}

function userDeleter(self: SlackIdentity = { userId: TRUSTED }, overrides: { paired?: string | undefined; trusted?: string | undefined } = {}) {
  const { backend, removed } = fakeBackend(self);
  const deleter = createGuardedDeleter({
    identity: 'user',
    backend,
    getPairedChatId: () => ('paired' in overrides ? overrides.paired : PAIRED),
    getTrustedUserId: () => ('trusted' in overrides ? overrides.trusted : TRUSTED),
    pacer: instantPacer(),
  });
  return { backend, removed, deleter };
}

const reply = (overrides: Record<string, unknown> = {}) => ({ ts: REPLY, user: TRUSTED, thread_ts: THREAD, ...overrides });

describe('guarded deleter: the user token', () => {
  it('deletes the trusted user\'s own reply in the paired DM thread', async () => {
    const { deleter, removed } = userDeleter();

    await expect(deleter.deleteThreadMessage({ channel: PAIRED, threadTs: THREAD, message: reply() })).resolves.toBe('deleted');

    expect(removed).toEqual([{ channel: PAIRED, ts: REPLY }]);
  });

  const refusals: Array<{
    name: string;
    reason: DeleteRefusalReason;
    /** Refused from the request alone, before the token's identity is even looked up. */
    needsNoLookup: boolean;
    run: () => ReturnType<ReturnType<typeof userDeleter>['deleter']['deleteThreadMessage']>;
    removed: () => unknown[];
    lookups: () => number;
  }> = [];
  function refusal(
    name: string,
    reason: DeleteRefusalReason,
    needsNoLookup: boolean,
    request: { channel?: string; threadTs?: string; message?: Record<string, unknown> },
    setup: Parameters<typeof userDeleter> = [],
  ) {
    const { deleter, removed, backend } = userDeleter(...setup);
    refusals.push({
      name,
      reason,
      needsNoLookup,
      run: () =>
        deleter.deleteThreadMessage({
          channel: request.channel ?? PAIRED,
          threadTs: request.threadTs ?? THREAD,
          message: { ...reply(), ...(request.message ?? {}) },
        }),
      removed: () => removed,
      lookups: () => (backend.whoAmI as ReturnType<typeof vi.fn>).mock.calls.length,
    });
  }

  refusal('a channel that is not the paired DM', 'wrong-channel', true, { channel: OTHER_DM });
  refusal('a DM whose id is not the paired one even when the thread matches', 'wrong-channel', true, { channel: 'C0PUBLIC01' });
  refusal('any channel when no DM is paired', 'no-paired-chat', true, {}, [{ userId: TRUSTED }, { paired: undefined }]);
  refusal('a paired chat that is not a DM', 'not-a-dm', true, { channel: 'C0PUBLIC01' }, [{ userId: TRUSTED }, { paired: 'C0PUBLIC01' }]);
  refusal('the thread root', 'root-message', true, { message: { ts: THREAD, thread_ts: THREAD } });
  refusal('a reply of another thread', 'foreign-thread', true, { message: { thread_ts: '1759999999.000100' } });
  refusal('a top-level DM message (no thread at all)', 'foreign-thread', true, { message: { thread_ts: undefined } });
  refusal('a malformed timestamp', 'bad-timestamp', true, { message: { ts: 'not-a-ts' } });
  refusal('a message written by someone else', 'wrong-author', false, { message: { user: 'U0SOMEONE9' } });
  refusal('a bot message', 'wrong-author', false, { message: { user: BOT, bot_id: BOT_ID } });
  refusal('a message with a bot id even when it names the user', 'wrong-author', false, { message: { bot_id: BOT_ID } });
  refusal('a token that belongs to another Slack user', 'wrong-user', false, { message: { user: 'U0SOMEONE9' } }, [{ userId: 'U0SOMEONE9' }]);
  refusal('any message when no trusted user is configured', 'no-trusted-user', false, {}, [{ userId: TRUSTED }, { trusted: undefined }]);

  it.each(refusals.map((entry) => [entry.name, entry] as const))('refuses %s and sends nothing', async (_name, entry) => {
    await expect(entry.run()).rejects.toMatchObject({ name: 'DeleteRefusedError', reason: entry.reason });
    expect(entry.removed()).toEqual([]);
    if (entry.needsNoLookup) expect(entry.lookups()).toBe(0);
  });

  it('reads the paired DM at every call, so a change of pairing takes effect at once', async () => {
    let paired = PAIRED;
    const { backend, removed } = fakeBackend({ userId: TRUSTED });
    const deleter = createGuardedDeleter({
      identity: 'user',
      backend,
      getPairedChatId: () => paired,
      getTrustedUserId: () => TRUSTED,
      pacer: instantPacer(),
    });
    await deleter.deleteThreadMessage({ channel: PAIRED, threadTs: THREAD, message: reply() });

    paired = OTHER_DM;
    await expect(deleter.deleteThreadMessage({ channel: PAIRED, threadTs: THREAD, message: reply({ ts: '1760000002.000300' }) })).rejects.toMatchObject({
      reason: 'wrong-channel',
    });
    expect(removed).toHaveLength(1);
  });

  it('looks up its identity once', async () => {
    const { deleter, backend } = userDeleter();
    await deleter.deleteThreadMessage({ channel: PAIRED, threadTs: THREAD, message: reply() });
    await deleter.deleteThreadMessage({ channel: PAIRED, threadTs: THREAD, message: reply({ ts: '1760000002.000300' }) });

    expect(backend.whoAmI).toHaveBeenCalledTimes(1);
  });
});

describe('guarded deleter: the bot token', () => {
  function botDeleter() {
    const { backend, removed } = fakeBackend({ userId: BOT, botId: BOT_ID });
    const deleter = createGuardedDeleter({
      identity: 'bot',
      backend,
      getPairedChatId: () => PAIRED,
      getTrustedUserId: () => TRUSTED,
      pacer: instantPacer(),
    });
    return { deleter, removed };
  }

  it('deletes the bot\'s own replies in the paired DM thread, found by user id or by bot id', async () => {
    const { deleter, removed } = botDeleter();

    await deleter.deleteThreadMessage({ channel: PAIRED, threadTs: THREAD, message: { ts: REPLY, user: BOT, bot_id: BOT_ID, thread_ts: THREAD } });
    await deleter.deleteThreadMessage({ channel: PAIRED, threadTs: THREAD, message: { ts: '1760000002.000300', bot_id: BOT_ID, thread_ts: THREAD } });

    expect(removed.map((entry) => entry.ts)).toEqual([REPLY, '1760000002.000300']);
  });

  it('refuses the user\'s messages, other bots\' messages, the root, other channels and other threads', async () => {
    const { deleter, removed } = botDeleter();
    const own = { ts: REPLY, user: BOT, bot_id: BOT_ID, thread_ts: THREAD };
    const attempts = [
      { channel: PAIRED, threadTs: THREAD, message: { ...own, user: TRUSTED, bot_id: undefined } },
      { channel: PAIRED, threadTs: THREAD, message: { ...own, user: 'U0OTHERBOT', bot_id: 'B0OTHER001' } },
      { channel: PAIRED, threadTs: THREAD, message: { ...own, ts: THREAD } },
      { channel: OTHER_DM, threadTs: THREAD, message: own },
      { channel: PAIRED, threadTs: THREAD, message: { ...own, thread_ts: '1759999999.000100' } },
    ];
    for (const attempt of attempts) {
      await expect(deleter.deleteThreadMessage(attempt)).rejects.toMatchObject({ name: 'DeleteRefusedError' });
    }
    expect(removed).toEqual([]);
  });
});

describe('guarded deleter: checking the token up front', () => {
  it('accepts the trusted user\'s token', async () => {
    const { deleter, removed } = userDeleter();

    await expect(deleter.preflight()).resolves.toBeUndefined();
    expect(removed).toEqual([]);
  });

  it('refuses a token of another Slack user, and a setup without a trusted user or a paired DM', async () => {
    await expect(userDeleter({ userId: 'U0SOMEONE9' }).deleter.preflight()).rejects.toMatchObject({ reason: 'wrong-user' });
    await expect(userDeleter({ userId: TRUSTED }, { trusted: undefined }).deleter.preflight()).rejects.toMatchObject({ reason: 'no-trusted-user' });
    await expect(userDeleter({ userId: TRUSTED }, { paired: undefined }).deleter.preflight()).rejects.toMatchObject({ reason: 'no-paired-chat' });
  });

  it('reports a token Slack rejects by Slack\'s code, and asks again next time instead of remembering the failure', async () => {
    const whoAmI = vi
      .fn<DeleteBackend['whoAmI']>()
      .mockRejectedValueOnce({ data: { error: 'invalid_auth' } })
      .mockResolvedValue({ userId: TRUSTED });
    const deleter = createGuardedDeleter({
      identity: 'user',
      backend: { whoAmI, deleteMessage: async () => {} },
      getPairedChatId: () => PAIRED,
      getTrustedUserId: () => TRUSTED,
      pacer: instantPacer(),
    });

    await expect(deleter.preflight()).rejects.toMatchObject({ name: 'DeleteFailedError', code: 'invalid_auth' });
    await expect(deleter.preflight()).resolves.toBeUndefined();
  });

  it('has nothing to check for the bot token beyond a paired DM', async () => {
    const { backend } = fakeBackend({ userId: BOT, botId: BOT_ID });
    const deleter = createGuardedDeleter({
      identity: 'bot',
      backend,
      getPairedChatId: () => PAIRED,
      getTrustedUserId: () => undefined,
      pacer: instantPacer(),
    });

    await expect(deleter.preflight()).resolves.toBeUndefined();
  });
});

describe('guarded deleter: checks again right before every request', () => {
  /** A user-token deleter whose waits run `duringWait`, standing in for the seconds a real wait takes. */
  function deleterWithWaits(duringWait: (ms: number) => void, remove?: DeleteBackend['deleteMessage']) {
    let clock = 0;
    const events: string[] = [];
    const removed: string[] = [];
    const state = { paired: PAIRED as string | undefined, trusted: TRUSTED as string | undefined };
    const pacer = new DeletePacer(
      1_000,
      async (ms) => {
        events.push('wait');
        duringWait(ms);
        clock += ms;
      },
      () => clock,
    );
    const backend: DeleteBackend = {
      whoAmI: async () => ({ userId: TRUSTED }),
      deleteMessage:
        remove ??
        (async (_channel, ts) => {
          events.push('send');
          removed.push(ts);
        }),
    };
    const deleter = createGuardedDeleter({
      identity: 'user',
      backend,
      getPairedChatId: () => state.paired,
      getTrustedUserId: () => state.trusted,
      pacer,
    });
    return { deleter, removed, events, state };
  }
  const request = (ts: string, extra: Record<string, unknown> = {}) => ({ channel: PAIRED, threadTs: THREAD, message: reply({ ts }), ...extra });

  it('refuses a deletion whose pairing changed while it waited for its turn', async () => {
    let change = () => {};
    const { deleter, removed, state } = deleterWithWaits(() => change());
    await deleter.deleteThreadMessage(request('1760000001.000200'));
    change = () => {
      state.paired = OTHER_DM;
    };

    await expect(deleter.deleteThreadMessage(request('1760000002.000200'))).rejects.toMatchObject({ name: 'DeleteRefusedError', reason: 'wrong-channel' });

    expect(removed).toEqual(['1760000001.000200']);
  });

  it('refuses the retry after a rate limit when the trusted user is gone by the time Slack allows it', async () => {
    let sends = 0;
    const remove = vi.fn<DeleteBackend['deleteMessage']>(async () => {
      sends++;
      throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 3 });
    });
    const { deleter, state } = deleterWithWaits((ms) => {
      if (ms >= 3_000) state.trusted = undefined;
    }, remove);

    await expect(deleter.deleteThreadMessage(request(REPLY))).rejects.toMatchObject({ name: 'DeleteRefusedError', reason: 'no-trusted-user' });

    expect(sends).toBe(1);
  });

  it('runs beforeSend after the wait and before every request, retries included', async () => {
    const { deleter, events } = deleterWithWaits(
      () => {},
      vi
        .fn<DeleteBackend['deleteMessage']>()
        .mockImplementationOnce(async () => {
          events.push('send');
          throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 3 });
        })
        .mockImplementation(async () => {
          events.push('send');
        }),
    );

    await deleter.deleteThreadMessage(request(REPLY, { beforeSend: () => events.push('check') }));

    expect(events).toEqual(['check', 'send', 'wait', 'check', 'send']);
  });

  it('sends nothing when beforeSend throws, and the error reaches the caller unchanged', async () => {
    const { deleter, removed } = deleterWithWaits(() => {});
    const stop = new Error('the session got busy');

    await expect(
      deleter.deleteThreadMessage(
        request(REPLY, {
          beforeSend: () => {
            throw stop;
          },
        }),
      ),
    ).rejects.toBe(stop);
    expect(removed).toEqual([]);
  });
});

describe('guarded deleter: rate limits and failures', () => {
  function pacedDeleter(options: { remove: DeleteBackend['deleteMessage']; maxRateLimitRetries?: number }) {
    let clock = 0;
    const sleeps: number[] = [];
    const pacer = new DeletePacer(
      1_000,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      () => clock,
    );
    const backend: DeleteBackend = { whoAmI: async () => ({ userId: TRUSTED }), deleteMessage: options.remove };
    const deleter = createGuardedDeleter({
      identity: 'user',
      backend,
      getPairedChatId: () => PAIRED,
      getTrustedUserId: () => TRUSTED,
      pacer,
      maxRateLimitRetries: options.maxRateLimitRetries,
    });
    return { deleter, sleeps };
  }
  const request = (ts = REPLY) => ({ channel: PAIRED, threadTs: THREAD, message: reply({ ts }) });

  it('waits Retry-After and retries when Slack rate-limits the call', async () => {
    const remove = vi
      .fn<DeleteBackend['deleteMessage']>()
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 3 }))
      .mockResolvedValue(undefined);
    const { deleter, sleeps } = pacedDeleter({ remove });

    await expect(deleter.deleteThreadMessage(request())).resolves.toBe('deleted');

    expect(remove).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3_000]);
  });

  it('also honours a platform error that says "ratelimited"', async () => {
    const remove = vi
      .fn<DeleteBackend['deleteMessage']>()
      .mockRejectedValueOnce({ data: { error: 'ratelimited', response_metadata: { retryAfter: 2 } } })
      .mockResolvedValue(undefined);
    const { deleter, sleeps } = pacedDeleter({ remove });

    await expect(deleter.deleteThreadMessage(request())).resolves.toBe('deleted');
    expect(sleeps).toEqual([2_000]);
  });

  it('gives up after the allowed number of rate-limit retries', async () => {
    const remove = vi
      .fn<DeleteBackend['deleteMessage']>()
      .mockRejectedValue(Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 1 }));
    const { deleter } = pacedDeleter({ remove, maxRateLimitRetries: 2 });

    await expect(deleter.deleteThreadMessage(request())).rejects.toMatchObject({ name: 'DeleteFailedError', code: 'slack_webapi_rate_limited_error' });
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it('spaces consecutive deletions', async () => {
    const remove = vi.fn<DeleteBackend['deleteMessage']>().mockResolvedValue(undefined);
    const { deleter, sleeps } = pacedDeleter({ remove });

    await deleter.deleteThreadMessage(request('1760000001.000200'));
    await deleter.deleteThreadMessage(request('1760000002.000200'));
    await deleter.deleteThreadMessage(request('1760000003.000200'));

    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it('does not retry an error that is not a rate limit, and reports Slack\'s code', async () => {
    const remove = vi.fn<DeleteBackend['deleteMessage']>().mockRejectedValue({ data: { error: 'cant_delete_message' } });
    const { deleter } = pacedDeleter({ remove });

    await expect(deleter.deleteThreadMessage(request())).rejects.toMatchObject({ name: 'DeleteFailedError', code: 'cant_delete_message' });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('treats a message Slack no longer has as already deleted', async () => {
    const remove = vi.fn<DeleteBackend['deleteMessage']>().mockRejectedValue({ data: { error: 'message_not_found' } });
    const { deleter } = pacedDeleter({ remove });

    await expect(deleter.deleteThreadMessage(request())).resolves.toBe('already-gone');
  });
});

describe('the user token never leaves the guarded deleter', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@slack/web-api');
  });

  it('is handed to Slack only for auth.test and chat.delete, with rate-limit rejection on', async () => {
    const constructed: Array<{ token: string; options: Record<string, unknown> }> = [];
    const deleted: Array<{ channel: string; ts: string }> = [];
    class FakeWebClient {
      auth = { test: async () => ({ user_id: TRUSTED }) };
      chat = {
        delete: async (args: { channel: string; ts: string }) => {
          deleted.push(args);
        },
      };
      constructor(token: string, options: Record<string, unknown>) {
        constructed.push({ token, options });
        // Any other Web API method would be a use of the token this module must not make.
        return new Proxy(this, {
          get(target, property) {
            if (property === 'then') return undefined;
            if (property in target) return Reflect.get(target, property);
            throw new Error(`unexpected Web API access: ${String(property)}`);
          },
        });
      }
    }
    vi.resetModules();
    vi.doMock('@slack/web-api', () => ({ WebClient: FakeWebClient, LogLevel: { ERROR: 'error' } }));
    // Dynamic: the mock above must be in place before the module loads the Slack SDK.
    const { createUserTokenDeleter } = await import('../../src/slack/guarded-delete');
    const deleter = createUserTokenDeleter({
      userToken: 'xoxp-secret',
      getPairedChatId: () => PAIRED,
      getTrustedUserId: () => TRUSTED,
      pacer: instantPacer(),
    });

    await deleter.deleteThreadMessage({ channel: PAIRED, threadTs: THREAD, message: reply() });
    await expect(deleter.deleteThreadMessage({ channel: OTHER_DM, threadTs: THREAD, message: reply() })).rejects.toMatchObject({ reason: 'wrong-channel' });

    expect(constructed).toHaveLength(1);
    expect(constructed[0].token).toBe('xoxp-secret');
    expect(constructed[0].options).toMatchObject({ rejectRateLimitedCalls: true });
    expect(deleted).toEqual([{ channel: PAIRED, ts: REPLY }]);
  });
});

describe('source invariants', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    });
  }
  const sources = sourceFiles(join(__dirname, '..', '..', 'src')).map((path) => ({
    path: path.replace(/\\/g, '/'),
    text: readFileSync(path, 'utf-8'),
  }));
  const outsideGuard = sources.filter((source) => !source.path.endsWith('/slack/guarded-delete.ts'));

  it('calls chat.delete only in guarded-delete.ts', () => {
    expect(sources.filter((source) => /chat\.delete\s*\(/.test(source.text)).map((source) => source.path.split('/src/')[1])).toEqual([
      'slack/guarded-delete.ts',
    ]);
  });

  it('never gives the user token to the Slack client or any other Slack module', () => {
    const slackModules = outsideGuard.filter((source) => source.path.includes('/src/slack/'));
    expect(slackModules.length).toBeGreaterThan(0);
    expect(slackModules.filter((source) => /userToken/.test(source.text)).map((source) => source.path)).toEqual([]);
  });

  it('builds Web API clients only in the Slack client and the guarded deleter', () => {
    expect(
      sources
        .filter((source) => /new WebClient\(/.test(source.text))
        .map((source) => source.path.split('/src/')[1])
        .sort(),
    ).toEqual(['slack/client.ts', 'slack/guarded-delete.ts']);
  });
});
