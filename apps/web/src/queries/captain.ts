import type {
  CaptainArgs,
  CaptainIdentityView,
  CaptainResults,
  CaptainSections,
} from "@eta/client-contracts";
import { useTarget, useWireMutation } from "@/queries/wire";

const EMPTY: CaptainSections = {
  identity: null,
  assignments: [],
  operations: [],
  notifications: [],
  memoryPauses: [],
  settings: {
    supervisorEnabled: true,
    patrolMinutes: 30,
    inboxMinutes: 5,
    stuckMinutes: 30,
    retryLimit: 5,
    loopRounds: 5,
  },
};

export function useCaptain(): CaptainSections {
  const target = useTarget("captain");
  return {
    identity:
      (target?.sections.identity as CaptainIdentityView | null | undefined) ??
      null,
    assignments:
      (target?.sections.assignments as CaptainSections["assignments"]) ?? [],
    operations:
      (target?.sections.operations as CaptainSections["operations"]) ?? [],
    notifications:
      (target?.sections.notifications as CaptainSections["notifications"]) ??
      [],
    memoryPauses:
      (target?.sections.memoryPauses as CaptainSections["memoryPauses"]) ??
      EMPTY.memoryPauses,
    settings:
      (target?.sections.settings as CaptainSections["settings"]) ??
      EMPTY.settings,
  };
}

export function useCaptainActions() {
  return {
    ensure: useWireMutation<CaptainArgs["ensure"], CaptainResults["ensure"]>(
      "captain",
      "ensure",
    ),
    direct: useWireMutation<CaptainArgs["direct"], CaptainResults["direct"]>(
      "captain",
      "direct",
    ),
    setModel: useWireMutation<
      CaptainArgs["setModel"],
      CaptainResults["setModel"]
    >("captain", "setModel"),
    assign: useWireMutation<CaptainArgs["assign"], CaptainResults["assign"]>(
      "captain",
      "assign",
    ),
    decideOperation: useWireMutation<
      CaptainArgs["decideOperation"],
      CaptainResults["decideOperation"]
    >("captain", "decideOperation"),
    setMemoryPaused: useWireMutation<
      CaptainArgs["setMemoryPaused"],
      CaptainResults["setMemoryPaused"]
    >("captain", "setMemoryPaused"),
    setSetting: useWireMutation<
      CaptainArgs["setSetting"],
      CaptainResults["setSetting"]
    >("captain", "setSetting"),
    settingHistory: useWireMutation<
      CaptainArgs["settingHistory"],
      CaptainResults["settingHistory"]
    >("captain", "settingHistory"),
    rollbackSetting: useWireMutation<
      CaptainArgs["rollbackSetting"],
      CaptainResults["rollbackSetting"]
    >("captain", "rollbackSetting"),
    markNotificationRead: useWireMutation<
      CaptainArgs["markNotificationRead"],
      CaptainResults["markNotificationRead"]
    >("captain", "markNotificationRead"),
  };
}
