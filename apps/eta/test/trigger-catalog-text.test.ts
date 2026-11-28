/**
 * Guards the Chinese catalog text the client keeps for the built-in trigger providers
 * (`apps/client/src/i18n/messages/trigger-catalog.ts`): every source, trigger and config field
 * the providers list must have an entry whose English side is the backend's own text, and the
 * table must not keep entries the backend no longer lists.
 */
import type { TriggerCatalogItem } from "@eta/client-contracts";
import type { AgentRecord } from "../src/agents/store";
import type { ConversationRecord } from "../src/conversations/store";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { triggerCatalogText } from "../../client/src/i18n/messages/trigger-catalog";
import { openDatabase } from "../src/db";
import {
  EtaEventBus,
  EtaEventsTriggerProvider,
} from "../src/routines/eta-events-triggers";
import { FileWatchTriggerProvider } from "../src/routines/file-watch-triggers";
import { RssTriggerProvider } from "../src/routines/rss-triggers";
import { WebMonitorTriggerProvider } from "../src/routines/web-monitor-triggers";
import { WebhookTriggerProvider } from "../src/routines/webhook-triggers";
import { SettingStore } from "../src/settings/store";

function makeMemorySettings(): SettingStore {
  const db = openDatabase(":memory:");
  db.exec(
    "CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  return new SettingStore(db);
}

const warn = () => undefined;

async function builtInCatalog(): Promise<TriggerCatalogItem[]> {
  const providers = [
    new WebhookTriggerProvider({
      settings: makeMemorySettings(),
      secretKey: randomBytes(32),
      warn,
    }),
    new WebMonitorTriggerProvider({
      settings: makeMemorySettings(),
      timer: false,
      warn,
    }),
    new FileWatchTriggerProvider({
      settings: makeMemorySettings(),
      timer: false,
      watch: false,
      warn,
    }),
    new RssTriggerProvider({
      settings: makeMemorySettings(),
      timer: false,
      warn,
    }),
    new EtaEventsTriggerProvider({
      bus: new EtaEventBus(),
      conversations: {
        ofKind: (kind) =>
          [
            { id: "g1", kind, name: "Dev Group", archived: false },
          ] as ConversationRecord[],
      },
      agents: {
        list: () =>
          [{ id: "a1", name: "Forge", systemRole: null }] as AgentRecord[],
      },
      warn,
    }),
  ];
  const items: TriggerCatalogItem[] = [];
  try {
    for (const provider of providers)
      items.push(...(await provider.listTriggers()));
  } finally {
    for (const provider of providers) await provider.stop?.();
  }
  return items;
}

describe("built-in trigger catalog Chinese text", () => {
  it("has an entry for every provider, source, trigger and config field", async () => {
    const items = await builtInCatalog();
    expect(new Set(items.map((item) => item.provider))).toEqual(
      new Set(["webhook", "web-monitor", "file-watch", "rss", "eta-events"]),
    );
    for (const item of items) {
      const where = `${item.provider}/${item.source}/${item.trigger}`;
      const provider = triggerCatalogText[item.provider];
      expect(provider, `provider ${item.provider}`).toBeDefined();
      expect(provider!.sources[item.source]?.[0], `source of ${where}`).toBe(
        item.sourceName,
      );
      const trigger = provider!.triggers[item.trigger];
      expect(trigger, `trigger ${where}`).toBeDefined();
      expect(trigger!.name[0], `name of ${where}`).toBe(item.name);
      expect(trigger!.description[0], `description of ${where}`).toBe(
        item.description,
      );

      const properties = (item.configSchema.properties ?? {}) as Record<
        string,
        {
          title?: string;
          description?: string;
          enum?: unknown[];
          enumNames?: string[];
          items?: { enum?: unknown[] };
        }
      >;
      for (const [key, property] of Object.entries(properties)) {
        const field = trigger!.fields[key];
        expect(field, `field ${key} of ${where}`).toBeDefined();
        expect(field!.title[0], `title of ${key} in ${where}`).toBe(
          property.title,
        );
        expect(field!.description[0], `description of ${key} in ${where}`).toBe(
          property.description,
        );
        for (const value of property.items?.enum ?? []) {
          expect(
            field!.options?.[String(value)],
            `option ${String(value)} of ${key} in ${where}`,
          ).toBeDefined();
        }
        for (const [index, name] of (property.enumNames ?? []).entries()) {
          const option = field!.options?.[String(property.enum![index])];
          // The group, creator and assignee names are the user's own data and stay as given.
          if (option) expect(option[0]).toBe(name);
        }
      }
      expect(Object.keys(trigger!.fields).sort(), `fields of ${where}`).toEqual(
        Object.keys(properties).sort(),
      );
    }
  });

  it("has no entry the providers no longer list", async () => {
    const items = await builtInCatalog();
    for (const [providerId, provider] of Object.entries(triggerCatalogText)) {
      const listed = items.filter((item) => item.provider === providerId);
      expect(listed.length, `provider ${providerId}`).toBeGreaterThan(0);
      expect(Object.keys(provider.sources).sort()).toEqual(
        [...new Set(listed.map((item) => item.source))].sort(),
      );
      expect(Object.keys(provider.triggers).sort()).toEqual(
        listed.map((item) => item.trigger).sort(),
      );
    }
  });
});
