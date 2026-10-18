/**
 * The `settings` plugin: what a *new* session starts as, on the wire.
 *
 * One eager target with one section — the defaults as they stand — and two actions: read them
 * back (`reload`) and change them (`save`). Deliberately no more: settings are a starting point,
 * so there is nothing to "apply" and nothing to restart. A change reaches the next session the
 * manager creates, and sessions that already exist keep what they were created with (see
 * `settings.ts` for why that is the rule rather than an omission).
 */
import type { Settings, SettingsStore } from "../settings";
import type { WireService } from "../wire-service";

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const SETTINGS_ACTIONS = ["save", "reload"] as const;

export interface SettingsPluginOptions {
  store: SettingsStore;
  /** Diagnostics. */
  warn?: ((message: string) => void) | undefined;
}

/**
 * The defaults as one state section. There is no revision to carry here (unlike the providers
 * config, nothing else edits this file), so the section's revision is a signature of its own
 * content — which is exactly what the state sender compares to decide whether a frame is owed.
 */
function section(settings: Settings): {
  sections: Record<string, unknown>;
  revisions: Record<string, string>;
} {
  return {
    sections: { settings },
    revisions: { settings: JSON.stringify(settings) },
  };
}

export function settingsPlugin(options: SettingsPluginOptions) {
  return {
    name: "settings",
    inject: ["wire"],
    apply(ctx: unknown): unknown {
      const context = ctx as {
        wire: WireService;
        effect(execute: () => () => unknown): unknown;
      };
      const wire = context.wire;
      return context.effect(() => {
        // The read is asynchronous and a state projector is not, so the last read is what the
        // section shows — with an empty snapshot until the first one lands (a fabricated
        // default would be a value the user could act on and be surprised by).
        let latest: Settings | undefined;
        void options.store.read().then(
          (settings) => {
            latest = settings;
            wire.pushNow("settings");
          },
          (error: unknown) =>
            options.warn?.(`[eta-server] settings: ${String(error)}`),
        );

        const registrations: (() => void)[] = [
          wire.stateOf("settings", {
            eager: true,
            project: () =>
              latest === undefined
                ? { sections: {}, revisions: {} }
                : section(latest),
          }),
          wire.handle("settings", "save", async (call) => {
            const patch = (call.args ?? {}) as Record<string, unknown>;
            latest = await options.store.save(patch);
            wire.pushNow("settings");
            return { result: { settings: latest } };
          }),
          wire.handle("settings", "reload", async () => {
            // The file may have been edited by hand: forget the cached copy first, or this
            // answers with what this process already believed.
            options.store.invalidate();
            latest = await options.store.read();
            wire.pushNow("settings");
            return { result: { settings: latest } };
          }),
        ];

        return () => {
          for (const off of registrations.splice(0)) off();
        };
      });
    },
  };
}
