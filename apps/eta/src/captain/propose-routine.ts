/**
 * Captain proposes a routine (`propose_routine`): the user says "every Monday morning, …" in a chat,
 * Captain turns it into a name, a brief, a schedule and a zone, and a card asks the user. Confirming
 * it makes the routine the way the routines page does (`RoutineService.create`), enabled.
 *
 * A routine is Captain's own work, so the card names no agent and no model, and asks for no rights:
 * where reports go and what may be done is written in the brief, and Captain does it with the tools
 * and the approvals it already has.
 */
import type {
  CaptainRoutineProposal,
  CaptainRoutineResult,
  RoutineSchedule,
  RoutineTrigger,
} from "@eta/client-contracts";
import type { RoutineFieldsInput, RoutineService } from "../routines/service";
import type { ProposalKind, ProposalOrigin } from "./proposals";
import { describeTrigger } from "../routines/prompts";
import { describeSchedule } from "../routines/schedule";

/** A routine proposal as it is stored, without where it was proposed. */
type RoutineProposal = Omit<CaptainRoutineProposal, keyof ProposalOrigin>;

function describeWhen(
  schedule: RoutineSchedule | null,
  trigger: RoutineTrigger | null,
): string {
  if (schedule !== null && trigger !== null) {
    return `${describeSchedule(schedule)} + ${describeTrigger(trigger)}`;
  }
  if (schedule !== null) return describeSchedule(schedule);
  if (trigger !== null) return `on ${describeTrigger(trigger)}`;
  return "";
}

export function routineProposals(deps: {
  routines: () => RoutineService;
}): ProposalKind<RoutineFieldsInput, RoutineProposal, CaptainRoutineResult> {
  return {
    kind: "create_routine",
    noun: "routine",

    /** Refused: what the routines page refuses (no name or brief, a zone or schedule/trigger that cannot run). */
    async check(input) {
      const fields = deps.routines().check(input);
      return {
        name: fields.name,
        brief: fields.brief,
        schedule: fields.schedule,
        ...(fields.trigger === null ? {} : { trigger: fields.trigger }),
        timezone: fields.timezone,
        scheduleText: describeWhen(fields.schedule, fields.trigger),
      };
    },

    again: (proposal) => ({
      name: proposal.name,
      brief: proposal.brief,
      schedule: proposal.schedule,
      ...(proposal.trigger === undefined ? {} : { trigger: proposal.trigger }),
      timezone: proposal.timezone,
    }),

    async apply(proposal) {
      const routine = await deps.routines().create({
        name: proposal.name,
        brief: proposal.brief,
        schedule: proposal.schedule,
        ...(proposal.trigger === undefined
          ? {}
          : { trigger: proposal.trigger }),
        timezone: proposal.timezone,
        enabled: true,
      });
      return { routineId: routine.id, name: routine.name };
    },

    created: (proposal, result) => {
      const when =
        proposal.trigger === undefined || proposal.trigger === null
          ? "It is on the clock now."
          : proposal.schedule !== null
            ? "It is on the clock and subscribed to its event trigger now."
            : "It is subscribed to its event trigger now.";
      return [
        `routineId: ${result.routineId}`,
        `${when} Each run is a new session of yours, given its brief; list_routines and update_routine change it.`,
      ];
    },
  };
}
