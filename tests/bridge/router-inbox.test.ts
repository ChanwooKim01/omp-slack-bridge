/**
 * Several omp sessions share one Slack DM. Exactly one process — the router — holds the Slack
 * socket; every joined session posts with the bot token; a reply in a session's thread reaches
 * that session through its inbox. These tests drive the bridge through its hooks and commands
 * and assert on what ends up in Slack, in the inbox directories, and on the router lock.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalMessage } from '../../src/types/index';
import { type BridgeHarness, DEAD_PID, type HarnessState, createBridgeHarness } from '../helpers/bridge-harness';

const ROUTER = '/tmp/session-router';
const OTHER = '/tmp/session-other';
const OFFLINE_NOTICE = '이 스레드의 세션이 꺼져 있습니다. Paseo에서 해당 에이전트를 열면 다시 연결됩니다.';
/** A router that belongs to some other omp process. */
const OTHER_ROUTER = { pid: 4242, owner: 'other-process' };

let h: BridgeHarness;

afterEach(async () => {
  await h.capturedOn.get('session_shutdown')?.({}, h.sessionCtx);
  h.reset();
});

/** Build a harness whose periodic checks run on fake intervals; the session has not started yet. */
async function build(overrides: Partial<HarnessState> = {}): Promise<BridgeHarness> {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  h = await createBridgeHarness({
    branch: [],
    sessionFile: ROUTER,
    cwd: '/tmp/project',
    trustedChatId: 'D123',
    cmdIdle: true,
    agentIdle: true,
    autoConnect: true,
    joinedSessions: [ROUTER],
    slackRouting: {
      threadsByKey: {
        'D123:T-router': { sessionPath: ROUTER, updatedAt: '2026-10-19T00:00:00.000Z' },
        'D123:T-other': { sessionPath: OTHER, updatedAt: '2026-10-19T00:00:00.000Z' },
      },
    },
    ...overrides,
  });
  return h;
}

/** A session that joined before the process started and is the only one around: it becomes the router. */
async function startRouter(overrides: Partial<HarnessState> = {}): Promise<BridgeHarness> {
  await build(overrides);
  await h.sessionStart();
  await vi.waitFor(() => expect(h.slackClient.isConnected).toBe(true));
  return h;
}

function slackMessage(overrides: Partial<ExternalMessage> = {}): ExternalMessage {
  return {
    chatId: 'D123',
    content: 'ping',
    username: 'testuser',
    userId: 'U123',
    timestamp: new Date('2026-10-19T12:00:00.000Z'),
    messageId: '900.000001',
    isGroupChat: false,
    wasMentioned: false,
    threadId: 'T-router',
    isThreadReply: true,
    ...overrides,
  };
}

const iAmRouter = () => h.lock.heldLocally && h.lock.owner?.pid === process.pid && h.lock.owner.owner === 'inst';

describe('router: where a Slack message goes', () => {
  it('handles a reply in its own thread itself', async () => {
    await startRouter();

    await h.invokeClientMessage(slackMessage({ content: 'my own thread' }));

    expect(h.sendUserMessages().map((call) => call[0])).toEqual(['[📱 @testuser via Slack]: my own thread']);
    expect(h.inboxFiles(OTHER)).toEqual([]);
  });

  it('hands a reply in another live session\'s thread to that session instead of handling it', async () => {
    await startRouter();
    h.registry.registerSession(OTHER);

    await h.invokeClientMessage(slackMessage({ threadId: 'T-other', content: 'for the other one' }));

    expect(h.sendUserMessages()).toEqual([]);
    expect(h.sendCalls).toEqual([]);
    expect(h.slackClient.addReaction).not.toHaveBeenCalled();
    const queued = h.inbox.drainInbox(OTHER);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      chatId: 'D123',
      content: 'for the other one',
      messageId: '900.000001',
      threadId: 'T-other',
      isThreadReply: true,
    });
    expect(queued[0].timestamp.toISOString()).toBe('2026-10-19T12:00:00.000Z');
  });

  it('tells the user when the thread\'s session is not running, and leaves the thread with its session', async () => {
    await startRouter();

    await h.invokeClientMessage(slackMessage({ threadId: 'T-other' }));

    expect(h.sendCalls).toEqual([{ chatId: 'D123', text: OFFLINE_NOTICE, threadTs: 'T-other', footerText: undefined }]);
    expect(h.sendUserMessages()).toEqual([]);
    expect(h.inboxFiles(OTHER)).toEqual([]);
    expect(h.config.slackRouting.threadsByKey['D123:T-other'].sessionPath).toBe(OTHER);
  });

  it('treats a session whose process died as not running, and forgets its stale registration', async () => {
    await startRouter();
    h.registry.registerSession(OTHER, { pid: DEAD_PID, instanceId: 'gone' });

    await h.invokeClientMessage(slackMessage({ threadId: 'T-other' }));

    expect(h.sendCalls.map((call) => call.text)).toEqual([OFFLINE_NOTICE]);
    expect(h.inboxFiles(OTHER)).toEqual([]);
    expect(h.registry.readRegistration(OTHER)).toBeNull();
  });

  it('handles a top-level message itself and adopts the thread it starts', async () => {
    await startRouter();

    await h.invokeClientMessage(slackMessage({ threadId: '900.000001', isThreadReply: false, content: 'new topic' }));

    expect(h.sendUserMessages().map((call) => call[0])).toEqual(['[📱 @testuser via Slack]: new topic']);
    expect(h.config.slackRouting.threadsByKey['D123:900.000001'].sessionPath).toBe(ROUTER);
  });

  it('handles a reply in a thread nobody owns itself and adopts the thread', async () => {
    await startRouter();

    await h.invokeClientMessage(slackMessage({ threadId: 'T-unmapped', content: 'orphan thread' }));

    expect(h.sendUserMessages().map((call) => call[0])).toEqual(['[📱 @testuser via Slack]: orphan thread']);
    expect(h.config.slackRouting.threadsByKey['D123:T-unmapped'].sessionPath).toBe(ROUTER);
  });

  it('keeps `.bridge resume` in the router even inside another session\'s thread', async () => {
    await startRouter();
    h.registry.registerSession(OTHER);

    await h.invokeClientMessage(slackMessage({ threadId: 'T-other', content: '.bridge resume' }));

    expect(h.inboxFiles(OTHER)).toEqual([]);
    expect(h.sendCalls.map((call) => call.text)).not.toContain(OFFLINE_NOTICE);
    expect(h.sendUserMessages()).toEqual([]);
  });
});

describe('session inbox', () => {
  const queue = (sessionPath: string, overrides: Partial<ExternalMessage> = {}) =>
    h.inbox.enqueueInboxMessage(sessionPath, slackMessage(overrides));

  it('hands a queued message to the agent once, marks it as being worked on, and removes the file', async () => {
    await startRouter();
    queue(ROUTER, { content: 'from the inbox' });
    expect(h.inboxFiles(ROUTER)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(h.sendUserMessages()).toHaveLength(1));

    expect(h.sendUserMessages()[0]).toEqual(['[📱 @testuser via Slack]: from the inbox']);
    expect(h.inboxFiles(ROUTER)).toEqual([]);
    expect(h.slackClient.addReaction).toHaveBeenCalledWith('D123', '900.000001', 'hourglass_flowing_sand');
    expect(h.config.slackRouting.activeThreadBySessionChat[`${ROUTER}:D123`].threadTs).toBe('T-router');

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sendUserMessages()).toHaveLength(1);
  });

  it('handles a message that was queued twice only once', async () => {
    await startRouter();
    queue(ROUTER, { content: 'duplicate' });
    queue(ROUTER, { content: 'duplicate' });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(h.sendUserMessages()).toHaveLength(1));

    queue(ROUTER, { content: 'duplicate' });
    await vi.advanceTimersByTimeAsync(500);

    expect(h.sendUserMessages()).toHaveLength(1);
    expect(h.inboxFiles(ROUTER)).toEqual([]);
  });

  it('delivers messages in the order they were queued, as follow-ups while the agent is busy', async () => {
    await startRouter({ agentIdle: false });
    queue(ROUTER, { content: 'first', messageId: '900.000001' });
    queue(ROUTER, { content: 'second', messageId: '900.000002' });
    queue(ROUTER, { content: 'third', messageId: '900.000003' });

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(h.sendUserMessages()).toHaveLength(3));

    expect(h.sendUserMessages()).toEqual([
      ['[📱 @testuser via Slack]: first', { deliverAs: 'followUp' }],
      ['[📱 @testuser via Slack]: second', { deliverAs: 'followUp' }],
      ['[📱 @testuser via Slack]: third', { deliverAs: 'followUp' }],
    ]);
  });

  it('leaves another session\'s inbox alone', async () => {
    await startRouter();
    queue(OTHER, { content: 'not mine', threadId: 'T-other' });

    await vi.advanceTimersByTimeAsync(2000);

    expect(h.sendUserMessages()).toEqual([]);
    expect(h.inboxFiles(OTHER)).toHaveLength(1);
  });

  it('is not read by a session that never joined the bridge', async () => {
    await build({ joinedSessions: [] });
    await h.sessionStart();
    queue(ROUTER, { content: 'nobody asked' });

    await vi.advanceTimersByTimeAsync(2000);

    expect(h.sendUserMessages()).toEqual([]);
    expect(h.inboxFiles(ROUTER)).toHaveLength(1);
  });

  // Messages read in one poll are all queued before the first has run. One that leaves the bridge
  // must void the ones behind it: they were accepted for a membership that no longer exists.
  it('drops messages that were already queued when the session leaves', async () => {
    await startRouter();
    queue(ROUTER, { content: '.bridge disconnect', messageId: '900.000001' });
    queue(ROUTER, { content: 'still there?', messageId: '900.000002' });

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(h.registry.isSessionLive(ROUTER)).toBe(false));
    await vi.advanceTimersByTimeAsync(500);

    expect(h.sendUserMessages()).toEqual([]);
    expect(h.slackClient.addReaction).not.toHaveBeenCalled();
    expect(h.config.joinedSessions).toBeUndefined();
    expect(h.inboxFiles(ROUTER)).toEqual([]);
  });
});

describe('router election', () => {
  it('a joined session claims the router role when nobody holds it, and registers itself', async () => {
    await startRouter();

    expect(iAmRouter()).toBe(true);
    expect(h.registry.isSessionLive(ROUTER)).toBe(true);
  });

  it.each([
    ['autoConnect is off', { autoConnect: false }],
    ['the session opted out', { optedOutSessions: [ROUTER] }],
  ])('does not claim the router role on its own when %s', async (_label, overrides) => {
    await build(overrides);
    await h.sessionStart();

    await vi.advanceTimersByTimeAsync(6000);

    expect(h.lock.owner).toBeNull();
    expect(h.slackClient.isConnected).toBe(false);
    expect(h.registry.isSessionLive(ROUTER)).toBe(true);
  });

  it('never displaces a live router on its own, and takes over when asked with /slk-bridge router', async () => {
    await build();
    h.lock.owner = { ...OTHER_ROUTER };
    await h.sessionStart();

    await vi.advanceTimersByTimeAsync(6000);
    expect(h.lock.owner).toEqual(OTHER_ROUTER);
    expect(h.slackClient.isConnected).toBe(false);

    await h.invokeCommand('router');

    expect(iAmRouter()).toBe(true);
    expect(h.slackClient.isConnected).toBe(true);
    expect(h.notifyCalls.map(([message]) => message)).toContain('✅ This session is now the Slack router');
  });

  it('claims the role within a couple of seconds once the live router is gone', async () => {
    await build();
    h.lock.owner = { ...OTHER_ROUTER };
    await h.sessionStart();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.slackClient.isConnected).toBe(false);

    h.lock.owner = null; // the router's process died and its stale lock was cleaned
    await vi.advanceTimersByTimeAsync(2000);

    await vi.waitFor(() => expect(h.slackClient.isConnected).toBe(true));
    expect(iAmRouter()).toBe(true);
  });

  describe('losing the lock', () => {
    it.each([
      ['another process took it over', () => { h.lock.owner = { ...OTHER_ROUTER }; }],
      ['the local flag was already cleared while the socket stayed open', () => { h.lock.heldLocally = false; }],
    ])('closes the socket when %s', async (_label, lose) => {
      await startRouter();
      expect(h.slackClient.isConnected).toBe(true);

      lose();
      await vi.advanceTimersByTimeAsync(250);

      await vi.waitFor(() => expect(h.slackClient.isConnected).toBe(false));
      expect(h.lock.heldLocally).toBe(false);
      expect(h.notifyCalls.map(([message]) => message)).toContain('🔄 slk-bridge router role moved to another session');
    });

    it('does not touch the new owner\'s lock record', async () => {
      await startRouter();
      h.lock.owner = { ...OTHER_ROUTER };

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(h.slackClient.isConnected).toBe(false));

      expect(h.lock.owner).toEqual(OTHER_ROUTER);
    });
  });
});

describe('join and leave', () => {
  it('connect joins: registers the session, remembers the join, posts its root thread once, and becomes router', async () => {
    await build({ joinedSessions: undefined });
    await h.sessionStart();
    expect(h.registry.isSessionLive(ROUTER)).toBe(false);

    await h.invokeCommand('connect');
    await h.invokeCommand('connect');

    expect(h.registry.isSessionLive(ROUTER)).toBe(true);
    expect(h.config.joinedSessions).toEqual([ROUTER]);
    expect(h.sendCalls).toEqual([{ chatId: 'D123', text: `root ${ROUTER}`, threadTs: undefined, footerText: undefined }]);
    expect(iAmRouter()).toBe(true);
    expect(h.notifyCalls.at(-1)).toEqual(['✅ Joined the Slack bridge. This session is the router.', 'info']);
  });

  it('connect joins without stealing the router role from a live router', async () => {
    await build({ joinedSessions: undefined });
    h.lock.owner = { ...OTHER_ROUTER };
    await h.sessionStart();

    await h.invokeCommand('connect');

    expect(h.registry.isSessionLive(ROUTER)).toBe(true);
    expect(h.lock.owner).toEqual(OTHER_ROUTER);
    expect(h.slackClient.isConnected).toBe(false);
    expect(h.notifyCalls.at(-1)).toEqual(['✅ Joined the Slack bridge. Another session is the router.', 'info']);
  });

  it('disconnect leaves: unregisters, forgets the join, drops queued messages, releases the router role, and goes silent', async () => {
    await startRouter();
    h.inbox.enqueueInboxMessage(ROUTER, slackMessage());

    await h.invokeCommand('disconnect');

    expect(h.registry.isSessionLive(ROUTER)).toBe(false);
    expect(h.config.joinedSessions).toBeUndefined();
    expect(h.inboxFiles(ROUTER)).toEqual([]);
    expect(h.slackClient.isConnected).toBe(false);
    expect(h.lock.owner).toBeNull();

    await h.capturedOn.get('tool_approval_requested')?.({ toolName: 'bash' }, h.sessionCtx);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sendCalls).toEqual([]);
    expect(h.lock.owner).toBeNull();
  });

  it('a session that never joined stays silent', async () => {
    await build({ joinedSessions: [] });
    await h.sessionStart();

    await h.capturedOn.get('tool_approval_requested')?.({ toolName: 'bash' }, h.sessionCtx);
    await h.capturedOn.get('message_end')?.(
      { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'terminal answer' }] } },
      h.sessionCtx,
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(h.sendCalls).toEqual([]);
    expect(h.registry.isSessionLive(ROUTER)).toBe(false);
    expect(h.lock.owner).toBeNull();
  });

  it('a joined session that is not the router still posts its alerts and mirrors its answers', async () => {
    await build();
    h.lock.owner = { ...OTHER_ROUTER };
    await h.sessionStart();

    await h.capturedOn.get('tool_approval_requested')?.({ toolName: 'bash' }, h.sessionCtx);
    await vi.waitFor(() => expect(h.sendCalls).toHaveLength(2));
    await h.capturedOn.get('message_end')?.(
      { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'terminal answer' }] } },
      h.sessionCtx,
    );

    expect(h.slackClient.isConnected).toBe(false);
    expect(h.sendCalls[0]).toMatchObject({ text: `root ${ROUTER}`, threadTs: undefined });
    expect(h.sendCalls[1]?.threadTs).toBe('ts-1');
    expect(h.sendCalls[2]).toMatchObject({ text: 'terminal answer', threadTs: 'ts-1' });
  });

  it('switching to a session that has not joined gives up the router role', async () => {
    await startRouter();

    await h.switchSession('/tmp/session-not-joined');

    expect(h.slackClient.isConnected).toBe(false);
    expect(h.lock.owner).toBeNull();
    expect(h.registry.isSessionLive(ROUTER)).toBe(false);
    expect(h.registry.isSessionLive('/tmp/session-not-joined')).toBe(false);
    // The persisted join survives, so resuming the session later rejoins it.
    expect(h.config.joinedSessions).toEqual([ROUTER]);

    await h.switchSession(ROUTER);
    await vi.waitFor(() => expect(h.slackClient.isConnected).toBe(true));
    expect(h.registry.isSessionLive(ROUTER)).toBe(true);
  });

  it('a shutdown releases the router role and the registration but keeps the join', async () => {
    await startRouter();

    await h.capturedOn.get('session_shutdown')?.({}, h.sessionCtx);

    expect(h.slackClient.isConnected).toBe(false);
    expect(h.lock.owner).toBeNull();
    expect(h.registry.isSessionLive(ROUTER)).toBe(false);
    expect(h.config.joinedSessions).toEqual([ROUTER]);
  });
});

describe('Slack sockets', () => {
  it('reconfiguring replaces the client without leaving the old socket open', async () => {
    await startRouter();

    await h.invokeCommand('configure xoxb-new xapp-new');

    await vi.waitFor(() => expect(h.slackClient.isConnected).toBe(true));
    expect(h.clients).toHaveLength(2);
    expect(h.clients.filter((client) => client.isConnected)).toEqual([h.slackClient]);
  });

  it('a second session_start does not leave the first client\'s socket open', async () => {
    await startRouter();

    await h.sessionStart();
    await vi.waitFor(() => expect(h.slackClient.isConnected).toBe(true));

    expect(h.clients).toHaveLength(2);
    expect(h.clients.filter((client) => client.isConnected)).toEqual([h.slackClient]);
    expect(iAmRouter()).toBe(true);
  });
});
