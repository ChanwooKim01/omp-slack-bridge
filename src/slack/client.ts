import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChallengeAuth } from "../auth/challenge.js";
import type { ExternalMessage } from "../types/index.js";
import { markdownToBlocks, splitMarkdownIntoMessages } from "./blocks.js";

/**
 * Options for file uploads via the Slack client.
 */
export interface TransportFileOptions {
  title?: string;
  initialComment?: string;
  threadId?: string;
}

// Dynamic import for ESM modules
type App = any;

const SLACK_DOWNLOAD_DIR = path.join(os.homedir(), ".pi", "slk-bridge-downloads", "slack");

function ensureSlackDownloadDir(): void {
  if (!fs.existsSync(SLACK_DOWNLOAD_DIR)) {
    fs.mkdirSync(SLACK_DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
  }
}

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename || "file");
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function loadSlackBolt() {
  const slack = await import("@slack/bolt");
  return slack;
}

// Lazy like @slack/bolt: loading the Slack SDK is slow, and a session that never posts should not pay for it
// (sessions start before the network is necessarily up).
async function loadSlackWebApi() {
  return import("@slack/web-api");
}

/**
 * Errors from the Web API carry the machine-readable code in `data.error`; transport errors in `code`.
 */
function slackErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    if ("data" in error && error.data && typeof error.data === "object" && "error" in error.data && error.data.error) {
      return String(error.data.error);
    }
    if ("code" in error && error.code) return String(error.code);
    if ("message" in error && error.message) return String(error.message);
  }
  return String(error);
}

/**
 * The slice of the Slack Web API this client calls. Typed structurally so Block Kit payloads built
 * elsewhere stay loosely typed; the real WebClient is cast to it once, where it is constructed.
 */
interface SlackWebApi {
  chat: { postMessage(args: Record<string, unknown>): Promise<{ ts?: string }> };
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
  files: { uploadV2(args: Record<string, unknown>): Promise<unknown> };
}

// Fail-fast guard for the Socket Mode connect. The underlying @slack/socket-mode
// client retries `apps.connections.open` with exponential backoff (retries: 100,
// factor: 1.3, maxTimeout: Infinity), so an unreachable Slack can otherwise block
// connect() (and anything awaiting it) for a very long time.
const CONNECT_TIMEOUT_MS = 10_000;

const TIMEOUT_SENTINEL = Symbol("slack-connect-timeout");

/**
 * Rejects with TIMEOUT_SENTINEL after `ms` milliseconds unless the competing
 * promise settles first. Used to fail fast instead of hanging on a slow or
 * unreachable Slack connection.
 */
async function timeoutReject(ms: number): Promise<symbol> {
  return new Promise<symbol>((resolve) => {
    setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
  });
}

/**
 * Slack client.
 *
 * Receiving uses @slack/bolt over Socket Mode and is only done by the router session.
 * Sending (messages, reactions, file uploads) uses the Web API with the bot token alone,
 * so every joined session can post whether or not it holds the socket.
 */
export class SlackClient {
  readonly type = "slack";
  private app: App | null = null;
  private web: Promise<SlackWebApi> | null = null;
  private _isConnected = false;
  private botUserId: string = "";
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error) => void;
  private processedMessageIds = new Set<string>();

  // Cache user info to avoid repeated API calls
  private userCache: Map<string, string> = new Map();
  // Cache channel info to detect DMs vs channels
  private channelCache: Map<string, { isDM: boolean; name?: string }> = new Map();

  constructor(
    private config: { botToken: string; appToken: string },
    private auth: ChallengeAuth,
    private connectTimeoutMs: number = CONNECT_TIMEOUT_MS
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  private async downloadSlackFile(file: any): Promise<string> {
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      throw new Error(`Slack file ${file.id || file.name || "unknown"} has no download URL`);
    }

    ensureSlackDownloadDir();
    const filename = sanitizeFilename(file.name || file.title || file.id || "file");
    const targetPath = path.join(
      SLACK_DOWNLOAD_DIR,
      `${Date.now()}-${file.id || "file"}-${filename}`,
    );

    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Slack file download failed (${response.status} ${response.statusText})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(targetPath, buffer, { mode: 0o600 });
    return targetPath;
  }

  private async buildIncomingContent(message: any): Promise<string | null> {
    const text = typeof message.text === "string" ? message.text.trim() : "";

    if (message.subtype === "file_share" && Array.isArray(message.files) && message.files.length > 0) {
      const fileLines: string[] = [];

      for (const file of message.files) {
        const savedPath = await this.downloadSlackFile(file);
        const size = typeof file.size === "number" ? `${file.size.toLocaleString()} bytes` : "size unknown";
        const mimetype = file.mimetype || file.filetype || "unknown type";
        fileLines.push(
          `- ${file.name || file.title || file.id} (${mimetype}, ${size})\n  Saved to: ${savedPath}`,
        );
      }

      const parts = [
        `uploaded ${message.files.length === 1 ? "a file" : `${message.files.length} files`}:`,
        ...fileLines,
      ];

      if (text) {
        parts.push(`Comment: ${text}`);
      }

      return parts.join("\n");
    }

    return text || null;
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    // Fail-fast guard: the underlying @slack/bolt socket-mode client retries
    // `apps.connections.open` with exponential backoff (retries: 100, factor:
    // 1.3, maxTimeout: Infinity) and the extension's session_start used to await
    // this — an unreachable Slack could block startup for a very long time.
    // Wrap the whole connect (bolt import + auth.test() + socket start) in a
    // timeout so a slow/unreachable Slack never hangs the caller.
    const result = await Promise.race([
      this.doConnect(),
      timeoutReject(this.connectTimeoutMs),
    ]);

    // If we raced with the timeout, the socket may still be connecting in the
    // background; stop whatever got partially set up so state stays consistent.
    if (result === TIMEOUT_SENTINEL) {
      await this.abortPartialConnect();
      throw new Error("Slack connection timed out");
    }
  }

  private async doConnect(): Promise<void> {
    if (this._isConnected) return;

    const { botToken, appToken } = this.config;

    if (!botToken || !appToken) {
      throw new Error("Slack requires both botToken (xoxb-...) and appToken (xapp-...)");
    }

    const slack = await loadSlackBolt();

    this.app = new slack.App({
      token: botToken,
      appToken: appToken,
      socketMode: true,
      logLevel: slack.LogLevel.ERROR,
    });

    // Get bot's own user ID for mention detection
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id || "";
    } catch (e) {
      if (this.errorHandler) {
        this.errorHandler(new Error(`Slack bot info lookup failed: ${(e as Error).message}`));
      }
    }

    // Listen for all messages
    this.app.message(async ({ message, client }: any) => {
      // Skip bot messages, message edits, deletes, etc. but allow file shares.
      if (message.subtype && message.subtype !== "file_share") {
        return;
      }

      if (!("user" in message) || !("channel" in message) || !("ts" in message)) {
        return;
      }

      const userId = message.user;
      const channelId = message.channel;
      const ts = message.ts;
      // Trust may have changed in another process since the last message (for example a release of
      // the claim from a non-router session): refresh first so the trusted-user filter below and the
      // authorization check further down work from the same current state.
      this.auth.refreshFromConfig();
      const pairing = this.auth.exportConfig();
      const trustedUser = pairing.trustedUser?.split(":")[0];
      if (trustedUser && userId !== trustedUser) return;
      const pairedChat = trustedUser ? pairing.userChats?.[trustedUser] : undefined;
      if (pairedChat && channelId !== pairedChat) return;

      const content = await this.buildIncomingContent(message);
      if (!content) {
        return;
      }

      // Filter out duplicate messages
      if (this.processedMessageIds.has(`${channelId}:${ts}`)) return;
      this.processedMessageIds.add(`${channelId}:${ts}`);
      if (this.processedMessageIds.size > 4096) {
        const oldest = this.processedMessageIds.values().next().value;
        if (oldest) this.processedMessageIds.delete(oldest);
      }

      // Get username from cache or fetch
      let username: string = this.userCache.get(userId) || userId;
      if (!this.userCache.has(userId)) {
        try {
          const userInfo = await client.users.info({ user: userId });
          const fetchedName = userInfo.user?.real_name || userInfo.user?.name;
          if (fetchedName) {
            username = fetchedName;
            this.userCache.set(userId, username);
          }
        } catch {
          username = userId;
        }
      }

      // Get channel info from cache or fetch (to detect DM vs channel)
      let channelInfo = this.channelCache.get(channelId);
      if (!channelInfo) {
        try {
          const convInfo = await client.conversations.info({ channel: channelId });
          const conv = convInfo.channel;
          // is_im = direct message, is_mpim = multi-party DM
          const isDM = conv?.is_im === true || conv?.is_mpim === true;
          const name = conv?.name || (isDM ? "DM" : channelId);
          channelInfo = { isDM, name };
          this.channelCache.set(channelId, channelInfo);
        } catch {
          // Channel IDs remain authoritative when optional metadata scopes are absent.
          channelInfo = { isDM: channelId.startsWith("D") };
          this.channelCache.set(channelId, channelInfo);
        }
      }

      // Detect bot mention: <@BOT_USER_ID>
      const wasMentioned = this.botUserId
        ? content.includes(`<@${this.botUserId}>`)
        : false;

      const isGroupChat = !channelInfo.isDM;
      const effectiveThreadId = typeof message.thread_ts === "string" && message.thread_ts.trim()
        ? message.thread_ts : (!isGroupChat ? ts : undefined);
      const isThreadReply = typeof message.thread_ts === "string" && message.thread_ts.trim().length > 0;

      // Check authorization
      const sendMessageToUser = async (cId: string, text: string) => {
        const web = await this.getWebClient();
        await web.chat.postMessage({ channel: cId, text });
      };

      const isAuthorized = await this.auth.checkAuthorization(
        userId,
        channelId,
        username,
        isGroupChat,
        wasMentioned,
        sendMessageToUser
      );

      // Handle admin commands and challenge codes in DM
      if (!isGroupChat && (content.startsWith("/") || content.match(/^\d{6}$/))) {
        const handled = await this.auth.handleAdminCommand(
          content,
          channelId,
          userId,
          async (text) => await this.sendMessage(channelId, text)
        );
        if (handled) {
          return;
        }
      }

      if (!isAuthorized) {
        return; // Auth handler already sent challenge/error messages
      }

      // Forward to message handler
      if (this.messageHandler) {
        const externalMessage: ExternalMessage = {
          chatId: channelId,

          content,
          username: username,
          userId: userId,
          timestamp: new Date(parseFloat(ts) * 1000),
          messageId: ts,
          isGroupChat,
          wasMentioned,
          threadId: effectiveThreadId,
          isThreadReply,
        };

        this.messageHandler(externalMessage);
      }
    });

    // Handle errors
    this.app.error(async (error: any) => {
      if (this.errorHandler) {
        this.errorHandler(new Error(String(error)));
      }
    });

    try {
      const app = this.app;
      await app.start();
      // Guard against a stale connect racing past abortPartialConnect(): only
      // mark connected if this is still the current app (not one we tore down
      // after a timeout).
      if (this.app === app) {
        this._isConnected = true;
      }
    } catch (error) {
      throw new Error(`Slack connection failed: ${(error as Error).message}`);
    }
  }

  /**
   * Best-effort teardown after a connect timeout. The socket may still be
   * connecting in the background, so stop the app and reset state so a later
   * connect() starts clean.
   */
  private async abortPartialConnect(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // Ignore stop errors during teardown
      }
      this.app = null;
    }
    this._isConnected = false;
    this.botUserId = "";
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // Ignore stop errors
      }
      this.app = null;
    }
    this._isConnected = false;
    this.userCache.clear();
    this.channelCache.clear();
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.sendMessageInThread(chatId, text);
  }

  /** Web API client built from the bot token alone; the Socket Mode connection is never required. */
  private async getWebClient(): Promise<SlackWebApi> {
    if (!this.config.botToken) {
      throw new Error("Slack bot token is not configured");
    }
    this.web ??= loadSlackWebApi()
      .then(({ WebClient, LogLevel }) =>
        // Boundary cast: SlackWebApi is the structural subset of WebClient used here.
        new WebClient(this.config.botToken, { logLevel: LogLevel.ERROR }) as unknown as SlackWebApi)
      .catch((error) => {
        this.web = null;
        throw error;
      });
    return this.web;
  }

  async sendMessageInThread(
    chatId: string,
    text: string,
    threadTs?: string,
    footerText?: string,
    onPosted?: (lastTs: string) => void,
  ): Promise<string | undefined> {
    if (!text?.trim()) return threadTs;
    const web = await this.getWebClient();

    try {
      const messageChunks = splitMarkdownIntoMessages(text);
      let rootThreadTs = threadTs;

      for (let i = 0; i < messageChunks.length; i++) {
        const chunk = messageChunks[i];
        const blocks = markdownToBlocks(chunk);
        if (footerText && i === messageChunks.length - 1) {
          blocks.push({
            type: "context",
            elements: [{ type: "mrkdwn", text: footerText }],
          });
        }

        const response = await web.chat.postMessage({
          channel: chatId,
          text: chunk,
          blocks,
          thread_ts: rootThreadTs,
        });

        if (!rootThreadTs) {
          rootThreadTs = response.ts;
        }
        if (i === messageChunks.length - 1 && response.ts) onPosted?.(response.ts);
      }

      return rootThreadTs;
    } catch (error) {
      throw new Error(`Slack send failed: ${(error as Error).message}`);
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Slack doesn't support typing indicators for bots
  }

  async addReaction(chatId: string, messageTs: string, emoji: string): Promise<void> {
    const web = await this.getWebClient();

    try {
      await web.reactions.add({
        channel: chatId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "already_reacted") return;
      throw new Error(`Slack add reaction failed: ${code}`);
    }
  }

  async removeReaction(chatId: string, messageTs: string, emoji: string): Promise<void> {
    const web = await this.getWebClient();

    try {
      await web.reactions.remove({
        channel: chatId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === "no_reaction" || code === "message_not_found") return;
      throw new Error(`Slack remove reaction failed: ${code}`);
    }
  }

  async sendFile(chatId: string, filePath: string, options?: TransportFileOptions): Promise<void> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    const web = await this.getWebClient();
    try {
      await web.files.uploadV2({
        channel_id: chatId,
        file: fs.createReadStream(filePath),
        filename: path.basename(filePath),
        title: options?.title,
        initial_comment: options?.initialComment,
        thread_ts: options?.threadId,
      });
    } catch (error) {
      throw new Error(`Slack file upload failed: ${(error as Error).message}`);
    }
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
}
