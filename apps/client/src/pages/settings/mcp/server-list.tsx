import type { McpServerView } from "@eta/client-contracts";
import type { Layout } from "../../../components";
import { Scroll, signal, View } from "nsh";
import {
  colors,
  Empty,
  grow,
  Header,
  Icon,
  Label,
  row,
} from "../../../components";
import { StatusDot } from "../../../components/status-dot";
import { uiText, useText } from "../../../i18n";
import { useHost } from "../../../services/host";

import { McpDetail } from "./server-detail";
import {
  McpPhoneHeader,
  serverStatus,
  statusTone,
  toolsDescription,
  transportDescription,
} from "./server-presentation";
function key(item: McpServerView) {
  return JSON.stringify([item.agentId, item.source, item.server]);
}

export function McpSettings(props: { layout: Layout; onBack: () => void }) {
  const host = useHost();
  const c = colors();
  const text = useText();
  const selected = signal("");
  const list = () => host.list<McpServerView>("mcp");
  const server = () => list().find((item) => key(item) === selected());
  const groups = () => {
    const sources = new Map<string, McpServerView[]>();
    for (const item of list()) {
      const key = JSON.stringify([item.agentId, item.source]);
      const items = sources.get(key) ?? [];
      items.push(item);
      sources.set(key, items);
    }
    return [...sources.entries()];
  };
  const phone = () => props.layout === "phone";
  return (
    <If
      when={server()}
      else={
        <>
          <If
            when={phone()}
            else={<Header title={text("mcpServers")} layout={props.layout} />}
          >
            <McpPhoneHeader title={text("settings")} onBack={props.onBack} />
          </If>
          <If
            when={list().length}
            else={<Empty title={uiText("noMcpServersConfigured")} />}
          >
            <Scroll style={grow} scrollbar={false}>
              <View
                style={{
                  padding: 16,
                  gap: 4,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <If when={phone()}>
                  <Label weight={600}>{text("mcpServers")}</Label>
                </If>
                <Label size={12} line={16} tone="muted">
                  {uiText("mcpServersHint")}
                </Label>
              </View>
              <Each of={groups()} key={([key]) => key}>
                {(group) => (
                  <View>
                    <View
                      style={{
                        ...row,
                        gap: 8,
                        paddingHorizontal: 16,
                        height: 39,
                        borderBottomWidth: 1,
                        borderColor: c().border,
                      }}
                    >
                      <Label weight={600}>
                        {group()[1][0]?.source === "~/.eta/mcp.json"
                          ? uiText("mcpYourServers")
                          : group()[1][0]?.agentName}
                      </Label>
                      <Label size={12} tone="muted">
                        {group()[1][0]?.source}
                      </Label>
                    </View>
                    <Each of={group()[1]} key={key}>
                      {(item) => (
                        <View
                          role="button"
                          accessibilityLabel={item().server}
                          hoverStyle={{ backgroundColor: c().selected }}
                          style={{
                            ...row,
                            minHeight: 72,
                            gap: 10,
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderBottomWidth: 1,
                            borderColor: c().border,
                            cursor: "pointer",
                          }}
                          onPress={() => selected.set(key(item()))}
                        >
                          <View style={{ flex: 1, gap: 2 }}>
                            <Label line={20} weight={500}>
                              {item().server}
                            </Label>
                            <View style={{ ...row, gap: 6 }}>
                              <StatusDot color={c()[statusTone(item())]} />
                              <Label size={12} line={16} tone="muted">
                                {serverStatus(item())}
                              </Label>
                            </View>
                            <Label size={12} line={16} tone="muted">
                              {[
                                transportDescription(item()),
                                item().auth !== "needs_login"
                                  ? toolsDescription(item().toolCount)
                                  : "",
                                item().auth === "signed_in"
                                  ? uiText("mcpSignedIn")
                                  : "",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </Label>
                          </View>
                          <Icon name="right" tone="muted" size={10} />
                        </View>
                      )}
                    </Each>
                  </View>
                )}
              </Each>
            </Scroll>
          </If>
        </>
      }
    >
      {(item) => (
        <McpDetail
          item={item}
          layout={props.layout}
          onBack={() => selected.set("")}
        />
      )}
    </If>
  );
}
