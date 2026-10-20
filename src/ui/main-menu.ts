/**
 * main-menu.ts — Interactive main menu for /slk-bridge.
 *
 * Pure UI layer — collects user input and delegates actions to the bridge.
 * The bridge owns all state and all Slack lifecycle.
 */

import { buildBridgeHelpText } from "../bridge/commands.js";
import { looksLikeUserToken } from "../bridge/thread-settings.js";
import { updateConfig } from "../config/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type MenuUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type: "info" | "warning" | "error"): void;
};

export interface MenuContext {
  ui: MenuUI;

  /** Rebuild the Slack client from the current config and join this session (becoming router if none is live). */
  reconnect: () => Promise<void>;

  /** Leave the bridge: unregister this session and, if it is the router, release the Slack socket. */
  disconnect: () => Promise<void>;

  /** Toggle tool call visibility in remote messages. */
  toggleToolCalls: () => void;

  /** Toggle whether joined sessions auto-claim the router role when no live router exists. */
  toggleAutoConnect: () => void;

  /** Keep this session from auto-claiming the router role. */
  optOut: () => void;

  /** Allow this session to auto-claim the router role again. */
  optIn: () => void;

  /** Get a status line string for the menu title. */
  getStatusLine: () => string;
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function doConnect(mctx: MenuContext): Promise<void> {
  try {
    await mctx.reconnect();
    mctx.ui.notify("✅ Joined the Slack bridge", "info");
  } catch (err) {
    mctx.ui.notify(`❌ Connection failed: ${(err as Error).message}`, "error");
  }
}

async function doDisconnect(mctx: MenuContext): Promise<void> {
  await mctx.disconnect();
  mctx.ui.notify("🔌 Left the Slack bridge", "info");
}

async function doConfigure(mctx: MenuContext): Promise<void> {
  const botToken = await mctx.ui.input("Slack bot token (xoxb-...)");
  if (!botToken) return;
  const appToken = await mctx.ui.input("Slack app token (xapp-...)");
  if (!appToken) return;
  const userToken = (await mctx.ui.input("Slack user token (xoxp-..., optional: enables thread pruning)"))?.trim();
  if (userToken && !looksLikeUserToken(userToken)) {
    mctx.ui.notify("❌ The user token must be a Slack user token (xoxp-...), not a bot or app token", "error");
    return;
  }

  // Skipping the user token keeps the stored one: dropping it would silently turn pruning off.
  updateConfig((config) => {
    const keptUserToken = userToken || config.slack?.userToken;
    config.slack = { botToken, appToken, ...(keptUserToken ? { userToken: keptUserToken } : {}) };
  });

  try {
    await mctx.reconnect();
    mctx.ui.notify("✅ Slack configured and joined", "info");
  } catch (err) {
    mctx.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
  }
}

// ── Main menu ───────────────────────────────────────────────────────────────

export async function openMainMenu(mctx: MenuContext): Promise<void> {
  const mainMenu = async (): Promise<void> => {
    const title = `Slack Bridge\n${mctx.getStatusLine()}`;

    const choices = [
      "Connect",
      "Disconnect",
      "Configure",
      "Toggle Tool Calls",
      "Toggle Auto Connect",
      "Opt out",
      "Opt in",
      "Help",
    ];

    const choice = await mctx.ui.select(title, choices);
    if (!choice) return;

    switch (choice) {
      case "Connect":
        await doConnect(mctx);
        break;
      case "Disconnect":
        await doDisconnect(mctx);
        break;
      case "Configure":
        await doConfigure(mctx);
        break;
      case "Toggle Tool Calls":
        mctx.toggleToolCalls();
        break;
      case "Toggle Auto Connect":
        mctx.toggleAutoConnect();
        break;
      case "Opt out":
        mctx.optOut();
        break;
      case "Opt in":
        mctx.optIn();
        break;
      case "Help":
        mctx.ui.notify(buildBridgeHelpText(), "info");
        break;
    }
    return mainMenu();
  };
  await mainMenu();
}
