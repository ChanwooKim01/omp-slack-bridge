/**
 * bridge-harness.ts — Behavioral test harness for bridge/index.ts.
 *
 * Drives the extension's lifecycle from the outside:
 *  - captures pi.on handlers
 *  - mocks ExtensionContext, SlackClient, config, auth, lock, tmux, handlers
 *  - exposes the captured client message handler so tests can inject Slack messages
 *  - records every sendMessageInThread call so tests can assert on what was pushed to Slack
 *
 * The router lock is a stateful fake (`h.lock`): a test can make another process the router,
 * lose the lock, or clear the local flag. The session registry and the inbox are the real
 * modules writing under the temporary home directory, so tests assert on real files.
 */

import { vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as OsModule from 'os';
import type * as InboxModule from '../../src/session/inbox';
import type * as LockModule from '../../src/session/lock';
import type * as RegistryModule from '../../src/session/registry';

export type BranchEntry = {
  type: string;
  id?: string;
  message?: { role: string; content: any; stopReason?: string };
};

export interface HarnessState {
  branch: BranchEntry[];
  sessionFile: string;
  cwd: string;
  trustedChatId: string;
  /** command-context isIdle (handover idle vs busy) */
  cmdIdle: boolean;
  /** session-context isIdle (message forwarding idle vs followUp) */
  agentIdle: boolean;
  autoConnect: boolean;
  hideToolCalls?: boolean;
  slackRouting?: any;
  optedOutSessions?: string[];
  /** Sessions that joined the bridge before this process started (the persisted join list). */
  joinedSessions?: string[];
}

export interface SendCall {
  chatId: string;
  text: string;
  threadTs?: string;
  footerText?: string;
}

/** Who owns the router lock record, and whether this process's local flag is set. */
export interface FakeLock {
  owner: { pid: number; owner: string } | null;
  heldLocally: boolean;
}

export interface BridgeHarness {
  pi: any;
  registeredCommand: any;
  capturedOn: Map<string, (event: any, context: any) => Promise<void>>;
  slackClient: any;
  /** Every SlackClient the bridge constructed, oldest first. */
  clients: any[];
  clientOnMessage: (msg: any) => void;
  sendCalls: SendCall[];
  notifyCalls: Array<[string, string]>;
  sessionCtx: any;
  tmpDir: string;
  state: HarnessState;
  lock: FakeLock;
  /** The persisted bridge config the mocked config module reads and updates. */
  config: any;
  /** The tmux module mock, for asserting that no tmux handoff was started. */
  tmux: { runTmuxPiConnect: any };
  registry: typeof RegistryModule;
  inbox: typeof InboxModule;
  /** drive helpers */
  sessionStart(): Promise<void>;
  /** Make `sessionFile` the hosted session and report it the way OMP does. */
  switchSession(sessionFile: string): Promise<void>;
  invokeCommand(args: string, cmdCtx?: any): Promise<void>;
  invokeAgentEnd(event: any): Promise<void>;
  invokeClientMessage(msg: any): Promise<void>;
  /** Resolve once a notification containing `text` has been shown. */
  waitForNotification(text: string): Promise<void>;
  inboxFiles(sessionPath: string): string[];
  sendUserMessages(): any[];
  /** Fire session_shutdown the way the host does when the session ends. */
  sessionShutdown(): Promise<void>;
  /** Make every sendMessageInThread call wait until resolveSend/resolveAllSends. */
  setDeferSends(on: boolean): void;
  resolveSend(i: number, ts?: string): void;
  resolveAllSends(ts?: string): void;
  reset(): void;
}

const g = global as any;

/** A PID that cannot belong to a running process (same convention as the lock tests). */
export const DEAD_PID = 1073741824;
/** The instance id the lock mock reports for this process. */
const INSTANCE_ID = 'inst';

export async function createBridgeHarness(state: HarnessState): Promise<BridgeHarness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'slk-bridge-harness-'));
  delete g.__slkBridgeInstanceId;
  delete g.__slkBridgeConnected;
  delete g.__slkBridgeOwner;
  vi.resetModules();

  const sendCalls: SendCall[] = [];
  const notifyCalls: Array<[string, string]> = [];
  const clients: any[] = [];
  let clientOnMessage: (msg: any) => void = () => {};
  let deferSends = false;
  const deferredSends: Array<(ts: string) => void> = [];
  const tmuxMock = {
    runTmuxPiConnect: vi.fn().mockResolvedValue({ sessionName: 's', cwd: '', bridgeCommand: '', paneOutput: '', cleanupScheduled: false }),
    resolvePathInput: (input: string, _base: string) => input,
    buildTmuxConnectSummary: vi.fn().mockReturnValue('summary'),
  };

  class MockSlackClient {
    /** The Socket Mode connection, not the ability to post. */
    isConnected = false;
    connect = vi.fn(async () => {
      this.isConnected = true;
    });
    disconnect = vi.fn(async () => {
      this.isConnected = false;
    });
    sendMessageInThread = vi.fn(async (chatId: string, text: string, threadTs?: string, footerText?: string) => {
      sendCalls.push({ chatId, text, threadTs, footerText });
      const ts = threadTs || `ts-${sendCalls.length}`;
      if (deferSends) {
        return new Promise<string>((resolve) => {
          deferredSends.push((resolveTs?: string) => resolve(resolveTs ?? ts));
        });
      }
      return ts;
    });
    onMessage = vi.fn((handler: any) => {
      clientOnMessage = handler;
    });
    onError = vi.fn();
    addReaction = vi.fn().mockResolvedValue(undefined);
    removeReaction = vi.fn().mockResolvedValue(undefined);
    sendFile = vi.fn().mockResolvedValue(undefined);
    constructor() {
      clients.push(this);
    }
  }

  const capturedOn = new Map<string, (event: any, context: any) => Promise<void>>();
  let registeredCommand: any = null;
  const pi = {
    on: vi.fn((event: string, handler: any) => {
      capturedOn.set(event, handler);
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, opts: any) => {
      registeredCommand = { name, ...opts };
    }),
    sendUserMessage: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
  };

  // ── Re-implemented conversation helpers so the harness stays self-contained ──
  function extractTextSafe(message: { content?: unknown }): string {
    if (!message?.content) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return (message.content as any[])
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text ?? '')
        .join('\n');
    }
    return '';
  }
  function toHistory(branch: BranchEntry[]) {
    const entries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    for (const entry of branch) {
      if (entry.type !== 'message' || !entry.message) continue;
      if (entry.message.role === 'user') {
        const text = extractTextSafe(entry.message).trim();
        if (text) entries.push({ role: 'user', text });
      } else if (entry.message.role === 'assistant') {
        if (entry.message.stopReason && entry.message.stopReason !== 'stop') continue;
        const text = extractTextSafe(entry.message).trim();
        if (text) entries.push({ role: 'assistant', text });
      }
    }
    return entries;
  }
  function lastAssistantInfo(branch: BranchEntry[]) {
    const history = toHistory(branch);
    const last = [...history].reverse().find((e) => e.role === 'assistant');
    return last ? { entryId: `e-${last.text}`, text: last.text } : null;
  }

  // ── Module mocks ──────────────────────────────────────────────────────────
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof OsModule>('os');
    return { ...actual, homedir: () => tmpDir };
  });

  vi.doMock('../../src/auth/challenge.js', () => ({
    ChallengeAuth: class {
      getNotificationChatId() { return state.trustedChatId; }
      getStats() { return { trustedUser: 'testuser', channels: 0 }; }
      loadFromConfig() {}
      exportConfig() { return {}; }
      releaseClaim() { return 0; }
    },
  }));

  vi.doMock('../../src/slack/client.js', () => ({
    SlackClient: MockSlackClient,
  }));

  // Stateful fake of the router lock. It mirrors the real module's contract: acquire only claims a
  // vacant lock, force overwrites, release frees only a lock this process owns.
  const lock: FakeLock = { owner: null, heldLocally: false };
  const me = { pid: process.pid, owner: INSTANCE_ID };
  const isMe = (owner: FakeLock['owner']) => !!owner && owner.pid === me.pid && owner.owner === me.owner;
  const realLock = await vi.importActual<typeof LockModule>('../../src/session/lock');
  vi.doMock('../../src/session/lock.js', () => ({
    acquireLock: vi.fn(() => {
      if (lock.owner && !isMe(lock.owner)) return false;
      lock.owner = { ...me };
      lock.heldLocally = true;
      return true;
    }),
    forceAcquireLock: vi.fn(() => {
      const previous = lock.owner;
      lock.owner = { ...me };
      lock.heldLocally = true;
      return previous;
    }),
    isLockHeldLocally: vi.fn(() => lock.heldLocally),
    isCurrentLockOwner: vi.fn(() => lock.heldLocally && isMe(lock.owner)),
    releaseLock: vi.fn(() => {
      lock.heldLocally = false;
      if (isMe(lock.owner)) lock.owner = null;
    }),
    getInstanceId: vi.fn(() => INSTANCE_ID),
    getLockOwner: vi.fn(() => lock.owner),
    isProcessAlive: realLock.isProcessAlive,
  }));

  vi.doMock('../../src/session/tmux.js', () => ({
    runTmuxPiConnect: tmuxMock.runTmuxPiConnect,
    resolvePathInput: tmuxMock.resolvePathInput,
    buildTmuxConnectSummary: tmuxMock.buildTmuxConnectSummary,
  }));

  vi.doMock('../../src/session/handlers.js', () => ({
    getConversationHistory: () => toHistory(state.branch),
    getLastAssistantMessageInfo: () => lastAssistantInfo(state.branch),
    buildSlackFooterText: vi.fn().mockResolvedValue('footer'),
    buildSlackSessionRootText: vi.fn(async () => `root ${state.sessionFile}`),
    listRecentSessions: vi.fn().mockResolvedValue([]),
    buildSessionListText: vi.fn().mockResolvedValue(''),
  }));

  // Stateful config mock so routing.ts mutations persist via updateConfig.
  const configState: any = {
    slack: { botToken: 'xoxb-test', appToken: 'xapp-test' },
    autoConnect: state.autoConnect,
    hideToolCalls: state.hideToolCalls,
    slackRouting: state.slackRouting,
    optedOutSessions: state.optedOutSessions,
    joinedSessions: state.joinedSessions,
  };
  vi.doMock('../../src/config/index.js', () => ({
    loadConfig: vi.fn(() => configState),
    updateConfig: vi.fn((mutator: (config: any) => void) => {
      mutator(configState);
      return configState;
    }),
  }));

  vi.doMock('../../src/ui/main-menu.js', () => ({
    openMainMenu: vi.fn(),
  }));

  // Dynamic import: the module graph is reset and re-mocked for every harness (see vi.resetModules above).
  const bridge = await import('../../src/bridge/index');
  bridge.default(pi);
  // Dynamic like the bridge import above: the module graph is rebuilt per harness so these
  // share the bridge's registry/inbox instances and the temporary home directory.
  const registry = await import('../../src/session/registry');
  const inbox = await import('../../src/session/inbox');

  const sessionCtx = {
    sessionManager: {
      getSessionFile: () => state.sessionFile,
      getBranch: () => state.branch,
    },
    cwd: state.cwd,
    model: { provider: 'test', id: 'model', contextWindow: 8000 },
    getContextUsage: () => ({ percent: 50, contextWindow: 8000 }),
    isIdle: () => state.agentIdle,
    ui: {
      notify: vi.fn((message: string, level: string) => notifyCalls.push([message, level])),
      setStatus: vi.fn(),
    },
  };

  return {
    pi,
    registeredCommand,
    capturedOn,
    get slackClient() { return clients[clients.length - 1] ?? null; },
    clients,
    tmux: tmuxMock,
    clientOnMessage,
    sendCalls,
    notifyCalls,
    sessionCtx,
    tmpDir,
    state,
    lock,
    config: configState,
    registry,
    inbox,
    async sessionStart() {
      const handler = capturedOn.get('session_start');
      if (handler) await handler({}, sessionCtx);
    },
    async switchSession(sessionFile: string) {
      state.sessionFile = sessionFile;
      const handler = capturedOn.get('session_switch');
      if (handler) await handler({}, sessionCtx);
    },
    async invokeCommand(args, cmdCtx) {
      const ctx2 = cmdCtx ?? {
        ui: { notify: (m: string, l: string) => notifyCalls.push([m, l]) },
        isIdle: () => state.cmdIdle,
      };
      await registeredCommand.handler(args, ctx2);
    },
    async invokeAgentEnd(event) {
      const handler = capturedOn.get('agent_end');
      if (handler) await handler(event, sessionCtx);
    },
    async invokeClientMessage(msg) {
      clientOnMessage(msg);
      // The bridge's handler is fire-and-forget (`void routeIncomingSlackMessage`);
      // await a macrotask so the all-mocked async chain completes before assertions.
      await new Promise((r) => setTimeout(r, 0));
    },
    async waitForNotification(text: string) {
      await vi.waitFor(() => {
        if (!notifyCalls.some(([message]) => message.includes(text))) {
          throw new Error(`no notification containing "${text}" yet`);
        }
      });
    },
    async sessionShutdown() {
      const handler = capturedOn.get('session_shutdown');
      if (handler) await handler({}, sessionCtx);
    },
    setDeferSends(on: boolean) {
      deferSends = on;
    },
    resolveSend(i: number, ts?: string) {
      deferredSends[i]?.(ts);
    },
    resolveAllSends(ts?: string) {
      while (deferredSends.length > 0) {
        deferredSends.shift()?.(ts);
      }
    },
    inboxFiles(sessionPath: string) {
      const dir = join(tmpDir, '.omp', 'agent', 'slk-bridge-inbox', registry.sessionKey(sessionPath));
      try {
        return readdirSync(dir).filter((name) => name.endsWith('.json'));
      } catch {
        return [];
      }
    },
    sendUserMessages() {
      return pi.sendUserMessage.mock.calls as any[];
    },
    reset() {
      vi.useRealTimers();
      delete g.__slkBridgeConnected;
      delete g.__slkBridgeOwner;
      delete g.__slkBridgeInstanceId;
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
