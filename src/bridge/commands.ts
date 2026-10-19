/**
 * commands.ts — Bridge command definitions shared between Slack remote and TUI local handlers.
 */

// ── Bridge status text ─────────────────────────────────────────────────────

export interface BridgeStatus {
  /** This session is registered with the bridge: it can post to its Slack thread and receives routed replies. */
  joined: boolean;
  /** Who holds the one Slack Socket Mode connection. */
  router: "this-session" | "other-session" | "none";
  /** This process has the Slack socket open. */
  socketOpen: boolean;
  /** Joined sessions claim the router role on their own when no live router exists. */
  autoConnect: boolean;
  trustedUser: string | undefined;
  channels: number;
}

export function buildBridgeStatusText(status: BridgeStatus): string {
  const routerText =
    status.router === "this-session"
      ? `this session (socket ${status.socketOpen ? "open" : "not open"})`
      : status.router === "other-session"
        ? "another session"
        : "none — Slack messages are not being received";
  const lines = [
    "━━━ Slack Bridge Status ━━━",
    "",
    `  ${status.joined ? "●" : "○"} Session ${status.joined ? "joined" : "not joined (run /slk-bridge connect)"}`,
    `  ${status.router === "this-session" && status.socketOpen ? "●" : "○"} Router: ${routerText}`,
    "",
    `Auto-claim router: ${status.autoConnect ? "on" : "off"}`,
    `Trusted user: ${status.trustedUser ?? "None"}`,
    `Channels: ${status.channels}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ];

  return lines.join("\n");
}

// ── Remote command list ────────────────────────────────────────────────────

export function buildRemoteCommandList(
  commands: Array<{ source: string; name: string; description?: string }>,
): string {
  const skills = commands
    .filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
    .map((command) => ({
      name: command.name.slice("skill:".length),
      description: command.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const prompts = commands
    .filter((command) => command.source === "prompt")
    .map((command) => ({
      name: command.name,
      description: command.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines = [
    "Available remote commands",
    "",
    "General",
    "- `.` — show this command list",
    "",
    "Skills",
    ...(skills.length > 0
      ? skills.map((skill) => `- \`.skill ${skill.name} <args>\`${skill.description ? ` — ${skill.description}` : ""}`)
      : ["- None"]),
    "",
    "Prompts",
    ...(prompts.length > 0
      ? prompts.map((prompt) => `- \`.prompt ${prompt.name} <args>\`${prompt.description ? ` — ${prompt.description}` : ""}`)
      : ["- None"]),
    "",
    "Bridge",
    "- `.bridge status`",
    "- `.bridge connect`",
    "- `.bridge disconnect`",
    "- `.bridge new [cwd]`",
    "- `.bridge resume`",
    "- `.bridge resume list [number]`",
    "- `.bridge resume <number>`",
    "- `.bridge replay`",
    "- `.bridge sendfile <path>`",
    "- `.bridge toggletools`",
  ];

  return lines.join("\n");
}

// ── Bridge help text ───────────────────────────────────────────────────────

export function buildBridgeHelpText(): string {
  return [
    "━━━ Slack Bridge Commands ━━━",
    "",
    "/slk-bridge                   Open interactive menu",
    "/slk-bridge help              Show this help",
    "/slk-bridge status            Show join, router and user status",
    "/slk-bridge connect           Join this session to the bridge (becomes router if none is live)",
    "/slk-bridge disconnect        Leave the bridge (releases the router role if held)",
    "/slk-bridge router            Take the router role (the one Slack socket) from another session",
    "/slk-bridge configure <bot-token> <app-token>",
    "                              Configure Slack bot",
    "/slk-bridge widget            Toggle status widget on/off",
    "/slk-bridge autoconnect       Toggle auto-claiming the router role when no router is live",
    "/slk-bridge new [cwd]         Start a fresh bridge session for current or specified directory",
    "/slk-bridge resume             List recent sessions (default 10)",
    "/slk-bridge resume list [number]  Show more sessions (default 10)",
    "/slk-bridge resume <number>   Resume one of all recent sessions",
    "/slk-bridge sendfile <path>   Upload a local file to current Slack chat",
    "/slk-bridge releaseclaim      Re-open claiming for Slack",
    "/slk-bridge optout            Never auto-claim the router role in this session",
    "/slk-bridge optin             Allow this session to auto-claim the router role again",
    "/slk-bridge optout list       Show sessions that never auto-claim the router role",
    "/slk-bridge handover          Push terminal session to Slack",
    "/slk-bridge toggletools       Toggle tool call visibility",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");
}
