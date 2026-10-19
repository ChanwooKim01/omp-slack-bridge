/**
 * Alerts from parallel sessions must not pile up in the channel: each session gets
 * one top-level root, and every later alert of that session is a reply in its thread.
 * A reply in a session's thread belongs to that session only: when it is not running,
 * the user is told so and the reply never becomes another session's prompt.
 */

import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type BridgeHarness, createBridgeHarness } from '../helpers/bridge-harness';

const OFFLINE_NOTICE = '이 스레드의 세션이 꺼져 있습니다. Paseo에서 해당 에이전트를 열면 다시 연결됩니다.';

let h: BridgeHarness;

afterEach(async () => {
  await h.capturedOn.get('session_shutdown')?.({}, h.sessionCtx);
  h.reset();
});

async function requestApproval(toolName: string, expectedSends: number) {
  // The permission listener posts fire-and-forget; wait on the observable Slack sends.
  await h.capturedOn.get('tool_approval_requested')?.({ toolName }, h.sessionCtx);
  await vi.waitFor(() => expect(h.sendCalls).toHaveLength(expectedSends));
}

it('concurrent alerts share one session root, and a new session opens its own root', async () => {
  h = await createBridgeHarness({
    branch: [],
    sessionFile: '/tmp/session-a',
    cwd: '/tmp/project',
    trustedChatId: 'C123',
    cmdIdle: true,
    agentIdle: true,
    autoConnect: true,
    joinedSessions: ['/tmp/session-a', '/tmp/session-b'],
  });
  await h.sessionStart();
  h.sendCalls.length = 0;

  await Promise.all([requestApproval('bash', 3), requestApproval('edit', 3)]);
  await requestApproval('write', 4);

  expect(h.sendCalls[0]).toMatchObject({ text: 'root /tmp/session-a', threadTs: undefined });
  const rootA = 'ts-1';
  expect(h.sendCalls.slice(1).map((call) => call.threadTs)).toEqual([rootA, rootA, rootA]);

  await h.switchSession('/tmp/session-b');
  await requestApproval('bash', 6);
  expect(h.sendCalls[4]).toMatchObject({ text: 'root /tmp/session-b', threadTs: undefined });
  expect(h.sendCalls[5]?.threadTs).toBe('ts-5');

  // Session A is no longer running here. A channel reply in its thread while B is active must not
  // become B's prompt, now or on retry.
  const replyInA = {
    chatId: 'C123', content: 'A 쪽 결과 알려줘', username: 'testuser', userId: 'U123', timestamp: new Date(),
    messageId: '900.000001', isGroupChat: true, wasMentioned: false, threadId: rootA, isThreadReply: true,
  };
  await h.invokeClientMessage(replyInA);
  await h.invokeClientMessage({ ...replyInA, messageId: '900.000002' });
  expect(h.sendUserMessages()).toHaveLength(0);
  expect(h.sendCalls.slice(6).map((call) => [call.threadTs, call.text])).toEqual([
    [rootA, OFFLINE_NOTICE],
    [rootA, OFFLINE_NOTICE],
  ]);
});

it('a late answer in an earlier session thread keeps that thread owned by the earlier session', async () => {
  h = await createBridgeHarness({
    branch: [],
    sessionFile: '/tmp/session-a',
    cwd: '/tmp/project',
    trustedChatId: 'C123',
    cmdIdle: true,
    agentIdle: true,
    autoConnect: true,
    joinedSessions: ['/tmp/session-a', '/tmp/session-b'],
  });
  await h.sessionStart();
  h.sendCalls.length = 0;
  const tools: ToolDefinition[] = h.pi.registerTool.mock.calls.map((call: [ToolDefinition]) => call[0]);
  const ask = tools.find((tool) => tool.name === 'ask');
  if (!ask) throw new Error('ask not registered');
  const local = Promise.withResolvers<unknown>();
  const params = { questions: [{ id: 'go', question: '진행할까요?', options: [{ label: '진행' }, { label: '중지' }] }] };
  // Only the native-dialog seam of the extension context is exercised here.
  const askCtx = { invokeTool: () => local.promise } as unknown as ExtensionContext;
  const result = ask.execute('call', params, undefined, undefined, askCtx);
  await vi.waitFor(() => expect(h.sendCalls).toHaveLength(2));
  local.resolve({ content: [], details: { results: [{ id: 'go', selectedOptions: ['진행'] }] } });
  await result;

  await h.switchSession('/tmp/session-b');
  const reply = {
    chatId: 'C123', username: 'testuser', userId: 'U123', timestamp: new Date(),
    isGroupChat: true, wasMentioned: false, threadId: 'ts-1', isThreadReply: true,
  };
  await h.invokeClientMessage({ ...reply, content: '1', messageId: '900.000001' });
  await vi.waitFor(() => expect(h.sendCalls).toHaveLength(3));
  expect(h.sendCalls[2]?.text).toBe(OFFLINE_NOTICE);
  await h.invokeClientMessage({ ...reply, content: 'A 쪽 결과 알려줘', messageId: '900.000002' });
  expect(h.sendUserMessages()).toHaveLength(0);
  expect(h.sendCalls[3]?.text).toBe(OFFLINE_NOTICE);
  // The notices never remapped the thread to the active session.
  expect(h.config.slackRouting.threadsByKey['C123:ts-1'].sessionPath).toBe('/tmp/session-a');
});
