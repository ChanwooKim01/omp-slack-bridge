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
  /** Thread pruning: the settings in force, and whether a user token makes automatic pruning possible. */
  threadPruning?: { keep: number; pruneAt: number; userToken: boolean };
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
    ...(status.threadPruning
      ? [
          `Thread pruning: keep ${status.threadPruning.keep}, prune at ${status.threadPruning.pruneAt}` +
            (status.threadPruning.userToken ? "" : " (off: no user token)"),
        ]
      : []),
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
    "- `.bridge new` — summarize and clear this thread's history (needs a user token)",
    "- `.bridge new <cwd>` — start a fresh tmux bridge session in <cwd>",
    "- `.bridge title <text>` — set this thread's title",
    "- `.bridge keep <N>` — keep the newest N interactions when threads are pruned (1-50, default 5)",
    "- `.bridge pruneat <M>` — prune a thread once it holds M interactions (default 2x keep)",
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
    "/slk-bridge configure <bot-token> <app-token> [user-token]",
    "                              Configure Slack bot; the optional user token enables thread pruning",
    "/slk-bridge widget            Toggle status widget on/off",
    "/slk-bridge autoconnect       Toggle auto-claiming the router role when no router is live",
    "/slk-bridge new               Summarize and clear this session's Slack thread (needs a user token)",
    "/slk-bridge new <cwd>         Start a fresh bridge session in the given directory",
    "/slk-bridge title <text>      Set this session's Slack thread title",
    "/slk-bridge keep <N>          Keep the newest N interactions when threads are pruned (1-50, default 5)",
    "/slk-bridge pruneat <M>       Prune a thread once it holds M interactions (default 2x keep)",
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
