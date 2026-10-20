import { Type } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExternalMessage } from "../types/index.js";

type Question = { id: string; question: string; options: { label: string; description?: string; preview?: string }[]; multi?: boolean; header?: string; recommended?: number };
/** `postedTs` is the Slack ts of the question alert; questions share their session thread, so only later replies answer it. */
type Target = { chatId: string; threadId: string; postedTs?: string };

/** Slack ts values are `<seconds>.<6 digits>`; compare exactly instead of as lossy floats. */
function slackTsAfter(ts: string, reference: string): boolean {
  const format = /^\d+\.\d{6}$/;
  if (!format.test(ts) || !format.test(reference)) return false;
  return BigInt(ts.replace(".", "")) > BigInt(reference.replace(".", ""));
}
type AskDetails = { results: { id: string; question: string; options: string[]; multi: boolean; selectedOptions: string[]; customInput?: string; timedOut?: boolean }[] };
type AskResult = AgentToolResult<AskDetails>;
type AskContext = ExtensionContext & { invokeTool?: (params: { questions: Question[] }, options: { signal: AbortSignal; onUpdate?: AgentToolUpdateCallback<AskDetails> }) => Promise<AskResult> };

async function localQuestions(ctx: AskContext, questions: Question[], signal: AbortSignal): Promise<AskResult> {
  const results: AskDetails["results"] = [];
  for (const question of questions) {
    const selectedOptions: string[] = [];
    let customInput: string | undefined;
    let other = "직접 입력";
    let done = "선택 완료";
    const labels = question.options.map(option => option.label);
    while (labels.includes(other)) other += " ·";
    while (labels.includes(done) || done === other) done += " ·";
    for (;;) {
      if (signal.aborted) throw new Error("질문이 취소되었습니다. 승인하지 않았습니다.");
      const display = question.options.map(option => `${selectedOptions.includes(option.label) ? "✓ " : ""}${option.label}`);
      display.push(other);
      if (question.multi && selectedOptions.length) display.push(done);
      const picked = await ctx.ui.select(question.question, display, { signal });
      if (picked === undefined || signal.aborted) throw new Error("질문이 취소되었습니다. 승인하지 않았습니다.");
      if (picked === done) break;
      if (picked === other) {
        customInput = await ctx.ui.input(question.question, "답변을 입력하세요.", { signal });
        if (!customInput?.trim() || signal.aborted) throw new Error("답변이 없어 질문을 취소했습니다. 승인하지 않았습니다.");
        customInput = customInput.trim();
        selectedOptions.length = 0;
        break;
      }
      const index = display.indexOf(picked);
      const label = question.options[index]?.label;
      if (!label) throw new Error("선택한 답변을 확인할 수 없습니다.");
      const previous = selectedOptions.indexOf(label);
      if (previous >= 0) selectedOptions.splice(previous, 1);
      else selectedOptions.push(label);
      if (!question.multi) break;
    }
    results.push({ id: question.id, question: question.question, options: labels, multi: question.multi ?? false, selectedOptions, ...(customInput ? { customInput } : {}) });
  }
  return { content: [{ type: "text", text: "User answers:\n" + results.map(result => `${result.id}: ${result.customInput ?? result.selectedOptions.join(", ")}`).join("\n") }], details: { results } };
}

/** Keep OMP's native question UI; the first explicit local or Slack answer wins. */
export function installPaseoQuestions(pi: ExtensionAPI, send: (text: string, target?: Target) => Promise<Target | undefined>) {
  let pending: { target?: Target; questions: Question[]; resolve: (value: AskResult) => void; reject: (error: Error) => void } | undefined;
  // Questions now share their session's Slack thread, so a closed question must not mute the thread.
  // Only late replies shaped like an answer to the closed question are swallowed; they never become a new turn.
  const closedQuestions = new Map<string, Question[]>();
  const closeThread = (target: Target, questions: Question[]) => {
    const key = `${target.chatId}:${target.threadId}`;
    closedQuestions.delete(key);
    closedQuestions.set(key, questions);
    if (closedQuestions.size > 1024) {
      const oldest = closedQuestions.keys().next().value;
      if (oldest) closedQuestions.delete(oldest);
    }
  };
  const reset = () => pending?.reject(new Error("세션 전환 또는 중지로 질문을 취소했습니다. 승인하지 않았습니다."));
  pi.on("session_before_switch", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  // OMP adds a permission event that is absent from the upstream Pi type declarations.
  const ompEvents = pi as unknown as { on(event: "tool_approval_requested", handler: (event: { toolName: string }) => void): void };
  const ompLifecycle = pi as unknown as { on(event: "session_before_branch", handler: () => void): void };
  ompLifecycle.on("session_before_branch", reset);
  ompEvents.on("tool_approval_requested", event => {
    void send(`도구 권한 승인 필요: ${event.toolName}\n이 권한 승인은 Paseo 앱에서 처리하세요. Slack 답변으로 우회하지 않습니다.`).catch(() => {});
  });

  const definition = {
    name: "ask", label: "질문 · Paseo / Slack", approval: "read" as const,
    description: "Ask the user for a decision. The same question is available in the native Paseo/OMP UI and the connected Slack thread. The first explicit answer wins; cancellation never means approval.",
    parameters: Type.Object({ questions: Type.Array(Type.Object({
      id: Type.String(), question: Type.String(),
      options: Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()), preview: Type.Optional(Type.String()) })),
      header: Type.Optional(Type.String()), multi: Type.Optional(Type.Boolean()), recommended: Type.Optional(Type.Number()),
    }), { minItems: 1, maxItems: 5 }) }),
    async execute(_id: string, params: { questions: Question[] }, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<AskDetails> | undefined, ctx: AskContext) {
      if (signal?.aborted) throw new Error("질문이 취소되었습니다.");
      if (pending) throw new Error("이전 질문의 답변을 먼저 기다리세요.");
      const controller = new AbortController();
      let settled = false;
      let rejectRemote!: (error: Error) => void;
      const remote = new Promise<AskResult>((resolve, reject) => {
        rejectRemote = reject;
        pending = { questions: params.questions, resolve, reject };
      });
      const item = pending!;
      const aborted = () => { controller.abort(); rejectRemote(new Error("질문이 취소되었습니다. 승인하지 않았습니다.")); };
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      try {
        const text = params.questions.map(q => `${q.id}: ${q.question}\n${q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}`).join("\n\n");
        void send(`결정이 필요합니다.\n\n${text}\n\nPaseo 질문 창 또는 이 스레드에서 답변하세요. 먼저 도착한 답변 하나만 반영합니다.${params.questions.length > 1 ? " 여러 질문은 각 줄에 질문ID: 답변 형식으로 쓰세요." : " 번호, 선택지 이름 또는 직접 답변을 보낼 수 있습니다."}`)
          .then(target => {
            if (!target) return;
            if (!settled && pending === item) item.target = target;
            else closeThread(target, item.questions);
          })
          .catch(() => { /* The native UI remains usable if Slack is unavailable. */ });
        const invokeNative = ctx.invokeTool;
        const local = invokeNative
          ? Promise.resolve().then(() => invokeNative(params, { signal: controller.signal, onUpdate }))
          : localQuestions(ctx, params.questions, controller.signal);
        const result = await Promise.race([local, remote]);
        if (result.details?.results?.some(r => r.timedOut)) throw new Error("자동 선택된 답변은 승인으로 처리하지 않습니다. 직접 답변하세요.");
        return result;
      } finally {
        settled = true;
        if (item.target) closeThread(item.target, item.questions);
        controller.abort();
        signal?.removeEventListener("abort", aborted);
        if (pending === item) pending = undefined;
        rejectRemote(new Error("질문이 종료되었습니다."));
      }
    },
  };
  pi.registerTool(definition);

  return {
    /** A question is waiting for its answer in this thread, or its alert is still being posted (so its thread is not known yet). */
    isPending(chatId: string, threadId: string): boolean {
      if (!pending) return false;
      return !pending.target || (pending.target.chatId === chatId && pending.target.threadId === threadId);
    },
    async receive(message: ExternalMessage): Promise<boolean> {
      const item = pending;
      const answersPending = item?.target && message.chatId === item.target.chatId && message.threadId === item.target.threadId
        && (!item.target.postedTs || slackTsAfter(message.messageId, item.target.postedTs));
      if (!answersPending) {
        const closed = message.threadId ? closedQuestions.get(`${message.chatId}:${message.threadId}`) : undefined;
        const answer = message.content.trim();
        const lateAnswer = closed && (/^\d+(\s*,\s*\d+)*$/.test(answer)
          || closed.some(q => answer.startsWith(`${q.id}:`) || q.options.some(o => o.label === answer)));
        if (!lateAnswer) return false;
        await send("이미 종료된 질문입니다. 이 답변은 반영하지 않았습니다.", { chatId: message.chatId, threadId: message.threadId! });
        return true;
      }
      if (message.content.trim().toLowerCase() === "stop") { reset(); return true; }
      const values = new Map<string, string>();
      if (item.questions.length === 1) values.set(item.questions[0]!.id, message.content.trim());
      else for (const line of message.content.split("\n")) {
        const colon = line.indexOf(":");
        if (colon >= 0) values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      if (item.questions.some(q => !values.get(q.id))) {
        await send("각 질문에 답변하세요. 여러 질문은 질문ID: 답변 형식으로 한 줄씩 작성하세요.", item.target);
        return true;
      }
      const results = item.questions.map(q => {
        const raw = values.get(q.id)!;
        const parts = q.multi ? raw.split(",").map(v => v.trim()) : [raw];
        const selectedOptions: string[] = [];
        let customInput: string | undefined;
        for (const value of parts) {
          const numeric = /^\d+$/.test(value) ? Number(value) - 1 : -1;
          const option = numeric >= 0 ? q.options[numeric] : q.options.find(o => o.label === value);
          if (option) selectedOptions.push(option.label);
          else customInput = raw;
        }
        return { id: q.id, question: q.question, options: q.options.map(o => o.label), multi: q.multi ?? false, selectedOptions: customInput ? [] : selectedOptions, ...(customInput ? { customInput } : {}) };
      });
      item.resolve({ content: [{ type: "text", text: "User answers:\n" + results.map(r => `${r.id}: ${r.customInput ?? r.selectedOptions.join(", ")}`).join("\n") }], details: { results } });
      pending = undefined;
      return true;
    },
  };
}
