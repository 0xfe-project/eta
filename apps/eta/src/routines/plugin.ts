/**
 * The `routines` plugin: the register of what Captain runs on a schedule or external trigger, and
 * what to do with it.
 *
 * The list is eager (a client draws its routines from `hello`), with `status`, whether Captain is
 * on to run them. Each routine is a target of its own with its brief versions and its runs. The
 * clock, the trigger hub, and the runs are not here, and neither are the rules of a routine
 * (`service.ts`): this file is the surface in front of them. A run's handoff is in no section: it
 * is the next run's alone.
 */
import type { RoutineSummary, RoutineTrigger } from "@eta/client-contracts";
import type { RoutineRunner } from "./runner";
import type { Scheduler } from "./scheduler";
import type { RoutineService } from "./service";
import type { RoutineRecord, RoutineTriggerRecord } from "./store";
import type { TriggerHub } from "./triggers";
import type { ViewDeps } from "./views";
import type { WebhookTriggerProvider } from "./webhook-triggers";
import { Args, productPlugin, publish } from "../wire";
import {
  briefsOf,
  briefViewOf,
  feedbackViewOf,
  infoOf,
  listingOf,
  runsOf,
  summaryOf,
} from "./views";

export interface RoutinesDeps extends ViewDeps {
  service: RoutineService;
  runner: RoutineRunner;
  scheduler: Scheduler;
  triggers?: TriggerHub | undefined;
  webhook?: WebhookTriggerProvider | undefined;
  /** Say that a routine's state moved (and the list, always). */
  changed: (routineId: string) => void;
}

const MAX_FEEDBACK = 4_000;

const triggerInputOf = (record: RoutineTriggerRecord): RoutineTrigger => ({
  provider: record.provider,
  source: record.source,
  trigger: record.triggerSlug,
  accountId: record.accountId,
  config: record.config,
  mode: record.effectiveMode ?? record.requestedMode,
  pollingIntervalMinutes:
    record.pollingInterval ?? record.requestedPollingInterval,
});

export function routinesPlugin(deps: RoutinesDeps, applied: () => void) {
  const { store, service, runner, scheduler, triggers, webhook } = deps;

  const existing = (id: string): RoutineRecord => service.existing(id);
  const summary = (routine: RoutineRecord): RoutineSummary =>
    summaryOf(deps, routine);

  return productPlugin(
    "routines",
    (ctx) => {
      const { wire } = ctx;
      const details = new Map<string, () => void>();
      /** `routines.<id>`: registered for every routine there is and for each one made later. */
      const publishDetail = (id: string): void => {
        if (details.has(id)) return;
        const routine = (): RoutineRecord => existing(id);
        details.set(
          id,
          publish(wire, `routines.${id}`, {
            info: () => infoOf(deps, routine()),
            briefs: () => briefsOf(deps, id),
            runs: () => runsOf(deps, id),
          }),
        );
      };
      for (const routine of store.list()) publishDetail(routine.id);
      service.created = publishDetail;
      service.removed = (id) => {
        details.get(id)?.();
        details.delete(id);
      };

      runner.attach(ctx.sessions);
      scheduler.start();
      triggers?.start();

      const offs = [
        publish(
          wire,
          "routines",
          {
            list: () => store.list().map(summary),
            status: () => runner.status(),
          },
          { eager: true },
        ),

        wire.handle("routines", "create", async (call) => {
          const args = new Args(call);
          const raw = (call.args ?? {}) as Record<string, unknown>;
          const routine = await service.create({
            name: args.string("name"),
            brief: args.string("brief"),
            schedule: raw.schedule === undefined ? null : raw.schedule,
            ...(raw.trigger === undefined ? {} : { trigger: raw.trigger }),
            timezone: args.string("timezone"),
            enabled: args.optionalBoolean("enabled") ?? true,
          });
          return { result: { routine: summary(routine) } };
        }),

        wire.handle("routines", "update", async (call) => {
          const args = new Args(call);
          const raw = (call.args ?? {}) as Record<string, unknown>;
          const name = args.optionalString("name");
          const brief = args.optionalString("brief");
          const timezone = args.optionalString("timezone");
          const enabled = args.optionalBoolean("enabled");
          const routine = await service.update(args.string("routineId"), {
            ...(name === undefined ? {} : { name }),
            ...(brief === undefined ? {} : { brief }),
            ...(timezone === undefined ? {} : { timezone }),
            ...(raw.schedule === undefined ? {} : { schedule: raw.schedule }),
            ...(raw.trigger === undefined ? {} : { trigger: raw.trigger }),
            ...(enabled === undefined ? {} : { enabled }),
          });
          return { result: { routine: summary(routine) } };
        }),

        wire.handle("routines", "delete", async (call) => {
          const id = new Args(call).string("routineId");
          await service.remove(id);
          return { result: { routineId: id } };
        }),

        wire.handle("routines", "run", (call) => {
          const routine = existing(new Args(call).string("routineId"));
          if (!runner.status().captainOn)
            throw new Error(
              "Captain is off, so routines do not run. Turn Captain on to run it.",
            );
          const run = runner.start(routine.id, "user");
          if (run === undefined)
            throw new Error(
              store.runningRun(routine.id) === undefined
                ? `${routine.name} cannot be run right now`
                : `${routine.name} is already running`,
            );
          return {
            result: {
              routine: summary(existing(routine.id)),
              run: listingOf(run),
            },
          };
        }),

        wire.handle("routines", "seen", (call) => {
          const routine = existing(new Args(call).string("routineId"));
          store.markSeen(routine.id);
          deps.changed(routine.id);
          return { result: { routine: summary(routine) } };
        }),

        wire.handle("routines", "feedback", (call) => {
          const args = new Args(call);
          const routine = existing(args.string("routineId"));
          const run = store.run(args.string("runId"));
          if (run === undefined || run.routineId !== routine.id)
            throw new Error("no such run");
          if (run.status === "running")
            throw new Error("the run has not finished yet");
          const text = args.string("text").trim();
          if (text.length > MAX_FEEDBACK)
            throw new Error(
              `feedback is longer than ${MAX_FEEDBACK} characters`,
            );
          const feedback = store.addFeedback(run.id, text);
          // The revision is a model call: it happens after this returns, and the page sees the
          // routine as revising until it ends.
          runner.reviseSoon(routine.id);
          deps.changed(routine.id);
          return { result: { feedback: feedbackViewOf(feedback) } };
        }),

        wire.handle("routines", "restoreBrief", (call) => {
          const args = new Args(call);
          const routine = existing(args.string("routineId"));
          const brief = store.restoreBrief(routine.id, args.integer("version"));
          if (brief === undefined) throw new Error("no such brief version");
          deps.changed(routine.id);
          return {
            result: { brief: briefViewOf(deps, brief) },
          };
        }),

        wire.handle(
          "routines",
          "triggers",
          async (call) => {
            const args = new Args(call);
            const provider = args.optionalString("provider");
            const source = args.optionalString("source");
            const query = args.optionalString("query");
            const refresh = args.optionalBoolean("refresh");
            return {
              result: await service.triggers({
                ...(provider === undefined ? {} : { provider }),
                ...(source === undefined ? {} : { source }),
                ...(query === undefined ? {} : { query }),
                ...(refresh === undefined ? {} : { refresh }),
              }),
            };
          },
          { unordered: true },
        ),

        wire.handle(
          "routines",
          "webhookInfo",
          (call) => {
            const routine = existing(new Args(call).string("routineId"));
            const trigger = store.trigger(routine.id);
            if (trigger === undefined || trigger.provider !== "webhook")
              throw new Error(
                "routine does not use an inbound webhook trigger",
              );
            if (webhook === undefined)
              throw new Error("webhook trigger provider is not available");
            return {
              result: webhook.info(routine.id, triggerInputOf(trigger)),
            };
          },
          { unordered: true },
        ),

        wire.handle("routines", "webhookRotate", (call) => {
          const args = new Args(call);
          const routine = existing(args.string("routineId"));
          const trigger = store.trigger(routine.id);
          if (trigger === undefined || trigger.provider !== "webhook")
            throw new Error("routine does not use an inbound webhook trigger");
          if (webhook === undefined)
            throw new Error("webhook trigger provider is not available");
          const rotateToken = args.optionalBoolean("rotateToken");
          const rotateSecret = args.optionalBoolean("rotateSecret");
          return {
            result: webhook.rotate(routine.id, triggerInputOf(trigger), {
              ...(rotateToken === undefined ? {} : { rotateToken }),
              ...(rotateSecret === undefined ? {} : { rotateSecret }),
            }),
          };
        }),

        wire.handle("routines", "webhookSetSecret", (call) => {
          const args = new Args(call);
          const routine = existing(args.string("routineId"));
          const secret = args.string("secret");
          const trigger = store.trigger(routine.id);
          if (trigger === undefined || trigger.provider !== "webhook")
            throw new Error("routine does not use an inbound webhook trigger");
          if (webhook === undefined)
            throw new Error("webhook trigger provider is not available");
          return {
            result: webhook.setSecret(
              routine.id,
              triggerInputOf(trigger),
              secret,
            ),
          };
        }),
      ];
      return async () => {
        scheduler.stop();
        await triggers?.stop();
        service.created = undefined;
        service.removed = undefined;
        for (const off of offs.splice(0)) off();
        for (const off of details.values()) off();
        details.clear();
        // The plugin is going: what is running is told to stop, and the dispose waits for it.
        await runner.detach();
      };
    },
    applied,
  );
}
