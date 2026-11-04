import type {
  CaptainPromptKind,
  CaptainSettingsView,
} from "@eta/client-contracts";
import type { CaptainService } from "./service";
import { Args, productPlugin, publish } from "../wire";

export interface CaptainPluginDeps {
  service: CaptainService;
  changed: (conversationIds?: readonly string[]) => void;
}

const PROMPT_KINDS: readonly CaptainPromptKind[] = [
  "instructions",
  "persona",
  "base",
];

export function captainPlugin(deps: CaptainPluginDeps, applied: () => void) {
  const { service } = deps;
  return productPlugin(
    "captain",
    ({ wire }) => {
      const offs = [
        publish(
          wire,
          "captain",
          {
            identity: () => service.identity() ?? null,
            assignments: () => service.store.assignments(),
            operations: () => service.store.operations(),
            notifications: () => service.store.notifications(),
            memoryPauses: () => service.store.memoryPauses(),
            settings: () => service.settings(),
          },
          { eager: true },
        ),

        wire.handle("captain", "ensure", async () => ({
          result: await service.ensure(),
        })),

        wire.handle("captain", "direct", async () => ({
          result: await service.direct(),
        })),

        wire.handle("captain", "assign", async (call) => {
          const args = new Args(call);
          const mode = args.optionalString("mode");
          if (mode !== undefined && mode !== "queue" && mode !== "steer")
            throw new Error("captain.assign: mode must be queue or steer");
          const result = await service.assign({
            conversationId: args.string("conversationId"),
            text: args.string("text"),
            agentIds: args.strings("agentIds"),
            ...(mode === undefined ? {} : { mode }),
            rootMessageId: args.nullableString("rootMessageId") ?? null,
          });
          return { result };
        }),

        wire.handle("captain", "decideOperation", async (call) => {
          const args = new Args(call);
          const decision = args.string("decision");
          if (decision !== "approve" && decision !== "reject")
            throw new Error(
              "captain.decideOperation: decision must be approve or reject",
            );
          return {
            result: {
              operation: await service.decideOperation(
                args.string("operationId"),
                decision,
              ),
            },
          };
        }),

        wire.handle("captain", "setMemoryPaused", (call) => {
          const args = new Args(call);
          const scopeType = args.string("scopeType");
          if (scopeType !== "conversation" && scopeType !== "task")
            throw new Error(
              "captain.setMemoryPaused: scopeType must be conversation or task",
            );
          const paused = args.optionalBoolean("paused");
          if (paused === undefined)
            throw new Error("captain.setMemoryPaused: paused is required");
          return {
            result: {
              pause: service.setMemoryPaused({
                scopeType,
                scopeId: args.string("scopeId"),
                paused,
                updatedBy: null,
              }),
            },
          };
        }),

        wire.handle("captain", "promptHistory", (call) => {
          const args = new Args(call);
          const kind = args.optionalString("kind");
          if (kind !== undefined && !PROMPT_KINDS.includes(kind as never))
            throw new Error("captain.promptHistory: invalid kind");
          return {
            result: {
              versions: service.promptHistory({
                subjectId: args.optionalString("subjectId"),
                ...(kind === undefined
                  ? {}
                  : { kind: kind as CaptainPromptKind }),
                limit: args.optionalInteger("limit"),
              }),
            },
          };
        }),

        wire.handle("captain", "setPrompt", (call) => {
          const args = new Args(call);
          const kind = args.string("kind") as CaptainPromptKind;
          if (!PROMPT_KINDS.includes(kind))
            throw new Error("captain.setPrompt: invalid kind");
          const captainId = service.identity()?.agentId;
          const subjectId = args.string("subjectId");
          if (kind === "base" || subjectId === captainId)
            throw new Error(
              "the base prompt and Captain's own prompt require an approved Captain operation",
            );
          return {
            result: {
              version: service.setPrompt({
                subjectId,
                kind,
                content: args.string("content"),
                actorAgentId: null,
              }),
            },
          };
        }),

        wire.handle("captain", "rollbackPrompt", (call) => {
          const args = new Args(call);
          const kind = args.string("kind") as CaptainPromptKind;
          if (!PROMPT_KINDS.includes(kind))
            throw new Error("captain.rollbackPrompt: invalid kind");
          const captainId = service.identity()?.agentId;
          const subjectId = args.string("subjectId");
          if (kind === "base" || subjectId === captainId)
            throw new Error(
              "the base prompt and Captain's own prompt require an approved Captain operation",
            );
          return {
            result: {
              version: service.rollbackPrompt({
                subjectId,
                kind,
                version: args.integer("version"),
                actorAgentId: null,
              }),
            },
          };
        }),

        wire.handle("captain", "setSetting", (call) => {
          const args = new Args(call);
          const key = args.string("key") as keyof CaptainSettingsView;
          const raw = (call.args as { value?: unknown }).value;
          return {
            result: {
              setting: service.setSetting(key, raw, null),
            },
          };
        }),

        wire.handle("captain", "settingHistory", (call) => {
          const args = new Args(call);
          const key = args.string("key") as keyof CaptainSettingsView;
          return {
            result: {
              versions: service.settingHistory(
                key,
                args.optionalInteger("limit"),
              ),
            },
          };
        }),

        wire.handle("captain", "rollbackSetting", (call) => {
          const args = new Args(call);
          const key = args.string("key") as keyof CaptainSettingsView;
          return {
            result: {
              setting: service.rollbackSetting(
                key,
                args.integer("version"),
                null,
              ),
            },
          };
        }),

        wire.handle("captain", "markNotificationRead", (call) => {
          const notificationId = new Args(call).string("notificationId");
          if (!service.store.markNotificationRead(notificationId))
            throw new Error("no such notification");
          deps.changed();
          return { result: { notificationId } };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
