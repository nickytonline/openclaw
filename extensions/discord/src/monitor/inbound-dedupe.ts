import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import type { DiscordMessageEvent, DiscordMessageUpdateEvent } from "./listeners.js";
import { resolveDiscordMessageChannelId } from "./message-utils.js";

const RECENT_DISCORD_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_DISCORD_MESSAGE_MAX = 5000;

export function createDiscordInboundReplayGuard(): ClaimableDedupe {
  return createClaimableDedupe({
    ttlMs: RECENT_DISCORD_MESSAGE_TTL_MS,
    memoryMaxSize: RECENT_DISCORD_MESSAGE_MAX,
  });
}

export class DiscordRetryableInboundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordRetryableInboundError";
  }
}

export function buildDiscordInboundReplayKey(params: {
  accountId: string;
  data: DiscordMessageEvent;
}): string | null {
  const messageId = params.data.message?.id?.trim();
  if (!messageId) {
    return null;
  }
  const channelId = resolveDiscordMessageChannelId({
    message: params.data.message,
    eventChannelId: params.data.channel_id,
  });
  if (!channelId) {
    return null;
  }
  return `${params.accountId}:${channelId}:${messageId}`;
}

export function buildDiscordEditedInboundReplayKey(params: {
  accountId: string;
  data: DiscordMessageUpdateEvent;
}): string | null {
  const messageId = params.data.message?.id?.trim();
  if (!messageId) {
    return null;
  }
  const channelId = resolveDiscordMessageChannelId({
    message: params.data.message,
    eventChannelId: params.data.channel_id,
  });
  if (!channelId) {
    return null;
  }
  const editedTimestamp = resolveDiscordEditedTimestamp(params.data);
  const editToken = editedTimestamp ?? "unknown";
  return `${params.accountId}:${channelId}:${messageId}:edit:${editToken}`;
}

export function resolveDiscordEditedTimestamp(data: DiscordMessageUpdateEvent): string | null {
  const message = data.message as
    | {
        edited_timestamp?: unknown;
        editedTimestamp?: unknown;
      }
    | null
    | undefined;
  const raw =
    typeof message?.edited_timestamp === "string"
      ? message.edited_timestamp
      : typeof message?.editedTimestamp === "string"
        ? message.editedTimestamp
        : null;
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function claimDiscordInboundReplay(params: {
  replayKey?: string | null;
  replayGuard: ClaimableDedupe;
}): Promise<boolean> {
  const replayKey = params.replayKey?.trim();
  if (!replayKey) {
    return true;
  }
  const claim = await params.replayGuard.claim(replayKey);
  return claim.kind === "claimed";
}

export async function commitDiscordInboundReplay(params: {
  replayKeys?: readonly (string | null | undefined)[];
  replayGuard: ClaimableDedupe;
}): Promise<void> {
  const replayKeys = normalizeDiscordInboundReplayKeys(params.replayKeys);
  await Promise.all(replayKeys.map((replayKey) => params.replayGuard.commit(replayKey)));
}

export function releaseDiscordInboundReplay(params: {
  replayKeys?: readonly (string | null | undefined)[];
  replayGuard: ClaimableDedupe;
  error?: unknown;
}): void {
  const replayKeys = normalizeDiscordInboundReplayKeys(params.replayKeys);
  replayKeys.forEach((replayKey) => params.replayGuard.release(replayKey, { error: params.error }));
}

function normalizeDiscordInboundReplayKeys(
  replayKeys?: readonly (string | null | undefined)[],
): string[] {
  return [
    ...new Set(
      (replayKeys ?? [])
        .map((replayKey) => replayKey?.trim())
        .filter((replayKey): replayKey is string => Boolean(replayKey)),
    ),
  ];
}
