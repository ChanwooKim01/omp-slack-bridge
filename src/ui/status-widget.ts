/**
 * Status widget showing Slack bridge membership.
 * Renders a minimal ascii dot (● joined / ○ not joined), plus "router" when this
 * session also holds the Slack socket, matching the style of /slk-bridge status output.
 */

export interface SlackStatus {
  /** This session is joined to the bridge. */
  connected: boolean;
  /** This session holds the Slack socket and routes messages for every joined session. */
  router?: boolean;
}

export function createStatusWidget(
  slackStatus: SlackStatus,
  _usersByTransport: Record<string, string[]>
): string | undefined {
  if (!slackStatus.connected) return "○ slk";
  return slackStatus.router ? "● slk router" : "● slk";
}
