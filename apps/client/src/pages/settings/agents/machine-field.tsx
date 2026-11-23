import type { AgentForm } from "./form";
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
import { weight } from "../../../components/tokens";
import { localizedText, uiText } from "../../../i18n";

import { EditorRow } from "./editor-row";

export function MachineField(props: { form: AgentForm }) {
  const { phoneEditor, machineId, machines, creating, stacked, selectStyle } =
    props.form;
  const c = colors();
  // The editor lists the choices as rows (the design's Runs on block); the creator keeps a select.
  if (!creating) {
    const items = () => [
      {
        id: null,
        title: localizedText("Follow the project", "随项目选择"),
        detail: localizedText(
          "Runs on the machine the project is on",
          "在项目所在的机器上运行",
        ),
        online: false,
      },
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
            paddingHorizontal: 16,
            height: 44,
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
                size={16}
                style={{
                  ...row,
                  minHeight: 55,
                  paddingHorizontal: 22,
                  gap: 16,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  cursor: "pointer",
                }}
              >
                <View style={{ ...grow, gap: 2 }}>
                  <Label weight={weight.regular} lines={1}>
                    {item().title}
                  </Label>
                  <View style={{ ...row, gap: 5 }}>
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
        <If when={!phoneEditor()}>
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
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
            : uiText("followProject"))
        }
        triggerStyle={selectStyle()}
      >
        <ActionItem
          label={uiText("followProject")}
          checked={!machineId()}
          onSelect={() => machineId.set(null)}
        />
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
