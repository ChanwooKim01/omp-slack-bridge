import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { installPaseoQuestions } from "../../src/bridge/paseo-questions.js";
import type { ExternalMessage } from "../../src/types/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let tool: ToolDefinition | undefined;
  const handlers = new Map<string, (() => void)[]>();
  let ui = deferred<string | undefined>();
  let posted = deferred<void>();
  let nativeAborted = false;
  // The test host implements only the extension registration/UI boundary used here.
  const api = {
    on(event: string, handler: () => void) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerTool(definition: ToolDefinition) { tool = definition; },
  } as unknown as ExtensionAPI;
  const ctx = { ui: { select(_title: string, _options: string[], options: { signal: AbortSignal }) {
    const current = ui;
    options.signal.addEventListener("abort", () => { nativeAborted = true; current.reject(new Error("cancelled")); }, { once: true });
    return current.promise;
  } } } as unknown as ExtensionContext;
  // Every question lands in the same session thread, like the bridge does for one session.
  // Each alert gets a later Slack ts so replies can be ordered against it.
  const target = { chatId: "C-test", threadId: "100.200" };
  const sent: string[] = [];
  const bridge = installPaseoQuestions(api, async text => { sent.push(text); posted.resolve(); return { ...target, postedTs: `${200 + sent.length}.000000` }; });
  const params = { questions: [{ id: "decision", question: "진행할까요?", options: [{ label: "진행" }, { label: "중지" }] }] };
  if (!tool) throw new Error("ask not registered");
  const ask = () => {
    ui = deferred<string | undefined>();
    posted = deferred<void>();
    const run = tool!.execute("call", params, undefined, undefined, ctx);
    return { result: run, posted: posted.promise, ui };
  };
  const first = ask();
  const message = (threadId: string, content: string, messageId = "900.000000"): ExternalMessage => ({ chatId: target.chatId, content, username: "owner", userId: "U-owner", timestamp: new Date(0), messageId, isGroupChat: true, threadId, isThreadReply: true });
  return { result: first.result, ui: first.ui, posted: first.posted, ask, sent, bridge, message, handlers, nativeAborted: () => nativeAborted };
}

test("Slack answer resolves the decision and cancels the competing local dialog", async () => {
  const h = harness();
  await h.posted;
  await Promise.resolve();
  expect(await h.bridge.receive(h.message("100.200", "2"))).toBe(true);
  const result = await h.result;
  expect(result.details).toMatchObject({ results: [{ id: "decision", selectedOptions: ["중지"] }] });
  expect(h.nativeAborted()).toBe(true);
});

test("local answer wins and a later Slack answer cannot become another turn", async () => {
  const h = harness();
  await h.posted;
  await Promise.resolve();
  h.ui.resolve("진행");
  const result = await h.result;
  expect(result.details).toMatchObject({ results: [{ selectedOptions: ["진행"] }] });
  expect(await h.bridge.receive(h.message("100.200", "2"))).toBe(true);
});

test("a closed question leaves its shared session thread open for ordinary chat", async () => {
  const h = harness();
  await h.posted;
  await Promise.resolve();
  h.ui.resolve("진행");
  await h.result;
  expect(await h.bridge.receive(h.message("100.200", "중지"))).toBe(true);
  expect(h.sent.at(-1)).toContain("이미 종료된 질문");
  expect(await h.bridge.receive(h.message("100.200", "테스트 결과 다시 보여줘"))).toBe(false);
});

test("a late answer to a closed question cannot answer the next question in the shared thread", async () => {
  const h = harness();
  await h.posted;
  await Promise.resolve();
  h.ui.resolve("진행");
  await h.result;
  const second = h.ask();
  await second.posted;
  await Promise.resolve();
  // Sent before the second alert (ts 202) was posted, so it was meant for the closed first question.
  expect(await h.bridge.receive(h.message("100.200", "2", "201.500000"))).toBe(true);
  expect(h.sent.at(-1)).toContain("이미 종료된 질문");
  expect(await h.bridge.receive(h.message("100.200", "1"))).toBe(true);
  expect((await second.result).details).toMatchObject({ results: [{ selectedOptions: ["진행"] }] });
});

test("a different thread cannot answer the pending question", async () => {
  const h = harness();
  await h.posted;
  await Promise.resolve();
  expect(await h.bridge.receive(h.message("999.999", "1"))).toBe(false);
  await h.bridge.receive(h.message("100.200", "2"));
  expect((await h.result).details).toMatchObject({ results: [{ selectedOptions: ["중지"] }] });
});

test("a session switch rejects the pending decision rather than approving it", async () => {
  const h = harness();
  await h.posted;
  const rejection = expect(h.result).rejects.toThrow("승인하지 않았습니다");
  for (const handler of h.handlers.get("session_before_switch") ?? []) handler();
  await rejection;
  expect(h.nativeAborted()).toBe(true);
});
