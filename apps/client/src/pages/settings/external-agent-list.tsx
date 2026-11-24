import type {
  AcpAgentView,
  AcpMachineList,
  MachineView,
} from "@eta/client-contracts";
import { View } from "nsh";
import { ActionItem, colors, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { acpStatus } from "./external-agent";
import { EntityRow, LetterBox, SectionHeader, WarningLine } from "./section";

/** The external agents of every machine, under one header per machine. */
export function ExternalAgentList(props: {
  lists: Record<string, AcpMachineList>;
  machines: MachineView[];
  onAgent: (machineId: string, agent: AcpAgentView) => void;
  /** Opens the edit form; absent when this client may not change agents. */
  onEdit?: (machineId: string, agent: AcpAgentView) => void;
}) {
  const c = colors();
  const groups = () => {
    const listed = Object.entries(props.lists)
      .filter(([, list]) => list.agents?.length)
      .map(([id, list]) => {
        const machine = props.machines.find((item) => item.id === id);
        return {
          id,
          name: machine?.name ?? id,
          primary: machine?.kind === "primary",
          offline: false,
          agents: list.agents ?? [],
        };
      });
    const offline = props.machines
      .filter(
        (machine) =>
          machine.status === "offline" &&
          !listed.some((group) => group.id === machine.id),
      )
      .map((machine) => ({
        id: machine.id,
        name: machine.name,
        primary: machine.kind === "primary",
        offline: true,
        agents: [] as AcpAgentView[],
      }));
    return [...listed, ...offline];
  };
  const statusColor = (status: AcpAgentView["status"]) =>
    status === "available"
      ? c().green
      : status === "error"
        ? c().red
        : c().warning;
  const groupMeta = (primary: boolean, count: number) =>
    [
      primary && uiText("externalAgentPrimary"),
      uiText(count === 1 ? "externalAgentOne" : "externalAgentCount", {
        count,
      }),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <Each of={groups()} key={(group) => group.id}>
      {(group) => (
        <If
          when={!group().offline}
          else={
            <>
              <SectionHeader title={group().name} muted />
              <View
                style={{
                  ...row,
                  gap: space[8],
                  paddingHorizontal: space[16],
                  paddingVertical: space[8],
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <StatusDot color={c().strong} />
                <Label variant="small" tone="muted">
                  {uiText("externalAgentsOffline", {
                    name: group().name,
                  })}
                </Label>
              </View>
            </>
          }
        >
          <SectionHeader
            title={group().name}
            count={groupMeta(group().primary, group().agents.length)}
          />
          <Each of={group().agents} key={(agent) => agent.id}>
            {(agent) => (
              <EntityRow
                title={agent().label}
                leading={<LetterBox name={agent().label} />}
                meta={
                  <>
                    <Label variant="small" tone="muted">
                      {[agent().command, ...agent().args].join(" ")}
                    </Label>
                    <If when={agent().status === "unauthenticated"}>
                      <WarningLine
                        outline
                        text={uiText("signInToOnThenChoose", {
                          label: agent().label,
                          machineName: group().name,
                        })}
                      />
                    </If>
                  </>
                }
                status={{
                  label: uiText(acpStatus[agent().status]),
                  color: statusColor(agent().status),
                }}
                menuLabel={agent().label}
                menu={
                  <>
                    <ActionItem
                      label={uiText("settingsDetails")}
                      onSelect={() => props.onAgent(group().id, agent())}
                    />
                    <If when={props.onEdit}>
                      {(edit) => (
                        <ActionItem
                          label={uiText("settingsEdit")}
                          onSelect={() => edit()(group().id, agent())}
                        />
                      )}
                    </If>
                  </>
                }
                onPress={() => props.onAgent(group().id, agent())}
              />
            )}
          </Each>
        </If>
      )}
    </Each>
  );
}
