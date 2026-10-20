/**
 * Thread pruning through a whole bridge instance. Nothing about the bridge is faked: config, lock,
 * registry, inbox, the Slack client, the pruner and the guarded deleters are the real modules in a
 * temporary home. Only Slack's Web API is a fake — one in-memory DM thread that enforces the rules
 * Slack enforces for each token (the bot edits and deletes only its own messages, the user token
 * deletes only the user's) — and the agent: a Slack message arrives through the inbox, the turn ends,
 * and the summary comes from a stand-in for OMP's side turn (`ctx.runEphemeralTurn`).
 */

import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as OsModule from 'os';
import type * as InboxModule from '../../src/session/inbox';

const g = global as unknown as Record<string, unknown>;
const SESSION = '/tmp/pruning/session.jsonl';
const CHAT = 'D0PAIRED01';
const TRUSTED = 'U0TRUSTED1';
const BOT = 'U0BOTUSER1';
const BOT_ID = 'B0BOTID001';
const BOT_TOKEN = 'xoxb-bot-token';
const APP_TOKEN = 'xapp-app-token';
const USER_TOKEN = 'xoxp-user-token';
const ROOT_TS = '1760000000.000100';
const HEADING = '📝 지난 대화 요약';

interface FakeMessage {
  ts: string;
  user: string;
  bot_id?: string;
  thread_ts: string;
  text: string;
}

/** One DM thread and a log of every Web API call, with the token it was made with. */
class FakeSlack {
  messages: FakeMessage[] = [
    { ts: ROOT_TS, user: BOT, bot_id: BOT_ID, thread_ts: ROOT_TS, text: '[VLM_Verifier] MoT' },
  ];
  readonly calls: Array<{ method: string; token: string; args: Record<string, any> }> = [];
  /** Whose token the user token is. */
  userTokenOwner = TRUSTED;
  private clock = 1760000001;

  addUser(text: string): string {
    return this.add({ user: TRUSTED }, text);
  }
  addBot(text: string): string {
    return this.add({ user: BOT, bot_id: BOT_ID }, text);
  }
  private add(author: Pick<FakeMessage, 'user'> & Partial<FakeMessage>, text: string): string {
    const ts = `${this.clock++}.000100`;
    this.messages.push({ ts, thread_ts: ROOT_TS, text, ...author });
    return ts;
  }
  /** Earlier history: `count` exchanges of a user message and the bot's answer. */
  seed(count: number) {
    for (let n = 1; n <= count; n++) {
      this.addUser(`질문-${n}`);
      this.addBot(`답변-${n}`);
    }
  }
  get texts() {
    return this.messages.map((message) => message.text);
  }
  callsWith(token: string) {
    return this.calls.filter((call) => call.token === token);
  }

  /** The Web API client of one token. */
  client(token: string) {
    const record = (method: string, args: Record<string, any> = {}) => this.calls.push({ method, token, args });
    const isUser = token === USER_TOKEN;
    const find = (ts: string) => this.messages.find((message) => message.ts === ts);
    return {
      auth: {
        test: async () => {
          record('auth.test');
          return isUser ? { user_id: this.userTokenOwner } : { user_id: BOT, bot_id: BOT_ID };
        },
      },
      chat: {
        postMessage: async (args: Record<string, any>) => {
          record('chat.postMessage', args);
          return { ts: this.addBot(args.text) };
        },
        update: async (args: Record<string, any>) => {
          record('chat.update', args);
          const message = find(args.ts);
          if (isUser || !message || message.user !== BOT) throw { data: { error: 'cant_update_message' } };
          message.text = args.text;
          return { ok: true };
        },
        delete: async (args: Record<string, any>) => {
          record('chat.delete', args);
          const message = find(args.ts);
          if (!message) throw { data: { error: 'message_not_found' } };
          const written = isUser ? message.user === TRUSTED : message.user === BOT;
          if (!written) throw { data: { error: 'cant_delete_message' } };
          this.messages = this.messages.filter((entry) => entry.ts !== args.ts);
          return { ok: true };
        },
      },
      conversations: {
        replies: async (args: Record<string, any>) => {
          record('conversations.replies', args);
          if (isUser) throw { data: { error: 'missing_scope' } };
          return { messages: structuredClone(args.limit === 1 ? this.messages.slice(0, 1) : this.messages), has_more: false };
        },
      },
      reactions: {
        add: async (args: Record<string, any>) => {
          record('reactions.add', args);
          return {};
        },
        remove: async (args: Record<string, any>) => {
          record('reactions.remove', args);
          return {};
        },
      },
      files: { uploadV2: async () => ({}) },
    };
  }
}

type Handler = (event: unknown, context: unknown) => Promise<void>;

describe('thread pruning in a running bridge', () => {
  let home: string;
  let slack: FakeSlack;
  let summaries: number;
  let launched: Array<() => Promise<void>> = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    home = mkdtempSync(join(tmpdir(), 'slk-bridge-pruning-'));
    slack = new FakeSlack();
    summaries = 0;
    launched = [];
  });

  afterEach(async () => {
    for (const shutdown of launched.splice(0)) await shutdown();
    vi.useRealTimers();
    delete g.__slkBridgeConnected;
    delete g.__slkBridgeOwner;
    delete g.__slkBridgeInstanceId;
    rmSync(home, { recursive: true, force: true });
  });

  const configPath = () => join(home, '.omp', 'agent', 'slk-bridge.json');
  const storedConfig = () => JSON.parse(readFileSync(configPath(), 'utf-8'));

  /** Start a bridge for SESSION, owner of the thread rooted at ROOT_TS in the paired DM. */
  async function launch(options: { userToken?: boolean; config?: Record<string, unknown> } = {}) {
    delete g.__slkBridgeInstanceId;
    vi.resetModules();
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof OsModule>('os');
      return { ...actual, homedir: () => home };
    });
    vi.doMock('@slack/web-api', () => ({
      WebClient: class {
        constructor(token: string) {
          return slack.client(token);
        }
      },
      LogLevel: { ERROR: 'error' },
    }));
    vi.doMock('../../src/session/handlers.js', () => ({
      getConversationHistory: () => [],
      getLastAssistantMessageInfo: () => null,
      buildSlackFooterText: vi.fn().mockResolvedValue('footer'),
      buildSlackSessionRootText: vi.fn(async () => 'root'),
      listRecentSessions: vi.fn().mockResolvedValue([]),
      buildSessionListText: vi.fn().mockResolvedValue(''),
    }));
    vi.doMock('../../src/session/tmux.js', () => ({
      runTmuxPiConnect: vi.fn(),
      resolvePathInput: (input: string) => input,
      buildTmuxConnectSummary: vi.fn(),
    }));
    vi.doMock('../../src/ui/main-menu.js', () => ({ openMainMenu: vi.fn() }));

    mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
    const slackTokens = { botToken: BOT_TOKEN, appToken: APP_TOKEN, ...(options.userToken === false ? {} : { userToken: USER_TOKEN }) };
    writeFileSync(
      configPath(),
      JSON.stringify({
        slack: slackTokens,
        auth: { trustedUser: `${TRUSTED}:chanwoo`, userChats: { [TRUSTED]: CHAT }, claimOpen: false },
        // Joined, but never claims the Slack socket: this test needs posting and the inbox only.
        autoConnect: false,
        joinedSessions: [SESSION],
        threadKeep: 2,
        threadPruneAt: 4,
        slackRouting: {
          threadsByKey: { [`${CHAT}:${ROOT_TS}`]: { sessionPath: SESSION, updatedAt: '2026-10-19T00:00:00.000Z' } },
          activeThreadBySessionChat: { [`${SESSION}:${CHAT}`]: { threadTs: ROOT_TS, updatedAt: '2026-10-19T00:00:00.000Z' } },
        },
        ...options.config,
      }),
    );

    const handlers = new Map<string, Handler>();
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    let command: { handler(args: string, context: unknown): Promise<void> } | undefined;
    const pi = {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.push(tool),
      registerCommand: (_name: string, registered: { handler(args: string, context: unknown): Promise<void> }) => {
        command = registered;
      },
      sendUserMessage: vi.fn(),
      getCommands: () => [],
    };
    // Dynamic: the mocks above must be in place before the bridge and its modules load.
    const bridge = await import('../../src/bridge/index');
    bridge.default(pi as never);
    const inbox: typeof InboxModule = await import('../../src/session/inbox');

    const state = { idle: true };
    const notifications: Array<[string, string]> = [];
    const runEphemeralTurn: Mock<(options: { promptText: string }) => Promise<{ replyText: string }>> = vi.fn(async () => ({ replyText: `- 요약 ${++summaries}` }));
    const ctx = {
      sessionManager: { getSessionFile: () => SESSION, getBranch: () => [] },
      cwd: '/tmp/project',
      model: { provider: 'test', id: 'model', contextWindow: 8000 },
      getContextUsage: () => ({ percent: 1, contextWindow: 8000 }),
      isIdle: () => state.idle,
      ui: { notify: vi.fn((message: string, level: string) => notifications.push([message, level])), setStatus: vi.fn() },
      runEphemeralTurn,
    };
    await handlers.get('session_start')?.({}, ctx);
    launched.push(async () => {
      await handlers.get('session_shutdown')?.({}, ctx);
    });

    /** Run fake time forward until `done`, as the real clock would while the bridge works. */
    async function until(done: () => boolean, limitMs = 180_000) {
      for (let elapsed = 0; elapsed < limitMs && !done(); elapsed += 250) await vi.advanceTimersByTimeAsync(250);
      expect(done(), 'the bridge did not reach the expected state in time').toBe(true);
    }

    return {
      pi,
      ctx,
      state,
      notifications,
      runEphemeralTurn,
      tools,
      until,
      command: (args: string) => command!.handler(args, { ui: ctx.ui, isIdle: () => state.idle }),
      /** The user writes in the thread: Slack has the message at once; the router hands it over on the session's next inbox poll. */
      queue(text: string): string {
        const ts = slack.addUser(text);
        inbox.enqueueInboxMessage(SESSION, {
          chatId: CHAT,
          content: text,
          username: 'chanwoo',
          userId: TRUSTED,
          timestamp: new Date(),
          messageId: ts,
          isGroupChat: false,
          wasMentioned: false,
          threadId: ROOT_TS,
          isThreadReply: true,
        });
        return ts;
      },
      /** Like `queue`, then lets the session poll its inbox. */
      async userWrites(text: string) {
        this.queue(text);
        await vi.advanceTimersByTimeAsync(600);
      },
      /** The agent finishes the turn with `reply`. */
      async agentAnswers(reply: string) {
        const message = { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop' };
        await handlers.get('turn_end')?.({ message }, ctx);
        await handlers.get('agent_end')?.({ messages: [message] }, ctx);
      },
    };
  }

  const prunedThread = ['질문-5', '답변-5', '질문-6', '답변-6'];

  it('after a Slack turn, summarizes the oldest interactions into the root and deletes them, leaving the newest', async () => {
    slack.seed(5);
    const bridge = await launch();

    await bridge.userWrites('질문-6');
    expect(bridge.pi.sendUserMessage).toHaveBeenCalledWith('[📱 @chanwoo via Slack]: 질문-6');
    await bridge.agentAnswers('답변-6');
    await bridge.until(() => slack.texts.length === 1 + prunedThread.length);

    // The existing hand-written root is now the header, with the summary under its title.
    expect(slack.texts).toEqual([`**[VLM_Verifier] MoT**\n\n${HEADING}\n- 요약 1`, ...prunedThread]);
    expect(storedConfig().slackRouting.threadMeta[`${CHAT}:${ROOT_TS}`]).toMatchObject({
      title: '[VLM_Verifier] MoT',
      summary: '- 요약 1',
    });
    // One side turn read the old interactions only; it never became a turn of the agent.
    expect(bridge.runEphemeralTurn).toHaveBeenCalledTimes(1);
    const prompt = bridge.runEphemeralTurn.mock.calls[0][0].promptText;
    for (const text of ['질문-1', '답변-4', '질문-4']) expect(prompt).toContain(text);
    expect(prompt).not.toContain('질문-5');
    expect(bridge.pi.sendUserMessage).toHaveBeenCalledTimes(1);
    // The summary appears only in the header: no message of the thread was posted for it.
    expect(slack.callsWith(BOT_TOKEN).filter((call) => call.method === 'chat.postMessage').map((call) => call.args.text)).toEqual(['답변-6']);
  });

  it('uses the user token only to delete the user\'s own messages of this thread in the paired DM', async () => {
    slack.seed(5);
    const bridge = await launch();

    await bridge.userWrites('질문-6');
    await bridge.agentAnswers('답변-6');
    await bridge.until(() => slack.texts.length === 1 + prunedThread.length);

    const userCalls = slack.callsWith(USER_TOKEN);
    expect(new Set(userCalls.map((call) => call.method))).toEqual(new Set(['auth.test', 'chat.delete']));
    const deleted = userCalls.filter((call) => call.method === 'chat.delete');
    expect(deleted).toHaveLength(4);
    for (const call of deleted) {
      expect(call.args.channel).toBe(CHAT);
      expect(call.args.ts).not.toBe(ROOT_TS);
    }
    // Everything the bot wrote was deleted with the bot token instead.
    const botDeletes = slack.callsWith(BOT_TOKEN).filter((call) => call.method === 'chat.delete');
    expect(botDeletes).toHaveLength(4);
    // The user token never reached the Slack client's own Web API client.
    expect(slack.callsWith(USER_TOKEN).some((call) => ['chat.postMessage', 'chat.update', 'conversations.replies', 'reactions.add'].includes(call.method))).toBe(false);
  });

  it('does nothing without a user token, and says so once', async () => {
    slack.seed(5);
    const bridge = await launch({ userToken: false });
    const before = [...slack.texts];

    await bridge.userWrites('질문-6');
    await bridge.agentAnswers('답변-6');
    await vi.advanceTimersByTimeAsync(30_000);
    await bridge.userWrites('질문-7');
    await bridge.agentAnswers('답변-7');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(slack.texts).toEqual([...before, '질문-6', '답변-6', '질문-7', '답변-7']);
    expect(bridge.runEphemeralTurn).not.toHaveBeenCalled();
    expect(slack.calls.some((call) => call.method === 'chat.delete')).toBe(false);
    expect(bridge.notifications.filter(([message]) => message.includes('user token'))).toHaveLength(1);
  });

  it('deletes nothing when the summary cannot be made', async () => {
    slack.seed(5);
    const bridge = await launch();
    bridge.runEphemeralTurn.mockRejectedValue(new Error('model unavailable'));

    await bridge.userWrites('질문-6');
    await bridge.agentAnswers('답변-6');
    await bridge.until(() => bridge.notifications.some(([message]) => message.includes('model unavailable')));

    expect(slack.texts[0]).toBe('[VLM_Verifier] MoT');
    expect(slack.texts).toHaveLength(1 + 12);
    expect(slack.calls.some((call) => call.method === 'chat.delete' || call.method === 'chat.update')).toBe(false);
  });

  it('does not prune while a question is waiting for an answer in the thread, and prunes after it was answered', async () => {
    slack.seed(5);
    const bridge = await launch();
    const ask = bridge.tools.find((tool) => tool.name === 'ask');
    if (!ask) throw new Error('ask not registered');
    const answer = Promise.withResolvers<unknown>();
    const params = { questions: [{ id: 'go', question: '진행할까요?', options: [{ label: '진행' }, { label: '중지' }] }] };
    // Only the native-dialog seam of the context is exercised: the dialog stays open until `answer` resolves.
    const asking = ask.execute('call', params, undefined, undefined, { invokeTool: () => answer.promise });
    await bridge.until(() => slack.texts.some((text) => text.includes('결정이 필요합니다')));

    await bridge.userWrites('질문-6');
    await bridge.agentAnswers('답변-6');
    // Long enough for the automatic prune to wait out the session going quiet and give up.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(slack.calls.some((call) => call.method === 'chat.delete')).toBe(false);
    expect(bridge.runEphemeralTurn).not.toHaveBeenCalled();

    answer.resolve({ content: [], details: { results: [{ id: 'go', selectedOptions: ['진행'] }] } });
    await asking;
    await bridge.userWrites('질문-7');
    await bridge.agentAnswers('답변-7');
    await bridge.until(() => slack.calls.some((call) => call.method === 'chat.delete'));
    await bridge.until(() => slack.texts[0].includes(HEADING));

    expect(bridge.runEphemeralTurn).toHaveBeenCalledTimes(1);
    expect(slack.texts.slice(-2)).toEqual(['질문-7', '답변-7']);
  });

  it('refuses a user token of another Slack user before any summary is made, and leaves the thread alone', async () => {
    slack.seed(5);
    slack.userTokenOwner = 'U0SOMEONE9';
    const bridge = await launch();
    const before = [...slack.texts];

    await bridge.userWrites('질문-6');
    await bridge.agentAnswers('답변-6');
    await bridge.until(() => bridge.notifications.some(([message]) => message.includes('user token을 확인하지 못해')));

    expect(slack.texts).toEqual([...before, '질문-6', '답변-6']);
    expect(bridge.runEphemeralTurn).not.toHaveBeenCalled();
    expect(slack.calls.some((call) => call.method === 'chat.delete')).toBe(false);
    expect(slack.calls.some((call) => call.method === 'chat.update')).toBe(false);
  });

  it('does not prune a thread that is below the threshold', async () => {
    slack.seed(2);
    const bridge = await launch();

    await bridge.userWrites('질문-3');
    await bridge.agentAnswers('답변-3');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(slack.texts).toHaveLength(1 + 6);
    expect(bridge.runEphemeralTurn).not.toHaveBeenCalled();
    expect(slack.calls.some((call) => call.method === 'conversations.replies' && call.token === BOT_TOKEN)).toBe(true);
  });

  describe('commands', () => {
    it('`.bridge new` summarizes and deletes the whole history, then answers in the thread', async () => {
      slack.seed(5);
      const bridge = await launch();

      await bridge.userWrites('.bridge new');
      await bridge.until(() => slack.texts.length === 2 && slack.texts[1].includes('삭제했습니다'));

      expect(slack.texts[0]).toBe(`**[VLM_Verifier] MoT**\n\n${HEADING}\n- 요약 1`);
      expect(slack.texts[1]).toContain('이전 대화 6개를 요약하고 메시지 11개를 삭제했습니다');
      // A command is not a prompt for the agent, and the command's own message was pruned too.
      expect(bridge.pi.sendUserMessage).not.toHaveBeenCalled();
      expect(bridge.runEphemeralTurn.mock.calls[0][0].promptText).not.toContain('.bridge new');
    });

    it('`.bridge new` leaves a message written right after it, and that message still reaches the agent', async () => {
      slack.seed(5);
      const bridge = await launch();

      // Both are in Slack and in the inbox before the session reads either of them.
      bridge.queue('.bridge new');
      bridge.queue('질문-후속');
      await vi.advanceTimersByTimeAsync(600);
      await bridge.until(() => slack.texts.some((text) => text.includes('삭제했습니다')));
      await bridge.until(() => bridge.pi.sendUserMessage.mock.calls.length === 1);

      expect(slack.texts.slice(1)).toEqual(['질문-후속', expect.stringContaining('이전 대화 6개를 요약하고 메시지 11개를 삭제했습니다')]);
      expect(bridge.runEphemeralTurn.mock.calls[0][0].promptText).not.toContain('질문-후속');
      expect(bridge.pi.sendUserMessage).toHaveBeenCalledWith('[📱 @chanwoo via Slack]: 질문-후속');
    });

    it('`.bridge new` without a user token refuses and deletes nothing', async () => {
      slack.seed(5);
      const bridge = await launch({ userToken: false });
      const before = [...slack.texts];

      await bridge.userWrites('.bridge new');
      await bridge.until(() => slack.texts.some((text) => text.includes('user token이 없어 정리할 수 없습니다')));

      // The earlier history is intact: only the command and the refusal were added.
      expect(slack.texts).toEqual([...before, '.bridge new', expect.stringContaining('user token이 없어 정리할 수 없습니다')]);
      expect(slack.calls.some((call) => call.method === 'chat.delete')).toBe(false);
    });

    it('`.bridge new` while the session is busy refuses', async () => {
      slack.seed(5);
      const bridge = await launch();
      bridge.state.idle = false;

      await bridge.userWrites('.bridge new');
      await bridge.until(() => slack.texts.some((text) => text.includes('작업 중이라 정리하지 않았습니다')));

      expect(slack.calls.some((call) => call.method === 'chat.delete')).toBe(false);
    });

    it('`.bridge title` rewrites the root with the new title and keeps the summary', async () => {
      slack.seed(5);
      const bridge = await launch();
      await bridge.userWrites('.bridge new');
      await bridge.until(() => slack.texts.length === 2 && slack.texts[1].includes('삭제했습니다'));

      await bridge.userWrites('.bridge title  새   제목 ');
      await bridge.until(() => slack.texts.some((text) => text.includes('바꿨습니다')));

      expect(slack.texts[0]).toBe(`**새 제목**\n\n${HEADING}\n- 요약 1`);
      expect(slack.texts.at(-1)).toContain('"새 제목"');
      expect(storedConfig().slackRouting.threadMeta[`${CHAT}:${ROOT_TS}`].title).toBe('새 제목');
    });

    it('`.bridge keep` and `.bridge pruneat` change the global settings, and the new values apply at once', async () => {
      slack.seed(5);
      const bridge = await launch();

      await bridge.userWrites('.bridge keep 3');
      await bridge.until(() => slack.texts.some((text) => text.includes('최근 대화 3개')));
      expect(storedConfig()).toMatchObject({ threadKeep: 3, threadPruneAt: 6 });
      await bridge.userWrites('.bridge pruneat 12');
      await bridge.until(() => slack.texts.some((text) => text.includes('12개가 되면')));
      expect(storedConfig()).toMatchObject({ threadKeep: 3, threadPruneAt: 12 });
      await bridge.userWrites('.bridge pruneat 3');
      await bridge.until(() => slack.texts.some((text) => text.includes('남길 대화 수(3)')));
      expect(storedConfig().threadPruneAt).toBe(12);

      // 5 earlier interactions plus this one are below the new threshold of 12: nothing is pruned.
      await bridge.userWrites('질문-6');
      await bridge.agentAnswers('답변-6');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(bridge.runEphemeralTurn).not.toHaveBeenCalled();
    });

    it('`/slk-bridge title` and `/slk-bridge new` act on the current session\'s thread', async () => {
      slack.seed(5);
      const bridge = await launch();

      await bridge.command('title 터미널 제목');
      expect(slack.texts[0]).toBe('**터미널 제목**');
      expect(bridge.notifications.at(-1)).toEqual(['✏️ 스레드 제목을 "터미널 제목"(으)로 바꿨습니다.', 'info']);

      // The command waits for the prune, which waits on the deletion pacing: let fake time run meanwhile.
      const pruning = bridge.command('new');
      await bridge.until(() => slack.texts.length === 1);
      await pruning;
      expect(slack.texts[0]).toBe(`**터미널 제목**\n\n${HEADING}\n- 요약 1`);
      expect(bridge.notifications.at(-1)?.[0]).toContain('이전 대화 5개를 요약하고 메시지 10개를 삭제했습니다');
    });
  });
});
