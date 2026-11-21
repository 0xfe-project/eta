import type { McpServerView } from "@eta/client-contracts";
import type { Layout } from "../../../components";
import { Scroll, signal } from "nsh";
import { ActionItem, colors, Empty, grow, Icon } from "../../../components";
import { uiText, useText } from "../../../i18n";
import { useHost } from "../../../services/host";

import { emptyStyle, EntityRow, SectionHeader } from "../section";
import { McpDetail } from "./server-detail";
import {
  McpPhoneHeader,
  serverStatus,
  statusTone,
  toolsDescription,
  transportName,
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
    const agents = new Map<string, McpServerView[]>();
    for (const item of list()) {
      const items = agents.get(item.agentId) ?? [];
      items.push(item);
      agents.set(item.agentId, items);
    }
    return [...agents.entries()];
  };
  const meta = (item: McpServerView) =>
    item.overriddenBy
      ? uiText("mcpOverriddenRow", { source: item.overriddenBy.source })
      : [
          item.source === ".mcp.json"
            ? uiText("mcpProjectSource")
            : item.source,
          transportName(item),
          toolsDescription(item.toolCount),
          item.auth === "needs_login" ? uiText("mcpNotSignedIn") : "",
        ]
          .filter(Boolean)
          .join(" · ");
  const phone = () => props.layout === "phone";
  return (
    <If
      when={server()}
      else={
        <>
          <If when={phone()}>
            <McpPhoneHeader title={text("settings")} onBack={props.onBack} />
          </If>
          <SectionHeader
            title={text("mcpServers")}
            count={list().length || undefined}
            description={uiText("mcpServersHint")}
          />
          <If
            when={list().length}
            else={
              <Empty
                icon="plug"
                iconSize={24}
                title={uiText("mcpEmptyTitle")}
                titleWeight={500}
                description={uiText("mcpEmptyHint")}
                descriptionWidth={320}
                style={emptyStyle}
              />
            }
          >
            <Scroll style={grow} scrollbar={false}>
              <Each of={groups()} key={([agentId]) => agentId}>
                {(group) => (
                  <>
                    <SectionHeader
                      title={group()[1][0]?.agentName ?? ""}
                      count={group()[1].length}
                    />
                    <Each of={group()[1]} key={key}>
                      {(item) => (
                        <EntityRow
                          title={item().server}
                          titleTone={item().overriddenBy ? "muted" : "ink"}
                          strike={!!item().overriddenBy}
                          leading={
                            <Icon name="plugins" size={16} tone="muted" />
                          }
                          meta={meta(item())}
                          status={
                            item().overriddenBy
                              ? undefined
                              : {
                                  label: serverStatus(item()),
                                  color: c()[statusTone(item())],
                                }
                          }
                          menuLabel={item().server}
                          menu={
                            item().overriddenBy ? undefined : (
                              <ActionItem
                                label={uiText("settingsDetails")}
                                onSelect={() => selected.set(key(item()))}
                              />
                            )
                          }
                          onPress={() => selected.set(key(item()))}
                        />
                      )}
                    </Each>
                  </>
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
