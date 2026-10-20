/**
 * guarded-delete.ts — The only module that reads the Slack user token (xoxp-) and the only place
 * in the bridge that calls `chat.delete`.
 *
 * Slack cannot limit a user token to one conversation: with `chat:write` it can delete the user's
 * messages anywhere in the workspace. The restriction therefore lives in this code. A deleter
 * removes one message only when ALL of these hold, and refuses (throws `DeleteRefusedError`)
 * before any request is sent otherwise:
 *
 *   - the channel is the paired DM (read at call time), and for the user token it really is a DM;
 *   - the message belongs to the given thread (`thread_ts` equals the thread) and is not its root;
 *   - the message was written by the token's own identity (`auth.test`, cached) — for the user
 *     token that is the trusted user and nobody else, and never a bot message.
 *
 * Nothing but `auth.test` and `chat.delete` is reachable through a backend. Deletions are paced
 * and retried on Slack's rate limit (`chat.delete` is Tier 3), sequentially.
 */

import { slackErrorCode, slackRetryAfterSeconds } from "./errors.js";

export type DeleterIdentity = "bot" | "user";

/** The Slack identity a token authenticates as, from `auth.test`. */
export interface SlackIdentity {
  userId: string;
  botId?: string;
}

/** What a token may do here: say who it is, and delete one message. Nothing else is reachable. */
export interface DeleteBackend {
  whoAmI(): Promise<SlackIdentity>;
  deleteMessage(channel: string, ts: string): Promise<void>;
}

/** The fields of a Slack message the guards look at. */
export interface DeletableMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
}

export interface DeleteRequest {
  channel: string;
  /** The thread the message must belong to. */
  threadTs: string;
  message: DeletableMessage;
  /**
   * Called right before each request is sent, after any pacing wait, retries included. Throwing
   * abandons the deletion without a request; the error reaches the caller unchanged.
   */
  beforeSend?: () => void;
}

export type DeleteRefusalReason =
  | "no-paired-chat"
  | "wrong-channel"
  | "not-a-dm"
  | "bad-timestamp"
  | "root-message"
  | "foreign-thread"
  | "wrong-author"
  | "no-trusted-user"
  | "wrong-user";

/** A guard said no; nothing was sent to Slack. */
export class DeleteRefusedError extends Error {
  constructor(
    readonly reason: DeleteRefusalReason,
    detail: string,
  ) {
    super(`Refused to delete a Slack message (${reason}): ${detail}`);
    this.name = "DeleteRefusedError";
  }
}

/** Slack rejected the deletion (or the rate-limit retries ran out). */
export class DeleteFailedError extends Error {
  constructor(readonly code: string) {
    super(`Slack chat.delete failed: ${code}`);
    this.name = "DeleteFailedError";
  }
}

export interface GuardedDeleter {
  readonly identity: DeleterIdentity;
  /**
   * Check the token before anything is done on its behalf: Slack accepts it, a paired DM exists and,
   * for a user token, it belongs to the trusted Slack user. Throws what a deletion would throw.
   */
  preflight(): Promise<void>;
  /** Resolves "already-gone" when Slack no longer has the message. Throws a `DeleteRefusedError` or `DeleteFailedError`. */
  deleteThreadMessage(request: DeleteRequest): Promise<"deleted" | "already-gone">;
}

// ── Pacing ───────────────────────────────────────────────────────────────

/** chat.delete is Tier 3 (about 50 calls a minute): one deletion a second stays under it. */
export const DEFAULT_DELETE_GAP_MS = 1_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Spaces consecutive deletions and honours Slack's Retry-After. One instance is shared by every
 * deleter of the process because the rate limit is per app, not per token.
 */
export class DeletePacer {
  private nextAt = 0;

  constructor(
    private readonly gapMs: number = DEFAULT_DELETE_GAP_MS,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  /** Wait until the next call is allowed, then reserve the following slot. */
  async beforeCall(): Promise<void> {
    const wait = this.nextAt - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextAt = this.now() + this.gapMs;
  }

  /** Slack said to wait: no call goes out before `ms` have passed. */
  backoff(ms: number): void {
    this.nextAt = Math.max(this.nextAt, this.now() + ms);
  }
}

const sharedPacer = new DeletePacer();

// ── Guards ───────────────────────────────────────────────────────────────

const SLACK_TS = /^\d{9,}\.\d{6}$/;
const DM_CHANNEL = /^D[A-Z0-9]+$/;

export interface GuardedDeleterOptions {
  identity: DeleterIdentity;
  backend: DeleteBackend;
  /** The paired DM, read at every call because pairing can change while the process runs. */
  getPairedChatId: () => string | undefined;
  /** The trusted Slack user. A user token must belong to this user, or it deletes nothing. */
  getTrustedUserId: () => string | undefined;
  pacer?: DeletePacer;
  maxRateLimitRetries?: number;
}

export function createGuardedDeleter(options: GuardedDeleterOptions): GuardedDeleter {
  const { identity, backend, getPairedChatId, getTrustedUserId } = options;
  const pacer = options.pacer ?? sharedPacer;
  const maxRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
  let self: Promise<SlackIdentity> | undefined;

  /** `auth.test` once per deleter; a failure is not cached. */
  function whoAmI(): Promise<SlackIdentity> {
    self ??= backend.whoAmI().then(
      (result) => {
        if (!result.userId) throw new DeleteFailedError("auth_test_without_user");
        return result;
      },
      (error: unknown) => {
        self = undefined;
        throw error instanceof DeleteFailedError ? error : new DeleteFailedError(slackErrorCode(error));
      },
    );
    return self;
  }

  /** Scope guards that need no Slack call. */
  function checkScope({ channel, threadTs, message }: DeleteRequest): void {
    const paired = getPairedChatId();
    if (!paired) throw new DeleteRefusedError("no-paired-chat", "no paired DM is configured");
    if (channel !== paired) throw new DeleteRefusedError("wrong-channel", `${channel} is not the paired DM`);
    if (identity === "user" && !DM_CHANNEL.test(channel)) {
      throw new DeleteRefusedError("not-a-dm", `${channel} is not a direct message channel`);
    }
    if (!SLACK_TS.test(threadTs) || !SLACK_TS.test(message.ts)) {
      throw new DeleteRefusedError("bad-timestamp", `thread ${threadTs}, message ${message.ts}`);
    }
    if (message.ts === threadTs) throw new DeleteRefusedError("root-message", "the thread root is never deleted");
    if (message.thread_ts !== threadTs) {
      throw new DeleteRefusedError("foreign-thread", `message ${message.ts} is not a reply in thread ${threadTs}`);
    }
  }

  /** A user token must belong to the trusted Slack user; the bot token needs no such check. */
  function checkTokenOwner(me: SlackIdentity): void {
    if (identity !== "user") return;
    const trusted = getTrustedUserId();
    if (!trusted) throw new DeleteRefusedError("no-trusted-user", "no trusted Slack user is configured");
    if (me.userId !== trusted) {
      throw new DeleteRefusedError("wrong-user", "the user token does not belong to the trusted Slack user");
    }
  }

  /** Authorship guards that need the token's identity. */
  function checkAuthor(message: DeletableMessage, me: SlackIdentity): void {
    checkTokenOwner(me);
    if (identity === "user") {
      if (message.user !== me.userId || message.bot_id) {
        throw new DeleteRefusedError("wrong-author", `message ${message.ts} was not written by the token's user`);
      }
      return;
    }
    const writtenByBot = message.user === me.userId || (!!me.botId && message.bot_id === me.botId);
    if (!writtenByBot) throw new DeleteRefusedError("wrong-author", `message ${message.ts} was not written by the bot`);
  }

  async function remove(request: DeleteRequest, me: SlackIdentity): Promise<"deleted" | "already-gone"> {
    for (let attempt = 0; ; attempt++) {
      await pacer.beforeCall();
      // Pacing and Retry-After can take a while, and pairing or trust can change meanwhile:
      // every request, a retry included, is checked again right before it is sent.
      checkScope(request);
      checkAuthor(request.message, me);
      request.beforeSend?.();
      try {
        await backend.deleteMessage(request.channel, request.message.ts);
        return "deleted";
      } catch (error) {
        const code = slackErrorCode(error);
        if (code === "message_not_found") return "already-gone";
        const retryAfter = slackRetryAfterSeconds(error);
        if (retryAfter === undefined || attempt >= maxRetries) throw new DeleteFailedError(code);
        pacer.backoff(retryAfter * 1_000);
      }
    }
  }

  return {
    identity,
    async preflight() {
      if (!getPairedChatId()) throw new DeleteRefusedError("no-paired-chat", "no paired DM is configured");
      checkTokenOwner(await whoAmI());
    },
    async deleteThreadMessage(request) {
      checkScope(request); // refuses without a lookup what is wrong from the request alone
      const me = await whoAmI();
      checkAuthor(request.message, me);
      return remove(request, me);
    },
  };
}

// ── Backends: the only code that holds a token ───────────────────────────

/** Network-level retries only; Slack's rate limit is handled by the deleter, which sees Retry-After. */
const NETWORK_RETRY = { retries: 3, factor: 2, minTimeout: 500, maxTimeout: 5_000 };

/**
 * `auth.test` and `chat.delete` with one token. The Slack SDK loads lazily (it is slow to import and
 * a session that never prunes should not pay for it).
 */
function webApiBackend(token: string): DeleteBackend {
  type MinimalWebApi = {
    auth: { test(): Promise<{ user_id?: string; bot_id?: string }> };
    chat: { delete(args: { channel: string; ts: string }): Promise<unknown> };
  };
  let web: Promise<MinimalWebApi> | undefined;
  const client = (): Promise<MinimalWebApi> => {
    web ??= import("@slack/web-api")
      .then(
        ({ WebClient, LogLevel }) =>
          new WebClient(token, { logLevel: LogLevel.ERROR, rejectRateLimitedCalls: true, retryConfig: NETWORK_RETRY }),
      )
      .catch((error: unknown) => {
        web = undefined;
        throw error;
      });
    return web;
  };
  return {
    async whoAmI() {
      const result = await (await client()).auth.test();
      return { userId: result.user_id ?? "", ...(result.bot_id ? { botId: result.bot_id } : {}) };
    },
    async deleteMessage(channel, ts) {
      await (await client()).chat.delete({ channel, ts });
    },
  };
}

type ScopeOptions = Omit<GuardedDeleterOptions, "identity" | "backend">;

/** Deleter for the trusted user's own messages. This is the single use of the user token. */
export function createUserTokenDeleter(options: ScopeOptions & { userToken: string }): GuardedDeleter {
  const { userToken, ...scope } = options;
  return createGuardedDeleter({ ...scope, identity: "user", backend: webApiBackend(userToken) });
}

/** Deleter for the bridge's own messages, with the bot token. */
export function createBotTokenDeleter(options: ScopeOptions & { botToken: string }): GuardedDeleter {
  const { botToken, ...scope } = options;
  return createGuardedDeleter({ ...scope, identity: "bot", backend: webApiBackend(botToken) });
}
