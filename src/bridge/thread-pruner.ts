/**
 * thread-pruner.ts — Keeps a session thread short: when it holds too many interactions, the
 * oldest ones are summarized into the thread's header and deleted, so the latest messages are
 * reachable without scrolling.
 *
 * Order of work, so that a failure never costs content: read the thread, decide what to prune,
 * summarize (merging the stored summary), write the header, store the summary, and only then
 * delete. A failed read, summary or header write deletes nothing. The newest `keep` interactions
 * and the thread root are never deleted. Pruning runs only in the session that owns the thread,
 * never while it is mid-turn or waiting for an answer, and one thread is handled at a time.
 *
 * Everything the outside world provides (Slack, the deleters, the summarizer, storage, the
 * session's state) comes in through `PrunerDeps`.
 */

import type { GuardedDeleter } from "../slack/guarded-delete.js";
import {
  type DeletionTarget,
  type Interaction,
  type ThreadIdentity,
  type ThreadMessage,
  buildSummaryPrompt,
  buildThreadHeader,
  chunkTranscripts,
  deriveTitle,
  groupInteractions,
  interactionMessages,
  interactionTranscript,
  isBotMessage,
  messageAuthor,
  normalizeSummary,
  normalizeTitle,
  planDeletions,
  selectInteractionsToPrune,
  slackTsAtOrBefore,
} from "../slack/thread-history.js";
import type { SlackThreadMeta } from "../types/index.js";

export interface ThreadRef {
  chatId: string;
  threadTs: string;
}

export interface PruneSettings {
  /** The newest interactions that survive a prune. */
  keep: number;
  /** A thread is pruned once it holds this many interactions. */
  pruneAt: number;
}

/** What the pruner needs from the bot-token Slack client. */
export interface PrunerSlack {
  getBotIdentity(): Promise<{ userId: string; botId?: string }>;
  fetchThreadMessages(chatId: string, threadTs: string, options?: { rootOnly?: boolean }): Promise<ThreadMessage[]>;
  updateMessage(chatId: string, ts: string, text: string): Promise<void>;
  postThreadReply(chatId: string, threadTs: string, text: string): Promise<string>;
}

/**
 * Why pruning must wait or stop. `busy` and `question-pending` pass by themselves; the others
 * mean this session cannot prune this thread at all.
 */
export type PruneBlocker = "not-joined" | "not-owner" | "busy" | "question-pending";

export interface PrunerDeps {
  /** The current bot-token client; null while Slack is not configured. */
  slack: () => PrunerSlack | null;
  botDeleter: () => GuardedDeleter | undefined;
  /** Undefined without a user token: nothing is pruned automatically then. */
  userDeleter: () => GuardedDeleter | undefined;
  getMeta: (ref: ThreadRef) => SlackThreadMeta | undefined;
  updateMeta: (ref: ThreadRef, patch: Partial<Omit<SlackThreadMeta, "updatedAt">>) => void;
  settings: () => PruneSettings;
  trustedUserId: () => string | undefined;
  /** Run one summary request (a side turn) and resolve with the model's reply. */
  summarize: (prompt: string) => Promise<string>;
  blocker: (ref: ThreadRef) => PruneBlocker | undefined;
  /** Shown once per pruner when automatic pruning is off for lack of a user token. */
  report: (message: string, level: "info" | "warning") => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long an automatic prune waits for the session to go quiet, polling every `quietPollMs`. */
  quietTimeoutMs?: number;
  quietPollMs?: number;
}

export type PruneSkipReason =
  | "no-user-token"
  | "below-threshold"
  | "nothing-to-prune"
  | "already-running"
  | "cooling-down"
  | `blocked:${PruneBlocker}`;

export type PruneOutcome =
  | { status: "pruned"; interactions: number; deleted: number }
  | { status: "skipped"; reason: PruneSkipReason }
  /** The session got busy, was asked something or moved on while messages were being deleted; the rest stays for the next run. */
  | { status: "interrupted"; reason: PruneBlocker; deleted: number; remaining: number }
  | {
      status: "failed";
      stage: "read" | "token" | "summary" | "header" | "delete";
      error: string;
      deleted?: number;
      remaining?: number;
    };

export type TitleOutcome = { status: "updated" } | { status: "failed"; error: string };

/** Which part of a thread a prune may touch. */
export interface PruneOptions {
  /**
   * Only messages up to this Slack ts are pruned. Later ones may not have reached the session yet (a
   * message sent right after `.bridge new` is still in the inbox), so they are neither summarized nor deleted.
   */
  upToTs?: string;
}

export interface ThreadPruner {
  /** After a Slack-originated turn: prune when the thread holds at least `pruneAt` interactions. */
  autoPrune(ref: ThreadRef, options?: PruneOptions): Promise<PruneOutcome>;
  /** `.bridge new`: summarize and delete every interaction. */
  pruneAll(ref: ThreadRef, options?: PruneOptions): Promise<PruneOutcome>;
  /** `.bridge title`: store the title and rewrite the header. */
  setTitle(ref: ThreadRef, title: string): Promise<TitleOutcome>;
}

/** Thrown from inside a prune when the session may no longer be pruned; ends the run without failing it. */
class PruneInterrupted extends Error {
  constructor(readonly blocker: PruneBlocker) {
    super(`prune interrupted: ${blocker}`);
  }
}

/** One summary request carries at most this much transcript; more is summarized in several rounds. */
export const MAX_TRANSCRIPT_CHARS_PER_ROUND = 48_000;
/**
 * After an automatic prune failed past the read, the thread is left alone this long: a broken token,
 * a refused deletion or an unusable model would otherwise cost another summary request every turn.
 */
export const AUTO_FAILURE_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_QUIET_TIMEOUT_MS = 10_000;
const DEFAULT_QUIET_POLL_MS = 250;
const TRANSIENT_BLOCKERS: Record<PruneBlocker, boolean> = {
  "not-joined": false,
  "not-owner": false,
  busy: true,
  "question-pending": true,
};
const NO_USER_TOKEN_NOTICE =
  "ℹ️ Slack 스레드 자동 정리는 꺼져 있습니다: user token이 없습니다. " +
  "`/slk-bridge configure <bot-token> <app-token> <user-token>` 또는 PI_SLACK_USER_TOKEN으로 켤 수 있습니다.";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skipped(reason: PruneSkipReason): PruneOutcome {
  return { status: "skipped", reason };
}

function failed(stage: "read" | "token" | "summary" | "header", error: unknown): PruneOutcome {
  return { status: "failed", stage, error: describeError(error) };
}

/** The thread as read from Slack, classified. */
interface ThreadView {
  identity: ThreadIdentity;
  messages: ThreadMessage[];
  root: ThreadMessage;
  rootIsBot: boolean;
  /** The bot message that carries the header of a user-rooted thread, when it still exists. */
  summaryTs?: string;
}

export function createThreadPruner(deps: PrunerDeps): ThreadPruner {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const quietPollMs = deps.quietPollMs ?? DEFAULT_QUIET_POLL_MS;
  const quietPolls = Math.ceil((deps.quietTimeoutMs ?? DEFAULT_QUIET_TIMEOUT_MS) / quietPollMs);
  const queues = new Map<string, Promise<unknown>>();
  const autoRuns = new Set<string>();
  /** Threads whose last automatic prune failed, and when automatic pruning may try them again. */
  const coolingDownUntil = new Map<string, number>();
  let reportedNoUserToken = false;

  const keyOf = (ref: ThreadRef) => `${ref.chatId}:${ref.threadTs}`;

  /** One task per thread at a time; a task that throws does not block the next. */
  function serialize<T>(ref: ThreadRef, task: () => Promise<T>): Promise<T> {
    const key = keyOf(ref);
    const run = (queues.get(key) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }

  async function waitUntilQuiet(ref: ThreadRef): Promise<PruneBlocker | undefined> {
    for (let poll = 0; ; poll++) {
      const blocker = deps.blocker(ref);
      if (!blocker || !TRANSIENT_BLOCKERS[blocker] || poll >= quietPolls) return blocker;
      await sleep(quietPollMs);
    }
  }

  async function readThread(ref: ThreadRef, meta: SlackThreadMeta | undefined): Promise<ThreadView> {
    const slack = deps.slack();
    if (!slack) throw new Error("Slack is not configured");
    const trustedUserId = deps.trustedUserId();
    if (!trustedUserId) throw new Error("no trusted Slack user is paired");
    const bot = await slack.getBotIdentity();
    const identity: ThreadIdentity = { trustedUserId, botUserId: bot.userId, ...(bot.botId ? { botId: bot.botId } : {}) };
    const messages = await slack.fetchThreadMessages(ref.chatId, ref.threadTs);
    const root = messages.find((message) => message.ts === ref.threadTs);
    if (!root) throw new Error("Slack did not return the thread root");
    const rootIsBot = isBotMessage(root, identity);
    const summaryTs =
      !rootIsBot && meta?.summaryTs && messages.some((m) => m.ts === meta.summaryTs && messageAuthor(m, identity) === "bot")
        ? meta.summaryTs
        : undefined;
    return { identity, messages, root, rootIsBot, ...(summaryTs ? { summaryTs } : {}) };
  }

  /**
   * Merge the stored summary with the transcript, one round per chunk. Every character of what will
   * be deleted goes into some round, and a turn that starts between rounds ends the run.
   */
  async function summarize(ref: ThreadRef, previous: string | undefined, interactions: Interaction[]): Promise<string | undefined> {
    const entries = interactions.map(interactionTranscript).filter((entry) => entry.length > 0);
    let summary = previous;
    for (const chunk of chunkTranscripts(entries, MAX_TRANSCRIPT_CHARS_PER_ROUND)) {
      const blocker = deps.blocker(ref);
      if (blocker) throw new PruneInterrupted(blocker);
      summary = normalizeSummary(await deps.summarize(buildSummaryPrompt({ previousSummary: summary, transcript: chunk })));
    }
    return summary;
  }

  /**
   * Write the header: edit the root when the bridge wrote it; otherwise edit the summary message,
   * creating it when the thread has none. Resolves with the summary message's ts, if any.
   */
  async function writeHeader(
    ref: ThreadRef,
    rootIsBot: boolean,
    summaryMessageTs: string | undefined,
    text: string,
  ): Promise<string | undefined> {
    const slack = deps.slack();
    if (!slack) throw new Error("Slack is not configured");
    if (rootIsBot) {
      await slack.updateMessage(ref.chatId, ref.threadTs, text);
      return undefined;
    }
    if (summaryMessageTs) {
      await slack.updateMessage(ref.chatId, summaryMessageTs, text);
      return summaryMessageTs;
    }
    return slack.postThreadReply(ref.chatId, ref.threadTs, text);
  }

  async function deleteTargets(
    ref: ThreadRef,
    targets: DeletionTarget[],
    interactionCount: number,
  ): Promise<PruneOutcome> {
    let deleted = 0;
    const deleters = { user: deps.userDeleter(), bot: deps.botDeleter() };
    // Deletions are paced out over minutes: every request checks the session again right before it is sent.
    const beforeSend = () => {
      const blocker = deps.blocker(ref);
      if (blocker) throw new PruneInterrupted(blocker);
    };
    for (const [index, target] of targets.entries()) {
      const deleter = deleters[target.author];
      const remaining = targets.length - index;
      try {
        if (!deleter) throw new Error(`no ${target.author} deleter is available`);
        await deleter.deleteThreadMessage({ channel: ref.chatId, threadTs: ref.threadTs, message: target.message, beforeSend });
        deleted++;
      } catch (error) {
        if (error instanceof PruneInterrupted) return { status: "interrupted", reason: error.blocker, deleted, remaining };
        return { status: "failed", stage: "delete", error: describeError(error), deleted, remaining };
      }
    }
    return { status: "pruned", interactions: interactionCount, deleted };
  }

  async function runPrune(ref: ThreadRef, mode: "auto" | "all", upToTs?: string): Promise<PruneOutcome> {
    const earlyBlocker = deps.blocker(ref);
    if (earlyBlocker) return skipped(`blocked:${earlyBlocker}`);

    const meta = deps.getMeta(ref);
    let view: ThreadView;
    try {
      view = await readThread(ref, meta);
    } catch (error) {
      return failed("read", error);
    }

    const { keep, pruneAt } = deps.settings();
    // Messages after `upToTs` have not necessarily reached the session: they are not interactions to prune.
    const messages = upToTs ? view.messages.filter((message) => slackTsAtOrBefore(message.ts, upToTs)) : view.messages;
    const interactions = groupInteractions(messages, view.identity, { threadTs: ref.threadTs, summaryTs: view.summaryTs });
    const selected = selectInteractionsToPrune(interactions, mode === "all" ? { keep: 0 } : { keep, pruneAt });
    if (selected.length === 0) return skipped(mode === "auto" ? "below-threshold" : "nothing-to-prune");

    // A user-written root cannot carry the summary, so the earliest bot reply of the pruned part is
    // edited into the summary message instead of being deleted.
    const headerTs = view.rootIsBot ? undefined : (view.summaryTs ?? selected.flatMap((i) => i.bots)[0]?.ts);
    const targets = planDeletions(selected, view.identity, { threadTs: ref.threadTs, keepTs: headerTs });
    if (targets.length === 0) return skipped("nothing-to-prune");
    const affected = new Set([...targets.map((target) => target.message.ts), ...(headerTs ? [headerTs] : [])]);
    const toSummarize = selected.filter((interaction) => interactionMessages(interaction).some((m) => affected.has(m.ts)));

    // A user token that Slack rejects, or that belongs to someone else, would fail the first deletion
    // after the summary was paid for: find that out first.
    if (targets.some((target) => target.author === "user")) {
      try {
        const deleter = deps.userDeleter();
        if (!deleter) throw new Error("no user token is configured");
        await deleter.preflight();
      } catch (error) {
        return failed("token", error);
      }
    }

    let summary: string | undefined;
    try {
      summary = await summarize(ref, meta?.summary, toSummarize);
    } catch (error) {
      if (error instanceof PruneInterrupted) return skipped(`blocked:${error.blocker}`);
      return failed("summary", error);
    }
    // The summary took a while: nothing has changed yet, so a turn that started meanwhile wins.
    const lateBlocker = deps.blocker(ref);
    if (lateBlocker) return skipped(`blocked:${lateBlocker}`);

    const title = meta?.title ?? deriveTitle(view.root.text);
    try {
      const summaryTs = await writeHeader(ref, view.rootIsBot, headerTs, buildThreadHeader(title, summary));
      deps.updateMeta(ref, { title, ...(summary ? { summary } : {}), ...(summaryTs ? { summaryTs } : {}) });
    } catch (error) {
      return failed("header", error);
    }

    return deleteTargets(ref, targets, selected.length);
  }

  async function autoPrune(ref: ThreadRef, options?: PruneOptions): Promise<PruneOutcome> {
    if (!deps.userDeleter()) {
      if (!reportedNoUserToken) {
        reportedNoUserToken = true;
        deps.report(NO_USER_TOKEN_NOTICE, "info");
      }
      return skipped("no-user-token");
    }
    const key = keyOf(ref);
    if (now() < (coolingDownUntil.get(key) ?? 0)) return skipped("cooling-down");
    if (autoRuns.has(key)) return skipped("already-running");
    autoRuns.add(key);
    try {
      const blocker = await waitUntilQuiet(ref);
      if (blocker) return skipped(`blocked:${blocker}`);
      const outcome = await serialize(ref, () => runPrune(ref, "auto", options?.upToTs));
      if (outcome.status === "pruned") coolingDownUntil.delete(key);
      else if (outcome.status === "failed" && outcome.stage !== "read") coolingDownUntil.set(key, now() + AUTO_FAILURE_COOLDOWN_MS);
      return outcome;
    } finally {
      autoRuns.delete(key);
    }
  }

  async function pruneAll(ref: ThreadRef, options?: PruneOptions): Promise<PruneOutcome> {
    if (!deps.userDeleter()) return skipped("no-user-token");
    const outcome = await serialize(ref, () => runPrune(ref, "all", options?.upToTs));
    if (outcome.status === "pruned") coolingDownUntil.delete(keyOf(ref));
    return outcome;
  }

  async function setTitle(ref: ThreadRef, rawTitle: string): Promise<TitleOutcome> {
    const title = normalizeTitle(rawTitle);
    if (!title) return { status: "failed", error: "제목이 비어 있습니다" };
    return serialize(ref, async (): Promise<TitleOutcome> => {
      try {
        const slack = deps.slack();
        if (!slack) throw new Error("Slack is not configured");
        const meta = deps.getMeta(ref);
        const bot = await slack.getBotIdentity();
        const [root] = await slack.fetchThreadMessages(ref.chatId, ref.threadTs, { rootOnly: true });
        if (root?.ts !== ref.threadTs) throw new Error("Slack did not return the thread root");
        const text = buildThreadHeader(title, meta?.summary);
        let summaryTs: string | undefined;
        if (isBotMessage(root, { botUserId: bot.userId, ...(bot.botId ? { botId: bot.botId } : {}) })) {
          await slack.updateMessage(ref.chatId, ref.threadTs, text);
        } else {
          summaryTs = await updateOrCreateSummaryMessage(ref, meta?.summaryTs, text);
        }
        deps.updateMeta(ref, { title, ...(summaryTs ? { summaryTs } : {}) });
        return { status: "updated" };
      } catch (error) {
        return { status: "failed", error: describeError(error) };
      }
    });
  }

  /** Edit the stored summary message; when Slack no longer has it, post a new one. */
  async function updateOrCreateSummaryMessage(ref: ThreadRef, storedTs: string | undefined, text: string): Promise<string> {
    const slack = deps.slack();
    if (!slack) throw new Error("Slack is not configured");
    if (storedTs) {
      try {
        await slack.updateMessage(ref.chatId, storedTs, text);
        return storedTs;
      } catch (error) {
        if (!/message_not_found|cant_update_message/.test(describeError(error))) throw error;
      }
    }
    return slack.postThreadReply(ref.chatId, ref.threadTs, text);
  }

  return { autoPrune, pruneAll, setTitle };
}

/** The text of a command reply, and whether the command did what was asked. */
export interface CommandReply {
  ok: boolean;
  text: string;
}

const SKIP_REPLIES: Record<PruneSkipReason, CommandReply> = {
  "no-user-token": {
    ok: false,
    text: "❌ user token이 없어 정리할 수 없습니다. `/slk-bridge configure <bot-token> <app-token> <user-token>`로 설정하세요.",
  },
  "below-threshold": { ok: true, text: "정리할 이전 대화가 없습니다." },
  "nothing-to-prune": { ok: true, text: "정리할 이전 대화가 없습니다." },
  "already-running": { ok: true, text: "이 스레드는 이미 정리 중입니다." },
  "cooling-down": { ok: true, text: "직전 자동 정리가 실패해서 잠시 쉬는 중입니다." },
  "blocked:busy": { ok: false, text: "에이전트가 작업 중이라 정리하지 않았습니다. 끝난 뒤 다시 시도하세요." },
  "blocked:question-pending": { ok: false, text: "질문의 답변을 기다리는 중이라 정리하지 않았습니다." },
  "blocked:not-owner": { ok: false, text: "이 세션이 소유한 스레드가 아니라 정리하지 않았습니다." },
  "blocked:not-joined": { ok: false, text: "이 세션은 Slack 브리지에 참여하지 않아 정리하지 않았습니다." },
};

const FAILURE_PREFIXES: Record<"read" | "token" | "summary" | "header", string> = {
  read: "❌ 스레드를 읽지 못했습니다: ",
  token: "❌ user token을 확인하지 못해 아무것도 삭제하지 않았습니다: ",
  summary: "❌ 요약을 만들지 못해 아무것도 삭제하지 않았습니다: ",
  header: "❌ 요약을 스레드에 쓰지 못해 아무것도 삭제하지 않았습니다: ",
};

/** The reply to a user who ran `.bridge new` (or `/slk-bridge new`). */
export function describePruneOutcome(outcome: PruneOutcome): CommandReply {
  if (outcome.status === "pruned") {
    return { ok: true, text: `🧹 이전 대화 ${outcome.interactions}개를 요약하고 메시지 ${outcome.deleted}개를 삭제했습니다.` };
  }
  if (outcome.status === "skipped") return SKIP_REPLIES[outcome.reason];
  if (outcome.status === "interrupted") {
    const progress = `${outcome.deleted}개 삭제, ${outcome.remaining}개 남음`;
    return { ok: false, text: `정리를 중간에 멈췄습니다 (${progress}). ${SKIP_REPLIES[`blocked:${outcome.reason}`].text}` };
  }
  if (outcome.stage === "delete") {
    return {
      ok: false,
      text: `❌ 삭제 중 오류가 났습니다 (${outcome.deleted ?? 0}개 삭제, ${outcome.remaining ?? 0}개 남음): ${outcome.error}`,
    };
  }
  return { ok: false, text: `${FAILURE_PREFIXES[outcome.stage]}${outcome.error}` };
}
