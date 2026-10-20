/**
 * Pruning a session thread, end to end against an in-memory Slack thread. The fake thread applies
 * Slack's own rules (a token deletes only what its identity wrote; only the bot edits its messages),
 * the deleters are the real guarded deleters, and the summarizer is a stand-in for the model. Each
 * test reads the thread afterwards: what is left, what the header says, what was deleted by whom.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type DeleteBackend,
  type GuardedDeleter,
  DeletePacer,
  createGuardedDeleter,
} from '../../src/slack/guarded-delete';
import {
  AUTO_FAILURE_COOLDOWN_MS,
  MAX_TRANSCRIPT_CHARS_PER_ROUND,
  type PruneBlocker,
  type PrunerSlack,
  type ThreadRef,
  createThreadPruner,
} from '../../src/bridge/thread-pruner';
import type { ThreadMessage } from '../../src/slack/thread-history';
import type { SlackThreadMeta } from '../../src/types/index';

const CHAT = 'D0PAIRED01';
const TRUSTED = 'U0TRUSTED1';
const BOT = 'U0BOTUSER1';
const BOT_ID = 'B0BOTID001';
const ROOT_TS = '1760000000.000100';
const REF: ThreadRef = { chatId: CHAT, threadTs: ROOT_TS };
const HEADING = '📝 지난 대화 요약';

class FakeThread {
  messages: ThreadMessage[] = [];
  readonly updates: Array<{ ts: string; text: string }> = [];
  readonly posts: string[] = [];
  readonly deletions: Array<{ identity: 'user' | 'bot'; text: string | undefined }> = [];
  /** The nth deletion Slack attempts is refused. */
  failDeleteAt: number | undefined;
  failUpdate = false;
  failRead = false;
  /** Who the user token belongs to. */
  userTokenOwner = TRUSTED;
  private clock = 1760000001;
  private deleteAttempts = 0;

  constructor(root: { author: 'bot' | 'user'; text: string }) {
    this.messages.push(
      root.author === 'bot'
        ? { ts: ROOT_TS, user: BOT, bot_id: BOT_ID, thread_ts: ROOT_TS, text: root.text }
        : { ts: ROOT_TS, user: TRUSTED, thread_ts: ROOT_TS, text: root.text },
    );
  }

  private add(author: Partial<ThreadMessage>, text: string): string {
    const ts = `${this.clock++}.000100`;
    this.messages.push({ ts, thread_ts: ROOT_TS, text, ...author });
    return ts;
  }
  user = (text: string) => this.add({ user: TRUSTED }, text);
  bot = (text: string) => this.add({ user: BOT, bot_id: BOT_ID }, text);
  /** `count` exchanges: a user message and the bot's answer, labelled `<label>-<n>`. */
  exchanges(count: number, label = '질문', answer = '답변') {
    const first = this.messages.filter((m) => m.text?.startsWith(`${label}-`)).length;
    for (let n = first + 1; n <= first + count; n++) {
      this.user(`${label}-${n}`);
      this.bot(`${answer}-${n}`);
    }
  }
  get texts() {
    return this.messages.map((message) => message.text);
  }
  get root() {
    return this.messages[0];
  }

  readonly slack: PrunerSlack = {
    getBotIdentity: async () => ({ userId: BOT, botId: BOT_ID }),
    fetchThreadMessages: async (_chat, _ts, options) => {
      if (this.failRead) throw new Error('Slack thread read failed: ratelimited');
      return structuredClone(options?.rootOnly ? this.messages.slice(0, 1) : this.messages);
    },
    updateMessage: async (_chat, ts, text) => {
      if (this.failUpdate) throw new Error('Slack message update failed: ratelimited');
      const message = this.messages.find((m) => m.ts === ts);
      if (!message) throw new Error('Slack message update failed: message_not_found');
      message.text = text;
      this.updates.push({ ts, text });
    },
    postThreadReply: async (_chat, _thread, text) => {
      this.posts.push(text);
      return this.bot(text);
    },
  };

  private backend(identity: 'user' | 'bot'): DeleteBackend {
    return {
      whoAmI: async () => (identity === 'user' ? { userId: this.userTokenOwner } : { userId: BOT, botId: BOT_ID }),
      deleteMessage: async (_channel, ts) => {
        const index = this.messages.findIndex((m) => m.ts === ts);
        if (index < 0) throw { data: { error: 'message_not_found' } };
        const message = this.messages[index];
        // Slack's own rule: a token deletes only what its identity wrote.
        const written = identity === 'user' ? message.user === TRUSTED && !message.bot_id : message.user === BOT;
        this.deleteAttempts++;
        if (!written || this.deleteAttempts === this.failDeleteAt) throw { data: { error: 'cant_delete_message' } };
        this.messages.splice(index, 1);
        this.deletions.push({ identity, text: message.text });
      },
    };
  }

  deleter(identity: 'user' | 'bot'): GuardedDeleter {
    return createGuardedDeleter({
      identity,
      backend: this.backend(identity),
      getPairedChatId: () => CHAT,
      getTrustedUserId: () => TRUSTED,
      pacer: new DeletePacer(0, async () => {}, () => 0),
    });
  }
}

function setup(thread: FakeThread, options: { settings?: { keep: number; pruneAt: number }; reply?: (prompt: string, call: number) => string | Promise<string> } = {}) {
  const store = new Map<string, SlackThreadMeta>();
  const state = {
    userToken: true,
    blocker: undefined as (() => PruneBlocker | undefined) | undefined,
    settings: options.settings ?? { keep: 2, pruneAt: 4 },
    clock: 0,
  };
  let calls = 0;
  const summarize = vi.fn(async (prompt: string) => options.reply?.(prompt, ++calls) ?? `- 요약 ${++calls}`);
  const report = vi.fn();
  const sleep = vi.fn(async () => {});
  const bot = thread.deleter('bot');
  const user = thread.deleter('user');
  const pruner = createThreadPruner({
    slack: () => thread.slack,
    botDeleter: () => bot,
    userDeleter: () => (state.userToken ? user : undefined),
    getMeta: (ref) => store.get(`${ref.chatId}:${ref.threadTs}`),
    updateMeta: (ref, patch) => {
      const key = `${ref.chatId}:${ref.threadTs}`;
      const next: SlackThreadMeta = { ...store.get(key), updatedAt: 'now' };
      if (patch.title !== undefined) next.title = patch.title;
      if (patch.summary !== undefined) next.summary = patch.summary;
      if (patch.summaryTs !== undefined) next.summaryTs = patch.summaryTs;
      store.set(key, next);
    },
    settings: () => state.settings,
    trustedUserId: () => TRUSTED,
    summarize,
    blocker: () => state.blocker?.(),
    report,
    sleep,
    now: () => state.clock,
    quietTimeoutMs: 1_000,
    quietPollMs: 250,
  });
  return { pruner, summarize, report, sleep, state, meta: () => store.get(`${CHAT}:${ROOT_TS}`) };
}

describe('automatic pruning of a bot-rooted thread', () => {
  it('summarizes and deletes the oldest interactions, keeps the newest, and writes the header into the root', async () => {
    const thread = new FakeThread({ author: 'bot', text: '[VLM_Verifier] MoT' });
    thread.exchanges(6);
    const { pruner, summarize, meta } = setup(thread);

    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toEqual({ status: 'pruned', interactions: 4, deleted: 8 });
    expect(thread.texts.slice(1)).toEqual(['질문-5', '답변-5', '질문-6', '답변-6']);
    // The existing hand-written title survives; the summary sits below it.
    expect(thread.root.text).toBe(`**[VLM_Verifier] MoT**\n\n${HEADING}\n- 요약 1`);
    expect(thread.updates).toEqual([{ ts: ROOT_TS, text: thread.root.text }]);
    expect(meta()).toMatchObject({ title: '[VLM_Verifier] MoT', summary: '- 요약 1' });
    // The user token removed the user's messages and the bot token the bot's, oldest first.
    expect(thread.deletions.map((d) => d.identity)).toEqual(['user', 'bot', 'user', 'bot', 'user', 'bot', 'user', 'bot']);
    expect(thread.deletions.map((d) => d.text)).toEqual(['질문-1', '답변-1', '질문-2', '답변-2', '질문-3', '답변-3', '질문-4', '답변-4']);
    // The summarizer read exactly what was about to disappear.
    const prompt = summarize.mock.calls[0][0];
    for (const text of ['질문-1', '답변-1', '질문-4', '답변-4']) expect(prompt).toContain(text);
    for (const text of ['질문-5', '답변-5', '질문-6', '답변-6']) expect(prompt).not.toContain(text);
  });

  it('merges the stored summary with the next batch and keeps the title', async () => {
    const thread = new FakeThread({ author: 'bot', text: '📁 **proj** (main) · ~/work\n첫 프롬프트' });
    thread.exchanges(5);
    const { pruner, summarize, meta } = setup(thread, { reply: (_prompt, call) => `- 요약 ${call}` });
    await pruner.autoPrune(REF);
    expect(thread.root.text).toBe(`**proj (main) · ~/work**\n\n${HEADING}\n- 요약 1`);

    thread.exchanges(3, '다음', '다음답');
    await pruner.autoPrune(REF);

    const second = summarize.mock.calls[1][0];
    expect(second).toContain('<기존 요약>\n- 요약 1\n</기존 요약>');
    expect(second).toContain('다음-1');
    expect(thread.root.text).toBe(`**proj (main) · ~/work**\n\n${HEADING}\n- 요약 2`);
    expect(meta()?.title).toBe('proj (main) · ~/work');
    expect(thread.texts.slice(1)).toEqual(['다음-2', '다음답-2', '다음-3', '다음답-3']);
  });

  it('does nothing while the thread is shorter than the prune threshold', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(3);
    const before = [...thread.texts];
    const { pruner, summarize } = setup(thread);

    expect(await pruner.autoPrune(REF)).toEqual({ status: 'skipped', reason: 'below-threshold' });

    expect(summarize).not.toHaveBeenCalled();
    expect(thread.texts).toEqual(before);
    expect(thread.updates).toEqual([]);
  });

  it('counts bot messages before the first user message as the oldest interaction', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.bot('이어하기 재생 1');
    thread.bot('이어하기 재생 2');
    thread.exchanges(3);
    const { pruner, summarize } = setup(thread, { settings: { keep: 2, pruneAt: 4 } });

    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toMatchObject({ status: 'pruned', interactions: 2 });
    expect(thread.texts.slice(1)).toEqual(['질문-2', '답변-2', '질문-3', '답변-3']);
    expect(summarize.mock.calls[0][0]).toContain('이어하기 재생 1');
  });

  it('leaves messages of other bots and strangers alone', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(2);
    thread.messages.push({ ts: '1760000500.000100', thread_ts: ROOT_TS, user: 'U0OTHERBOT', bot_id: 'B0OTHER001', text: '다른 봇' });
    thread.messages.push({ ts: '1760000501.000100', thread_ts: ROOT_TS, user: 'U0STRANGER', text: '낯선 사람' });
    thread.exchanges(4, '뒤', '뒤답');
    const { pruner, summarize } = setup(thread, { settings: { keep: 1, pruneAt: 2 } });

    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toMatchObject({ status: 'pruned', interactions: 5 });
    expect(thread.texts.slice(1)).toEqual(['다른 봇', '낯선 사람', '뒤-4', '뒤답-4']);
    expect(summarize.mock.calls[0][0]).not.toContain('다른 봇');
    expect(summarize.mock.calls[0][0]).not.toContain('낯선 사람');
  });
});

describe('what stops a prune', () => {
  it('deletes nothing when the summary fails', async () => {
    const thread = new FakeThread({ author: 'bot', text: '[VLM_Verifier] MoT' });
    thread.exchanges(6);
    const before = [...thread.texts];
    const { pruner, meta } = setup(thread, {
      reply: () => {
        throw new Error('side turn failed');
      },
    });

    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toEqual({ status: 'failed', stage: 'summary', error: 'side turn failed' });
    expect(thread.texts).toEqual(before);
    expect(thread.updates).toEqual([]);
    expect(thread.deletions).toEqual([]);
    expect(meta()).toBeUndefined();
  });

  it('deletes nothing when the model answers with nothing', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const before = [...thread.texts];
    const { pruner } = setup(thread, { reply: () => '  \n ' });

    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'failed', stage: 'summary' });
    expect(thread.texts).toEqual(before);
  });

  it('does nothing without a user token and says so once', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(8);
    const before = [...thread.texts];
    const { pruner, summarize, report, state } = setup(thread);
    state.userToken = false;

    expect(await pruner.autoPrune(REF)).toEqual({ status: 'skipped', reason: 'no-user-token' });
    expect(await pruner.autoPrune(REF)).toEqual({ status: 'skipped', reason: 'no-user-token' });

    expect(summarize).not.toHaveBeenCalled();
    expect(thread.texts).toEqual(before);
    expect(thread.deletions).toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toContain('user token');
  });

  it('deletes nothing when the header cannot be written', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const before = [...thread.texts];
    const { pruner, meta } = setup(thread);
    thread.failUpdate = true;

    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'failed', stage: 'header' });

    expect(thread.texts).toEqual(before);
    expect(meta()).toBeUndefined();
  });

  it('stops at the first refused deletion and reports how far it got', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    thread.failDeleteAt = 3;
    const { pruner, meta } = setup(thread);

    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toEqual({ status: 'failed', stage: 'delete', error: 'Slack chat.delete failed: cant_delete_message', deleted: 2, remaining: 6 });
    // The summary was already stored and shown, and the rest of the thread is intact for a retry.
    expect(meta()?.summary).toBe('- 요약 1');
    expect(thread.texts.slice(1, 3)).toEqual(['질문-2', '답변-2']);
  });

  it('waits for the session to go quiet, then prunes', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const { pruner, sleep, state } = setup(thread);
    let polls = 0;
    state.blocker = () => (polls++ < 2 ? 'busy' : undefined);

    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'pruned' });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each<[PruneBlocker, number]>([
    ['busy', 4],
    ['question-pending', 4],
    ['not-owner', 0],
    ['not-joined', 0],
  ])('gives up on a session that stays %s (after %i polls) without touching the thread', async (blocker, polls) => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const before = [...thread.texts];
    const { pruner, summarize, sleep, state } = setup(thread);
    state.blocker = () => blocker;

    expect(await pruner.autoPrune(REF)).toEqual({ status: 'skipped', reason: `blocked:${blocker}` });

    expect(sleep).toHaveBeenCalledTimes(polls);
    expect(summarize).not.toHaveBeenCalled();
    expect(thread.texts).toEqual(before);
  });

  it('changes nothing when a turn starts while the summary is being written', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const before = [...thread.texts];
    const { pruner, state, summarize } = setup(thread, {
      reply: () => {
        state.blocker = () => 'busy';
        return '- 요약';
      },
    });

    expect(await pruner.autoPrune(REF)).toEqual({ status: 'skipped', reason: 'blocked:busy' });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(thread.texts).toEqual(before);
    expect(thread.updates).toEqual([]);
  });

  it('prunes one thread at a time', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const release = Promise.withResolvers<string>();
    let running = 0;
    let overlapped = false;
    const { pruner, summarize } = setup(thread, {
      reply: async () => {
        running++;
        overlapped ||= running > 1;
        const text = await release.promise;
        running--;
        return text;
      },
    });

    const first = pruner.autoPrune(REF);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    // A second automatic run, and a manual one, start while the first is summarizing.
    expect(await pruner.autoPrune(REF)).toEqual({ status: 'skipped', reason: 'already-running' });
    const manual = pruner.pruneAll(REF);
    release.resolve('- 요약');
    await first;
    await manual;

    expect(overlapped).toBe(false);
    // The manual run saw the thread after the first prune and took what was left.
    expect(thread.texts).toEqual([thread.root.text]);
  });
});

describe('a token or model that does not work', () => {
  it('refuses a user token that belongs to someone else before summarizing or touching anything', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const before = [...thread.texts];
    const { pruner, summarize } = setup(thread);
    thread.userTokenOwner = 'U0SOMEONE9';

    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toMatchObject({ status: 'failed', stage: 'token' });
    expect(outcome.status === 'failed' && outcome.error).toContain('wrong-user');
    expect(summarize).not.toHaveBeenCalled();
    expect(thread.texts).toEqual(before);
    expect(thread.updates).toEqual([]);
  });

  it('does not retry a failed automatic prune for five minutes, then tries again', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    let failing = true;
    const { pruner, summarize, state } = setup(thread, {
      reply: () => {
        if (failing) throw new Error('model unavailable');
        return '- 요약';
      },
    });

    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'failed', stage: 'summary' });
    failing = false;
    state.clock += AUTO_FAILURE_COOLDOWN_MS - 1;
    expect(await pruner.autoPrune(REF)).toEqual({ status: 'skipped', reason: 'cooling-down' });
    expect(summarize).toHaveBeenCalledTimes(1);

    state.clock += 1;
    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'pruned' });
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('still lets `.bridge new` through while an automatic prune is cooling down, and a success ends the cooldown', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    let failing = true;
    const { pruner } = setup(thread, {
      reply: () => {
        if (failing) throw new Error('model unavailable');
        return '- 요약';
      },
    });
    await pruner.autoPrune(REF);
    failing = false;

    expect(await pruner.pruneAll(REF)).toMatchObject({ status: 'pruned' });
    thread.exchanges(5);

    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'pruned' });
  });

  it('does not cool down after a failed read, which costs no summary', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const { pruner } = setup(thread);
    thread.failRead = true;

    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'failed', stage: 'read' });
    thread.failRead = false;

    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'pruned' });
  });
});

describe('`.bridge new`: prune everything', () => {
  it('summarizes every interaction, deletes all of them, and leaves the header', async () => {
    const thread = new FakeThread({ author: 'bot', text: '[VLM_Verifier] MoT' });
    thread.exchanges(3);
    thread.user('.bridge new');
    thread.bot('🧹 이전 대화를 요약하고 정리합니다…');
    const { pruner, summarize } = setup(thread);

    const outcome = await pruner.pruneAll(REF);

    expect(outcome).toMatchObject({ status: 'pruned', interactions: 4, deleted: 8 });
    expect(thread.texts).toEqual([`**[VLM_Verifier] MoT**\n\n${HEADING}\n- 요약 1`]);
    const prompt = summarize.mock.calls[0][0];
    expect(prompt).toContain('질문-3');
    expect(prompt).not.toContain('.bridge new');
  });

  it('leaves a reply that a later prune removes like any other message', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(3);
    thread.user('.bridge new');
    const { pruner, summarize } = setup(thread);
    await pruner.pruneAll(REF);
    // The answer to the command is posted after the prune, so it is the thread's only message below the header.
    thread.bot('🧹 이전 대화 4개를 요약하고 메시지 7개를 삭제했습니다.');
    thread.exchanges(5, '다음', '다음답');

    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toMatchObject({ status: 'pruned' });
    expect(thread.texts.slice(1)).toEqual(['다음-4', '다음답-4', '다음-5', '다음답-5']);
    expect(summarize.mock.calls[1][0]).toContain('이전 대화 4개를 요약하고');
  });

  it('says there is nothing to do for a thread without interactions', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    const { pruner, summarize } = setup(thread);

    expect(await pruner.pruneAll(REF)).toEqual({ status: 'skipped', reason: 'nothing-to-prune' });
    expect(summarize).not.toHaveBeenCalled();
  });

  it('refuses without a user token instead of deleting only the bot\'s half', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(3);
    const before = [...thread.texts];
    const { pruner, state } = setup(thread);
    state.userToken = false;

    expect(await pruner.pruneAll(REF)).toEqual({ status: 'skipped', reason: 'no-user-token' });
    expect(thread.texts).toEqual(before);
  });

  it('summarizes a long history in several rounds, each building on the last', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    const long = 'x'.repeat(1_900);
    for (let n = 1; n <= 20; n++) {
      thread.user(`질문-${n} ${long}`);
      thread.bot(`답변-${n} ${long}`);
    }
    const { pruner, summarize } = setup(thread, { reply: (_prompt, call) => `- 라운드 ${call}` });

    const outcome = await pruner.pruneAll(REF);

    expect(outcome).toMatchObject({ status: 'pruned', interactions: 20 });
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
    for (const [prompt] of summarize.mock.calls) {
      const transcript = prompt.split('<새로 정리할 대화>\n')[1].split('\n</새로 정리할 대화>')[0];
      expect(transcript.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS_PER_ROUND);
    }
    expect(summarize.mock.calls[1][0]).toContain('<기존 요약>\n- 라운드 1\n</기존 요약>');
    expect(thread.root.text).toContain(`- 라운드 ${summarize.mock.calls.length}`);
    expect(thread.texts).toHaveLength(1);
  });
});

describe('a thread whose root is the user\'s message', () => {
  it('turns the earliest bot reply into the summary message and never deletes the root', async () => {
    const thread = new FakeThread({ author: 'user', text: '처음 질문' });
    thread.bot('답변-0a');
    thread.bot('답변-0b');
    thread.exchanges(4);
    const { pruner, meta } = setup(thread);

    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toMatchObject({ status: 'pruned', interactions: 3 });
    const header = `**처음 질문**\n\n${HEADING}\n- 요약 1`;
    expect(thread.texts).toEqual(['처음 질문', header, '질문-3', '답변-3', '질문-4', '답변-4']);
    expect(thread.posts).toEqual([]);
    expect(thread.messages[0].ts).toBe(ROOT_TS);
    expect(meta()).toMatchObject({ title: '처음 질문', summary: '- 요약 1', summaryTs: thread.messages[1].ts });
  });

  it('edits that summary message in place on the next prune and does not summarize the root again', async () => {
    const thread = new FakeThread({ author: 'user', text: '처음 질문' });
    thread.bot('답변-0');
    thread.exchanges(4);
    const { pruner, summarize } = setup(thread);
    await pruner.autoPrune(REF);
    const summaryTs = thread.messages[1].ts;

    thread.exchanges(3, '다음', '다음답');
    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toMatchObject({ status: 'pruned' });
    expect(thread.messages[1].ts).toBe(summaryTs);
    expect(thread.texts).toEqual([
      '처음 질문',
      `**처음 질문**\n\n${HEADING}\n- 요약 2`,
      '다음-2',
      '다음답-2',
      '다음-3',
      '다음답-3',
    ]);
    expect(thread.posts).toEqual([]);
    // The root is not part of what the second prune summarizes: only the stored summary and the new batch.
    const second = summarize.mock.calls[1][0];
    expect(second).toContain('<기존 요약>\n- 요약 1\n</기존 요약>');
    expect(second).not.toContain('처음 질문');
    expect(second).toContain('질문-3');
  });
});

describe('titles', () => {
  it('sets the title of a bot-rooted thread and keeps the stored summary under it', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'old root' });
    thread.exchanges(6);
    const { pruner, meta } = setup(thread);
    await pruner.autoPrune(REF);

    expect(await pruner.setTitle(REF, '  새   제목 ')).toEqual({ status: 'updated' });

    expect(thread.root.text).toBe(`**새 제목**\n\n${HEADING}\n- 요약 1`);
    expect(meta()).toMatchObject({ title: '새 제목', summary: '- 요약 1' });
  });

  it('keeps the new title for later prunes', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'old root' });
    thread.exchanges(2);
    const { pruner } = setup(thread);
    await pruner.setTitle(REF, '내 제목');
    thread.exchanges(5);

    await pruner.autoPrune(REF);

    expect(thread.root.text.startsWith('**내 제목**\n\n' + HEADING)).toBe(true);
  });

  it('puts the title of a user-rooted thread into one bot message, created once and edited afterwards', async () => {
    const thread = new FakeThread({ author: 'user', text: '처음 질문' });
    thread.exchanges(2);
    const { pruner, meta } = setup(thread);

    await pruner.setTitle(REF, '첫 제목');
    await pruner.setTitle(REF, '둘째 제목');

    expect(thread.posts).toEqual(['**첫 제목**']);
    expect(thread.messages.at(-1)?.text).toBe('**둘째 제목**');
    expect(meta()?.summaryTs).toBe(thread.messages.at(-1)?.ts);
    // The root is the user's message: it is left alone.
    expect(thread.root.text).toBe('처음 질문');
  });

  it('posts a new summary message when the stored one was deleted', async () => {
    const thread = new FakeThread({ author: 'user', text: '처음 질문' });
    const { pruner, meta } = setup(thread);
    await pruner.setTitle(REF, '첫 제목');
    thread.messages.pop();

    await pruner.setTitle(REF, '둘째 제목');

    expect(thread.posts).toEqual(['**첫 제목**', '**둘째 제목**']);
    expect(thread.messages.at(-1)?.ts).toBe(meta()?.summaryTs);
  });

  it('refuses an empty title', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    const { pruner } = setup(thread);

    expect(await pruner.setTitle(REF, '   ')).toMatchObject({ status: 'failed' });
    expect(thread.updates).toEqual([]);
  });
});

describe('what a prune reads before it deletes', () => {
  /** The transcript part of every summary request made so far. */
  const transcriptsOf = (summarize: { mock: { calls: Array<[string]> } }) =>
    summarize.mock.calls.map(([prompt]) => prompt.split('<새로 정리할 대화>\n')[1].split('\n</새로 정리할 대화>')[0]);

  it('reads every character of a very long message, however many rounds it takes, before deleting it', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    const lines = Array.from({ length: 2_500 }, (_, i) => `줄-${i} ${'y'.repeat(40)}`);
    thread.user(`긴 질문 ${'z'.repeat(5_000)} 끝-질문`);
    thread.bot(lines.join('\n'));
    const { pruner, summarize } = setup(thread);

    const outcome = await pruner.pruneAll(REF);

    expect(outcome).toMatchObject({ status: 'pruned', interactions: 1 });
    const transcripts = transcriptsOf(summarize);
    expect(transcripts.length).toBeGreaterThanOrEqual(3);
    for (const transcript of transcripts) expect(transcript.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS_PER_ROUND);
    const read = transcripts.join('\n');
    for (const line of lines) expect(read, line).toContain(line);
    expect(read).toContain('끝-질문');
    expect(read).toContain('z'.repeat(5_000));
    expect(thread.texts).toHaveLength(1);
  });

  it('deletes nothing when a later round of the summary fails', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.bot(Array.from({ length: 2_500 }, (_, i) => `줄-${i} ${'y'.repeat(40)}`).join('\n'));
    const before = [...thread.texts];
    const { pruner, summarize } = setup(thread, {
      reply: (_prompt, call) => {
        if (call === 2) throw new Error('second round failed');
        return `- 라운드 ${call}`;
      },
    });

    expect(await pruner.pruneAll(REF)).toEqual({ status: 'failed', stage: 'summary', error: 'second round failed' });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(thread.texts).toEqual(before);
    expect(thread.updates).toEqual([]);
  });

  it('stops between summary rounds when the session gets busy', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.bot(Array.from({ length: 2_500 }, (_, i) => `줄-${i} ${'y'.repeat(40)}`).join('\n'));
    const before = [...thread.texts];
    const { pruner, summarize, state } = setup(thread, {
      reply: () => {
        state.blocker = () => 'busy';
        return '- 요약';
      },
    });

    expect(await pruner.pruneAll(REF)).toEqual({ status: 'skipped', reason: 'blocked:busy' });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(thread.texts).toEqual(before);
  });
});

describe('a session that stops being free during the deletions', () => {
  it('stops before the next deletion, reports how far it got, and finishes on the next run', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const { pruner, state } = setup(thread);
    state.blocker = () => (thread.deletions.length >= 3 ? 'busy' : undefined);

    const outcome = await pruner.autoPrune(REF);

    expect(outcome).toEqual({ status: 'interrupted', reason: 'busy', deleted: 3, remaining: 5 });
    expect(thread.deletions.map((d) => d.text)).toEqual(['질문-1', '답변-1', '질문-2']);
    expect(thread.texts).toContain('답변-2');

    // Not a failure: no cooldown, and the next run takes up what is left.
    state.blocker = undefined;
    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'pruned' });
    expect(thread.texts.slice(1)).toEqual(['질문-5', '답변-5', '질문-6', '답변-6']);
  });

  it('also stops when the thread stops being this session\'s', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(6);
    const { pruner, state } = setup(thread);
    state.blocker = () => (thread.deletions.length >= 1 ? 'not-owner' : undefined);

    expect(await pruner.autoPrune(REF)).toMatchObject({ status: 'interrupted', reason: 'not-owner', deleted: 1 });
    expect(thread.deletions).toHaveLength(1);
  });
});

describe('messages the session has not seen yet', () => {
  it('`.bridge new` leaves what was written after the command alone and does not summarize it', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(3);
    const commandTs = thread.user('.bridge new');
    thread.user('명령 뒤에 보낸 질문');
    const { pruner, summarize } = setup(thread);

    const outcome = await pruner.pruneAll(REF, { upToTs: commandTs });

    expect(outcome).toMatchObject({ status: 'pruned', interactions: 4, deleted: 7 });
    expect(thread.texts.slice(1)).toEqual(['명령 뒤에 보낸 질문']);
    expect(summarize.mock.calls[0][0]).not.toContain('명령 뒤에 보낸 질문');
  });

  it('an automatic prune takes nothing written after the turn it follows', async () => {
    const thread = new FakeThread({ author: 'bot', text: 'root' });
    thread.exchanges(2);
    const answeredTs = thread.messages.find((m) => m.text === '질문-2')?.ts as string;
    thread.user('아직 처리되지 않은 질문');
    const { pruner } = setup(thread, { settings: { keep: 1, pruneAt: 2 } });

    const outcome = await pruner.autoPrune(REF, { upToTs: answeredTs });

    expect(outcome).toMatchObject({ status: 'pruned', interactions: 1 });
    // Without the bound the newest interaction would have been the unseen one and 질문-2 would be deleted.
    expect(thread.texts.slice(1)).toEqual(['질문-2', '답변-2', '아직 처리되지 않은 질문']);
  });
});
