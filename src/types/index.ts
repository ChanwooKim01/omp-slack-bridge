/**
 * Shared type definitions for the Slack bridge extension.
 */

/**
 * External message received from Slack.
 */
export interface ExternalMessage {
  /** Slack channel ID */
  chatId: string;
  /** Message content/text */
  content: string;
  /** Sender username */
  username: string;
  /** Sender Slack user ID */
  userId: string;
  /** Message timestamp */
  timestamp: Date;
  /** Slack message timestamp (ts) */
  messageId: string;
  /** Is this a group/channel message? */
  isGroupChat: boolean;
  /** Was the bot mentioned? (for group chats) */
  wasMentioned?: boolean;
  /** Slack thread_ts when replying inside a thread */
  threadId?: string;
  /** Whether the incoming message was sent as a reply inside an existing thread */
  isThreadReply?: boolean;
}

/**
 * Slack bridge configuration.
 */
export interface SlackBridgeConfig {
  slack?: {
    botToken: string;
    appToken: string;
  };
  auth?: {
    trustedUser?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
    userChats?: Record<string, string>;
    claimOpen?: boolean;
  };
  slackRouting?: {
    threadsByKey?: Record<string, { sessionPath: string; updatedAt: string }>;
    activeThreadBySessionChat?: Record<string, { threadTs: string; updatedAt: string }>;
    lastAssistantDeliveryByThread?: Record<string, { sessionPath: string; assistantEntryId: string; updatedAt: string }>;
  };
  hideToolCalls?: boolean;
  /**
   * Whether joined sessions claim the router role (the single Slack socket) on their own when no
   * live router exists. Default on. Joining and leaving never touch this flag.
   */
  autoConnect?: boolean;
  showWidget?: boolean;
  debug?: boolean;
  /** Session file paths that never auto-claim the router role, even when `autoConnect` is on. */
  optedOutSessions?: string[];
  /** Session file paths joined to the Slack bridge; a restarted process for the same session rejoins on start. */
  joinedSessions?: string[];
}

/**
 * Pending remote chat session tracking.
 */
export interface PendingRemoteChat {
  chatId: string;
  username: string;
  messageId: string;
  threadId?: string;
  isThreadReply?: boolean;
}

/**
 * Slack connection status.
 */
export interface ConnectionStatus {
  connected: boolean;
  error?: string;
}
