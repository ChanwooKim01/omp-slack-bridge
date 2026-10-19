/**
 * Two omp sessions, one Slack DM. Unlike the other bridge tests, nothing about ownership is
 * faked here: both "processes" load the real config, lock, registry and inbox modules against one
 * shared home directory (each with its own lock identity, as separate processes have). Only Slack,
 * the agent and the session text helpers are fake, and the fake Slack enforces the real rule:
 * an event is delivered to the one open socket, never to a session that does not hold it.
 */

import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as OsModule from 'os';

const g = global as unknown as Record<string, unknown>;
const SESSION_A = '/tmp/two-sessions/a.jsonl';
const SESSION_B = '/tmp/two-sessions/b.jsonl';
const OFFLINE_NOTICE = '이 스레드의 세션이 꺼져 있습니다. Paseo에서 해당 에이전트를 열면 다시 연결됩니다.';

type MessageHandler = (message: unknown) => void;

/** The Slack side: which sockets are open, and everything posted. */
interface FakeSlack {
  sockets: Set<FakeSlackClient>;
  posts: Array<{ by: string; chatId: string; text: string; threadTs?: string; ts: string }>;
  counter: number;
}

class FakeSlackClient {
  isConnected = false;
  handler: MessageHandler = () => {};
  constructor(
    private readonly slack: FakeSlack,
    readonly owner: string,
  ) {}
  async connect() {
    this.isConnected = true;
    this.slack.sockets.add(this);
  }
  async disconnect() {
    this.isConnected = false;
    this.slack.sockets.delete(this);
  }
  onMessage(handler: MessageHandler) {
    this.handler = handler;
  }
  onError() {}
  async sendMessageInThread(chatId: string, text: string, threadTs?: string) {
    const ts = threadTs ?? `${1760000000 + ++this.slack.counter}.000100`;
    this.slack.posts.push({ by: this.owner, chatId, text, threadTs, ts });
    return ts;
  }
  async addReaction() {}
  async removeReaction() {}
  async sendFile() {}
}

describe('two sessions sharing one Slack DM', () => {
  let home: string;
  let slack: FakeSlack;
  let launching = '';
  const processes: Process[] = [];

  interface Process {
    name: string;
    sessionFile: string;
    pi: { sendUserMessage: Mock };
    command(args: string): Promise<void>;
    shutdown(): Promise<void>;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    home = mkdtempSync(join(tmpdir(), 'slk-bridge-two-sessions-'));
    slack = { sockets: new Set(), posts: [], counter: 0 };
    // The paired DM, the trusted user, and tokens: the state a configured installation has.
    mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.omp', 'agent', 'slk-bridge.json'),
      JSON.stringify({
        slack: { botToken: 'xoxb-test', appToken: 'xapp-test' },
        auth: { trustedUser: 'U123:testuser', userChats: { U123: 'D123' }, claimOpen: false },
      }),
    );
  });

  afterEach(async () => {
    for (const process of processes.splice(0)) await process.shutdown();
    vi.useRealTimers();
    delete g.__slkBridgeConnected;
    delete g.__slkBridgeOwner;
    delete g.__slkBridgeInstanceId;
    rmSync(home, { recursive: true, force: true });
  });

  /** Start an omp process hosting `sessionFile`: its own module graph and its own lock identity. */
  async function launch(name: string, sessionFile: string): Promise<Process> {
    delete g.__slkBridgeInstanceId;
    vi.resetModules();
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof OsModule>('os');
      return { ...actual, homedir: () => home };
    });
    launching = name;
    vi.doMock('../../src/slack/client.js', () => ({ SlackClient: class extends FakeSlackClient {
      constructor() {
        super(slack, launching);
      }
    } }));
    vi.doMock('../../src/auth/challenge.js', () => ({
      ChallengeAuth: class {
        getNotificationChatId() { return undefined; }
        getStats() { return { trustedUser: 'testuser', channels: 0 }; }
        loadFromConfig() {}
        exportConfig() { return {}; }
        releaseClaim() { return 0; }
      },
    }));
    vi.doMock('../../src/session/handlers.js', () => ({
      getConversationHistory: () => [],
      getLastAssistantMessageInfo: () => null,
      buildSlackFooterText: vi.fn().mockResolvedValue('footer'),
      buildSlackSessionRootText: vi.fn(async () => `root ${sessionFile}`),
      listRecentSessions: vi.fn().mockResolvedValue([]),
      buildSessionListText: vi.fn().mockResolvedValue(''),
    }));
    vi.doMock('../../src/session/tmux.js', () => ({
      runTmuxPiConnect: vi.fn(),
      resolvePathInput: (input: string) => input,
      buildTmuxConnectSummary: vi.fn(),
    }));
    vi.doMock('../../src/ui/main-menu.js', () => ({ openMainMenu: vi.fn() }));

    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
    let command: { handler(args: string, context: unknown): Promise<void> } | undefined;
    const pi = {
      on: (event: string, handler: (event: unknown, context: unknown) => Promise<void>) => handlers.set(event, handler),
      registerTool: vi.fn(),
      registerCommand: (_name: string, options: { handler(args: string, context: unknown): Promise<void> }) => {
        command = options;
      },
      sendUserMessage: vi.fn(),
      getCommands: () => [],
    };
    // Dynamic: each process needs its own module graph, built after the mocks above.
    const bridge = await import('../../src/bridge/index');
    bridge.default(pi as never);

    const ctx = {
      sessionManager: { getSessionFile: () => sessionFile, getBranch: () => [] },
      cwd: '/tmp/project',
      model: { provider: 'test', id: 'model', contextWindow: 8000 },
      getContextUsage: () => ({ percent: 1, contextWindow: 8000 }),
      isIdle: () => true,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };
    await handlers.get('session_start')?.({}, ctx);

    const process: Process = {
      name,
      sessionFile,
      pi,
      command: (args) => command!.handler(args, ctx),
      shutdown: async () => {
        await handlers.get('session_shutdown')?.({}, ctx);
      },
    };
    processes.push(process);
    return process;
  }

  /** The user writes in Slack; Slack hands the event to whichever socket is open. */
  async function userWrites(overrides: { content: string; threadTs?: string; messageId: string }) {
    expect(slack.sockets.size, 'Slack delivers to exactly one open socket').toBe(1);
    const [socket] = [...slack.sockets];
    socket.handler({
      chatId: 'D123',
      content: overrides.content,
      username: 'testuser',
      userId: 'U123',
      timestamp: new Date(),
      messageId: overrides.messageId,
      isGroupChat: false,
      wasMentioned: false,
      threadId: overrides.threadTs ?? overrides.messageId,
      isThreadReply: overrides.threadTs !== undefined,
    });
    // Let the routing, the inbox poll and the follow-up handling run.
    await vi.advanceTimersByTimeAsync(600);
  }

  const rootThreadOf = (sessionFile: string) =>
    slack.posts.find((post) => post.text === `root ${sessionFile}`)?.ts as string;
  const openSocketOwners = () => [...slack.sockets].map((socket) => socket.owner);

  it('keeps one socket open, routes each reply to the session that owns the thread, and hands the role over', async () => {
    const a = await launch('A', SESSION_A);
    await a.command('connect');
    const b = await launch('B', SESSION_B);
    await b.command('connect');

    // A joined first and is the router; B joined without taking the socket.
    expect(openSocketOwners()).toEqual(['A']);
    const threadA = rootThreadOf(SESSION_A);
    const threadB = rootThreadOf(SESSION_B);
    expect(threadA).toBeTruthy();
    expect(threadB).toBeTruthy();
    expect(slack.posts.filter((post) => post.by === 'B').map((post) => post.text)).toEqual([`root ${SESSION_B}`]);

    // A reply in B's thread arrives at A's socket and reaches B's agent through B's inbox.
    await userWrites({ content: 'status on B?', threadTs: threadB, messageId: '1760000100.000001' });
    expect(b.pi.sendUserMessage.mock.calls).toEqual([['[📱 @testuser via Slack]: status on B?']]);
    expect(a.pi.sendUserMessage).not.toHaveBeenCalled();

    // A reply in A's own thread stays in A.
    await userWrites({ content: 'status on A?', threadTs: threadA, messageId: '1760000100.000002' });
    expect(a.pi.sendUserMessage.mock.calls).toEqual([['[📱 @testuser via Slack]: status on A?']]);
    expect(b.pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // A leaves: B notices the vacant router role and takes the socket.
    await a.command('disconnect');
    expect(openSocketOwners()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(openSocketOwners()).toEqual(['B']);

    // A's thread now belongs to a session that is not running; B's agent is not disturbed by it.
    await userWrites({ content: 'anyone there?', threadTs: threadA, messageId: '1760000100.000003' });
    expect(slack.posts.at(-1)).toMatchObject({ by: 'B', text: OFFLINE_NOTICE, threadTs: threadA });
    expect(b.pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // B's own thread is handled by the router itself, with no inbox in between.
    await userWrites({ content: 'and B?', threadTs: threadB, messageId: '1760000100.000004' });
    expect(b.pi.sendUserMessage.mock.calls.at(-1)).toEqual(['[📱 @testuser via Slack]: and B?']);
  });

  it('never opens a second socket while a live router holds the lock, and a restarted session rejoins', async () => {
    const a = await launch('A', SESSION_A);
    await a.command('connect');
    const b = await launch('B', SESSION_B);
    await b.command('connect');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(openSocketOwners()).toEqual(['A']);

    // The router's process exits; its persisted join survives, so the same session rejoins on start.
    await a.shutdown();
    await vi.advanceTimersByTimeAsync(2000);
    expect(openSocketOwners()).toEqual(['B']);

    const restartedA = await launch('A2', SESSION_A);
    await vi.advanceTimersByTimeAsync(2000);
    // B kept the router role; the restarted A is a member again and reachable through its inbox.
    expect(openSocketOwners()).toEqual(['B']);
    await userWrites({ content: 'welcome back', threadTs: rootThreadOf(SESSION_A), messageId: '1760000100.000005' });
    expect(restartedA.pi.sendUserMessage.mock.calls).toEqual([['[📱 @testuser via Slack]: welcome back']]);
  });
});
