import {
  createChannelInboundDebouncer,
  createInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import type { Client } from "../internal/discord.js";
import {
  buildDiscordEditedInboundReplayKey,
  buildDiscordInboundReplayKey,
  claimDiscordInboundReplay,
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
  DiscordRetryableInboundError,
  releaseDiscordInboundReplay,
  resolveDiscordEditedTimestamp,
} from "./inbound-dedupe.js";
import { buildDiscordInboundJob } from "./inbound-job.js";
import type {
  DiscordMessageEvent,
  DiscordMessageHandler,
  DiscordMessageUpdateEvent,
  DiscordMessageUpdateHandler,
} from "./listeners.js";
import { applyImplicitReplyBatchGate } from "./message-handler.batch-gate.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import {
  createDiscordMessageRunQueue,
  type DiscordMessageRunQueueTestingHooks,
} from "./message-run-queue.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type PreflightDiscordMessage =
  typeof import("./message-handler.preflight.js").preflightDiscordMessage;

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  __testing?: DiscordMessageHandlerTestingHooks;
};

type DiscordMessageHandlerTestingHooks = DiscordMessageRunQueueTestingHooks & {
  preflightDiscordMessage?: PreflightDiscordMessage;
};

let messagePreflightRuntimePromise:
  | Promise<typeof import("./message-handler.preflight.js")>
  | undefined;

async function loadMessagePreflightRuntime() {
  messagePreflightRuntimePromise ??= import("./message-handler.preflight.js");
  return await messagePreflightRuntimePromise;
}

export type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => void;
  handleEdit?: DiscordMessageUpdateHandler;
};

const DEFAULT_DISCORD_EDIT_DEBOUNCE_MS = 2000;

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function createDiscordMessageHandler(
  params: DiscordMessageHandlerParams,
): DiscordMessageHandlerWithLifecycle {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const ackReactionScope =
    params.discordConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions";
  const preflightDiscordMessageImpl = params.__testing?.preflightDiscordMessage;
  const replayGuard = createDiscordInboundReplayGuard();
  const messageRunQueue = createDiscordMessageRunQueue({
    runtime: params.runtime,
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    replayGuard,
    __testing: params.__testing,
  });

  const { debouncer } = createChannelInboundDebouncer<{
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
    replayKey?: string;
  }>({
    cfg: params.cfg,
    channel: "discord",
    buildKey: (entry) => {
      const message = entry.data.message;
      const authorId = entry.data.author?.id;
      if (!message || !authorId) {
        return null;
      }
      const channelId = resolveDiscordMessageChannelId({
        message,
        eventChannelId: entry.data.channel_id,
      });
      if (!channelId) {
        return null;
      }
      return `discord:${params.accountId}:${channelId}:${authorId}`;
    },
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        text: baseText,
        cfg: params.cfg,
        hasMedia:
          (message.attachments && message.attachments.length > 0) ||
          hasDiscordMessageStickers(message),
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const replayKeys = entries.map((entry) => entry.replayKey).filter(isNonEmptyString);
      const abortSignal = last.abortSignal;
      if (abortSignal?.aborted) {
        releaseDiscordInboundReplay({
          replayKeys,
          error: abortSignal.reason,
          replayGuard,
        });
        return;
      }
      try {
        if (entries.length === 1) {
          const preflight =
            preflightDiscordMessageImpl ??
            (await loadMessagePreflightRuntime()).preflightDiscordMessage;
          const ctx = await preflight({
            ...params,
            ackReactionScope,
            groupPolicy,
            abortSignal,
            data: last.data,
            client: last.client,
          });
          if (!ctx) {
            await commitDiscordInboundReplay({ replayKeys, replayGuard });
            return;
          }
          applyImplicitReplyBatchGate(ctx, params.replyToMode, false);
          messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
          return;
        }
        const combinedBaseText = entries
          .map((entry) =>
            resolveDiscordMessageText(entry.data.message, { includeForwarded: false }),
          )
          .filter(Boolean)
          .join("\n");
        const syntheticMessage = Object.create(Object.getPrototypeOf(last.data.message), {
          ...Object.getOwnPropertyDescriptors(last.data.message),
          content: { value: combinedBaseText, enumerable: true, configurable: true },
          attachments: { value: [], enumerable: true, configurable: true },
          message_snapshots: {
            value: (last.data.message as { message_snapshots?: unknown }).message_snapshots,
            enumerable: true,
            configurable: true,
          },
          messageSnapshots: {
            value: (last.data.message as { messageSnapshots?: unknown }).messageSnapshots,
            enumerable: true,
            configurable: true,
          },
          rawData: {
            value: { ...(last.data.message as { rawData?: Record<string, unknown> }).rawData },
            enumerable: true,
            configurable: true,
          },
        }) as DiscordMessageEvent["message"];
        const syntheticData: DiscordMessageEvent = {
          ...last.data,
          message: syntheticMessage,
        };
        const preflight =
          preflightDiscordMessageImpl ??
          (await loadMessagePreflightRuntime()).preflightDiscordMessage;
        const ctx = await preflight({
          ...params,
          ackReactionScope,
          groupPolicy,
          abortSignal,
          data: syntheticData,
          client: last.client,
        });
        if (!ctx) {
          await commitDiscordInboundReplay({ replayKeys, replayGuard });
          return;
        }
        applyImplicitReplyBatchGate(ctx, params.replyToMode, true);
        if (entries.length > 1) {
          const ids = entries.map((entry) => entry.data.message?.id).filter(isNonEmptyString);
          if (ids.length > 0) {
            const ctxBatch = ctx as typeof ctx & {
              MessageSids?: string[];
              MessageSidFirst?: string;
              MessageSidLast?: string;
            };
            ctxBatch.MessageSids = ids;
            ctxBatch.MessageSidFirst = ids[0];
            ctxBatch.MessageSidLast = ids[ids.length - 1];
          }
        }
        messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
      } catch (error) {
        if (error instanceof DiscordRetryableInboundError) {
          releaseDiscordInboundReplay({ replayKeys, error, replayGuard });
        } else {
          await commitDiscordInboundReplay({ replayKeys, replayGuard });
        }
        throw error;
      }
    },
    onError: (err) => {
      params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
    },
  });

  const handler: DiscordMessageHandlerWithLifecycle = async (data, client, options) => {
    try {
      if (options?.abortSignal?.aborted) {
        return;
      }
      // Filter bot-own messages before they enter the debounce queue.
      // The same check exists in preflightDiscordMessage(), but by that point
      // the message has already consumed debounce capacity and blocked
      // legitimate user messages. On active servers this causes cumulative
      // slowdown (see #15874).
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return;
      }
      const replayKey = buildDiscordInboundReplayKey({
        accountId: params.accountId,
        data,
      });
      if (
        !(await claimDiscordInboundReplay({
          replayKey,
          replayGuard,
        }))
      ) {
        return;
      }

      await debouncer.enqueue({
        data,
        client,
        abortSignal: options?.abortSignal,
        replayKey: replayKey ?? undefined,
      });
    } catch (err) {
      params.runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };

  handler.deactivate = messageRunQueue.deactivate;

  const handleEditsEnabled = params.discordConfig?.handleEdits === true;
  if (handleEditsEnabled) {
    const editDebouncer = createDiscordEditDebouncer({
      ...params,
      ackReactionScope,
      groupPolicy,
      replayGuard,
      messageRunQueue,
      preflightDiscordMessageImpl,
    });
    handler.handleEdit = async (data, client, options) => {
      try {
        if (options?.abortSignal?.aborted) {
          return;
        }
        if (!shouldProcessDiscordEdit({ data, botUserId: params.botUserId })) {
          return;
        }
        const replayKey = buildDiscordEditedInboundReplayKey({
          accountId: params.accountId,
          data,
        });
        if (
          !(await claimDiscordInboundReplay({
            replayKey,
            replayGuard,
          }))
        ) {
          return;
        }
        await editDebouncer.enqueue({
          data,
          client,
          abortSignal: options?.abortSignal,
          replayKey: replayKey ?? undefined,
        });
      } catch (err) {
        params.runtime.error?.(danger(`edit handler failed: ${String(err)}`));
      }
    };
  }

  return handler;
}

function shouldProcessDiscordEdit(params: {
  data: DiscordMessageUpdateEvent;
  botUserId?: string;
}): boolean {
  const message = params.data.message as
    | {
        id?: string;
        author?: { id?: string; bot?: boolean };
        content?: unknown;
      }
    | null
    | undefined;
  if (!message?.id) {
    return false;
  }
  // Drop update events that do not include an edited_timestamp. Discord
  // dispatches MESSAGE_UPDATE for many non-edit reasons (embed link
  // unfurls, pin changes, component/flag updates) and those events don't
  // set edited_timestamp, so this cleanly filters them out without
  // re-running the agent on spurious server-side updates.
  if (!resolveDiscordEditedTimestamp(params.data)) {
    return false;
  }
  if (typeof message.content !== "string") {
    return false;
  }
  const authorId = message.author?.id ?? params.data.author?.id;
  if (params.botUserId && authorId === params.botUserId) {
    return false;
  }
  return true;
}

type DiscordEditDebounceEntry = {
  data: DiscordMessageUpdateEvent;
  client: Client;
  abortSignal?: AbortSignal;
  replayKey?: string;
};

function createDiscordEditDebouncer(
  params: Omit<
    DiscordMessagePreflightParams,
    "ackReactionScope" | "groupPolicy" | "data" | "client"
  > & {
    ackReactionScope: DiscordMessagePreflightParams["ackReactionScope"];
    groupPolicy: DiscordMessagePreflightParams["groupPolicy"];
    replayGuard: ReturnType<typeof createDiscordInboundReplayGuard>;
    messageRunQueue: ReturnType<typeof createDiscordMessageRunQueue>;
    preflightDiscordMessageImpl?: PreflightDiscordMessage;
  },
) {
  const resolvedEditDebounceMs =
    typeof params.discordConfig?.editDebounceMs === "number" &&
    Number.isFinite(params.discordConfig.editDebounceMs)
      ? Math.max(0, Math.trunc(params.discordConfig.editDebounceMs))
      : DEFAULT_DISCORD_EDIT_DEBOUNCE_MS;

  return createInboundDebouncer<DiscordEditDebounceEntry>({
    debounceMs: resolvedEditDebounceMs,
    buildKey: (entry) => {
      const messageId = entry.data.message?.id;
      if (!messageId) {
        return null;
      }
      const channelId = resolveDiscordMessageChannelId({
        message: entry.data.message,
        eventChannelId: entry.data.channel_id,
      });
      if (!channelId) {
        return null;
      }
      // Per-message key: rapid successive edits to the same message coalesce
      // into one preflight + run queue enqueue. Different messages run in
      // parallel.
      return `discord:edit:${params.accountId}:${channelId}:${messageId}`;
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const replayKeys = entries.map((entry) => entry.replayKey).filter(isNonEmptyString);
      const abortSignal = last.abortSignal;
      if (abortSignal?.aborted) {
        releaseDiscordInboundReplay({
          replayKeys,
          error: abortSignal.reason,
          replayGuard: params.replayGuard,
        });
        return;
      }
      try {
        const preflight =
          params.preflightDiscordMessageImpl ??
          (await loadMessagePreflightRuntime()).preflightDiscordMessage;
        const ctx = await preflight({
          ...params,
          abortSignal,
          // The update event shape is a structural superset of what
          // preflight reads, so we coerce at the boundary rather than
          // carrying a second preflight contract for edits.
          data: last.data as unknown as DiscordMessageEvent,
          client: last.client,
        });
        if (!ctx) {
          await commitDiscordInboundReplay({
            replayKeys,
            replayGuard: params.replayGuard,
          });
          return;
        }
        applyImplicitReplyBatchGate(ctx, params.replyToMode, false);
        params.messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
      } catch (error) {
        if (error instanceof DiscordRetryableInboundError) {
          releaseDiscordInboundReplay({
            replayKeys,
            error,
            replayGuard: params.replayGuard,
          });
        } else {
          await commitDiscordInboundReplay({
            replayKeys,
            replayGuard: params.replayGuard,
          });
        }
        throw error;
      }
    },
    onError: (err) => {
      params.runtime.error?.(danger(`discord edit debounce flush failed: ${String(err)}`));
    },
  });
}
