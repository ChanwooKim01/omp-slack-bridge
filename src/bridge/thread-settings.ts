/**
 * thread-settings.ts — The thread-pruning settings (`threadKeep`, `threadPruneAt`) and the
 * replies of the commands that change them. Shared by `.bridge ...` in Slack and `/slk-bridge ...`
 * in the terminal, which differ only in the prefix their usage hints show.
 */

import { loadConfig, updateConfig } from "../config/index.js";
import type { SlackBridgeConfig } from "../types/index.js";
import type { CommandReply, PruneSettings } from "./thread-pruner.js";

export const DEFAULT_THREAD_KEEP = 5;
export const MAX_THREAD_KEEP = 50;
export const MAX_THREAD_PRUNE_AT = 500;

export type CommandPrefix = ".bridge" | "/slk-bridge";

/** The prune threshold that goes with `keep` unless the user sets one: twice the interactions kept. */
export function defaultPruneAt(keep: number): number {
  return Math.max(2 * keep, keep + 1);
}

function wholeNumberInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/** Stored settings with defaults (5 and 10); a stored value that is out of range is ignored. */
export function resolvePruneSettings(config: Pick<SlackBridgeConfig, "threadKeep" | "threadPruneAt">): PruneSettings {
  const keep = wholeNumberInRange(config.threadKeep, 1, MAX_THREAD_KEEP) ?? DEFAULT_THREAD_KEEP;
  const pruneAt = wholeNumberInRange(config.threadPruneAt, keep + 1, MAX_THREAD_PRUNE_AT) ?? defaultPruneAt(keep);
  return { keep, pruneAt };
}

/** User tokens are `xoxp-…` (`xoxe.xoxp-…` with token rotation); a bot or app token must not be stored as one. */
export function looksLikeUserToken(token: string): boolean {
  return /^(?:xoxe\.)?xoxp-/.test(token);
}

function describeSettings({ keep, pruneAt }: PruneSettings): string {
  return `스레드마다 최근 대화 ${keep}개를 남기고, 대화가 ${pruneAt}개가 되면 오래된 대화를 요약해 지웁니다.`;
}

function parseWholeNumber(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** `keep <N>`: keep the newest N interactions (1..50) and prune at twice that many. */
export function runKeepCommand(arg: string, prefix: CommandPrefix): CommandReply {
  if (!arg.trim()) {
    return { ok: true, text: `${describeSettings(resolvePruneSettings(loadConfig()))} 바꾸려면 \`${prefix} keep <1-${MAX_THREAD_KEEP}>\`` };
  }
  const keep = parseWholeNumber(arg);
  if (keep === undefined || keep < 1 || keep > MAX_THREAD_KEEP) {
    return { ok: false, text: `❌ 사용법: \`${prefix} keep <1-${MAX_THREAD_KEEP}>\`` };
  }
  const stored = updateConfig((config) => {
    config.threadKeep = keep;
    config.threadPruneAt = defaultPruneAt(keep);
  });
  return { ok: true, text: `🧹 ${describeSettings(resolvePruneSettings(stored))}` };
}

/** `pruneat <M>`: prune once a thread holds M interactions; M must exceed the number kept. */
export function runPruneAtCommand(arg: string, prefix: CommandPrefix): CommandReply {
  const current = resolvePruneSettings(loadConfig());
  if (!arg.trim()) {
    return { ok: true, text: `${describeSettings(current)} 바꾸려면 \`${prefix} pruneat <${current.keep + 1}-${MAX_THREAD_PRUNE_AT}>\`` };
  }
  const pruneAt = parseWholeNumber(arg);
  if (pruneAt === undefined || pruneAt <= current.keep || pruneAt > MAX_THREAD_PRUNE_AT) {
    return {
      ok: false,
      text: `❌ 정리를 시작할 대화 수는 남길 대화 수(${current.keep})보다 크고 ${MAX_THREAD_PRUNE_AT} 이하여야 합니다. 사용법: \`${prefix} pruneat <숫자>\``,
    };
  }
  const stored = updateConfig((config) => {
    config.threadPruneAt = pruneAt;
  });
  return { ok: true, text: `🧹 ${describeSettings(resolvePruneSettings(stored))}` };
}
