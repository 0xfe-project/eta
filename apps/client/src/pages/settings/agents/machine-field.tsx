import type { AgentForm } from "./form";
import { isExternalRuntime } from "@eta/client-contracts";
import { View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  grow,
  Label,
  row,
} from "../../../components";
import { CheckControl } from "../../../components/check-control";
import { StatusDot } from "../../../components/status-dot";
import { control, icon, space, weight } from "../../../components/tokens";
import { localizedText, uiText } from "../../../i18n";

import { EditorRow } from "./editor-row";

/** A machine to pick: its name and the line under it. */
const optionRow = 56;

export function MachineField(props: { form: AgentForm }) {
  const {
    phoneEditor,
    machineId,
    machines,
    creating,
    stacked,
    selectStyle,
    runtime,
  } = props.form;
  const external = () => isExternalRuntime(runtime());
  const c = colors();
  // The editor lists the choices as rows (the design's Runs on block); the creator keeps a select.
  if (!creating) {
    const items = () => [
      ...(external()
        ? []
        : [
            {
              id: null,
              title: localizedText("Follow the project", "随项目选择"),
              detail: localizedText(
                "Runs on the machine the project is on",
                "在项目所在的机器上运行",
              ),
              online: false,
            },
          ]),
      ...machines().map((item) => ({
        id: item.id,
        title:
          item.kind === "primary"
            ? localizedText(`${item.name} (primary)`, `${item.name}（主机）`)
            : item.name,
        detail:
          item.status === "online"
            ? localizedText("Online", "在线")
            : localizedText("Offline", "离线"),
        online: item.status === "online",
      })),
    ];
    return (
      <View role="radiogroup" accessibilityLabel={uiText("runsOn")}>
        <View
          style={{
            paddingHorizontal: space[16],
            height: control.touch,
            justifyContent: "center",
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label weight={weight.strong}>{uiText("runsOn")}</Label>
        </View>
        <Each of={items()} key={(item) => item.id ?? "project"}>
          {(item) => {
            const picked = () => machineId() === item().id;
            return (
              <CheckControl
                role="radio"
                label={item().title}
                checked={picked()}
                onChange={() => machineId.set(item().id)}
                size={icon.md}
                style={{
                  ...row,
                  minHeight: optionRow,
                  paddingHorizontal: space[24],
                  gap: space[16],
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  cursor: "pointer",
                }}
              >
                <View style={{ ...grow, gap: space[2] }}>
                  <Label weight={weight.regular} lines={1}>
                    {item().title}
                  </Label>
                  <View style={{ ...row, gap: space[4] }}>
                    <If when={item().id}>
                      <StatusDot
                        color={item().online ? c().green : c().strong}
                      />
                    </If>
                    <Label variant="small" tone="muted">
                      {item().detail}
                    </Label>
                  </View>
                </View>
              </CheckControl>
            );
          }}
        </Each>
        <If when={!phoneEditor() && machineId() === null}>
          <View
            style={{
              paddingHorizontal: space[16],
              paddingVertical: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label variant="small" tone="muted">
              {localizedText(
                "Runtimes are listed from the primary for now, and may differ if the project is on another machine.",
                "运行时目前按主机器列出，项目在其他机器上时可能不同。",
              )}
            </Label>
          </View>
        </If>
      </View>
    );
  }
  return (
    <EditorRow label={uiText("runsOn")} stack={stacked()}>
      <ActionMenu
        label={uiText("runsOn")}
        value={
          machines().find((item) => item.id === machineId())?.name ??
          (machineId()
            ? localizedText("Unavailable machine", "机器不可用")
            : external()
              ? localizedText("Choose a machine", "选择机器")
              : uiText("followProject"))
        }
        triggerStyle={selectStyle()}
      >
        <If when={!external()}>
          <ActionItem
            label={uiText("followProject")}
            checked={!machineId()}
            onSelect={() => machineId.set(null)}
          />
        </If>
        <Each of={machines()} key={(item) => item.id}>
          {(item) => (
            <ActionItem
              label={item().name}
              checked={machineId() === item().id}
              onSelect={() => machineId.set(item().id)}
            />
          )}
        </Each>
      </ActionMenu>
    </EditorRow>
  );
}
