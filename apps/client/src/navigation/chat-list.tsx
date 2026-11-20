import type { Layout } from "../components";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Field,
  grow,
  Header,
  Icon,
  Label,
  row,
  sizes,
} from "../components";
import { useText } from "../i18n";
import { useHost } from "../services/host";
import { AgentRow, GroupRow } from "./chat-list-rows";
import { RailButton } from "./rail-controls";

export interface ChatListProps {
  layout: Layout;
  selected: string;
  onConversation: (id: string) => void;
  onAgent: (id: string) => void;
  onCreate: () => void;
  onCreateAgent: () => void;
}

export function ChatList(
  props: ChatListProps & { width?: number; collapsed?: boolean },
) {
  const text = useText();
  const c = colors();
  const host = useHost();
  const expanded = signal(true);
  const searching = signal(false);
  const query = signal("");
  const phone = () => props.layout === "phone";
  const groups = () =>
    host
      .conversations()
      .filter(
        (group) =>
          !group.archived &&
          group.kind === "group" &&
          group.name.toLowerCase().includes(query().trim().toLowerCase()),
      )
      .sort(
        (a, b) =>
          Math.max(b.lastMessageAt ?? 0, b.updatedAt) -
          Math.max(a.lastMessageAt ?? 0, a.updatedAt),
      );
  const listHeader = {
    ...row,
    justifyContent: "space-between",
    height: 32,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    flexShrink: 0,
  } as const;
  const toggleAgents = () => expanded.set(!expanded());
  return (
    <View
      style={{
        ...(phone() || props.layout === "desktop"
          ? grow
          : {
              width: props.width ?? sizes.tabletList,
              height: "100%",
              flexShrink: 0,
            }),
        backgroundColor: phone() ? c().canvas : c().surface,
        borderRightWidth: props.layout === "tablet" ? 1 : 0,
        borderColor: c().border,
      }}
    >
      <If when={props.layout !== "desktop"}>
        <Header title={text("chat")} layout={props.layout} inset={12}>
          <View style={{ flex: 1 }} />
          <If when={phone()}>
            <Button
              label={text("searchConversations")}
              icon="search"
              iconOnly
              tone="ghost"
              onPress={() => searching.set(!searching())}
            />
          </If>
          <Button
            label={text("newConversation")}
            icon="plus"
            iconOnly
            tone={phone() ? "ghost" : "plain"}
            onPress={() => props.onCreate()}
          />
        </Header>
      </If>
      <If when={searching()}>
        <Field
          label={text("searchConversations")}
          value={query()}
          onChange={query.set}
        />
      </If>
      <View
        style={{
          ...(phone() ? { flexShrink: 0 } : listHeader),
          ...(!phone() ? { borderColor: c().border } : {}),
          ...(props.collapsed
            ? { justifyContent: "center", paddingHorizontal: 0 }
            : {}),
        }}
      >
        <If when={!phone()}>
          <If
            when={props.collapsed}
            else={
              <>
                <Caption text={text("groups")} />
                <Button
                  label={text("newGroup")}
                  icon="plus"
                  iconOnly
                  tone="ghost"
                  size={22}
                  onPress={() => props.onCreate()}
                  style={{ backgroundColor: "transparent" }}
                />
              </>
            }
          >
            <RailButton
              label={text("newGroup")}
              icon="plus"
              onPress={props.onCreate}
            />
          </If>
        </If>
      </View>
      <Scroll style={grow} scrollbar={false}>
        <If when={phone()}>
          <View
            style={{
              height: 36,
              borderBottomWidth: 1,
              borderColor: c().border,
              paddingHorizontal: 16,
              justifyContent: "center",
            }}
          >
            <Caption text={text("groups")} />
          </View>
        </If>
        <Each of={groups()} key={(group) => group.id}>
          {(group) => (
            <GroupRow
              group={group()}
              layout={props.layout}
              collapsed={props.collapsed}
              selected={props.selected === group().id}
              onPress={() => props.onConversation(group().id)}
            />
          )}
        </Each>
        <If when={!props.collapsed && groups().length === 0}>
          <Label size={12} tone="muted" style={{ padding: 14 }}>
            {text(query() ? "noMatchingConversations" : "noConversations")}
          </Label>
        </If>
        <If when={phone()}>
          <View
            style={{
              height: 44,
              borderBottomWidth: 1,
              borderColor: c().border,
              paddingHorizontal: 16,
              justifyContent: "center",
            }}
          >
            <Caption text={text("agents")} />
          </View>
          <Each of={host.people()} key={(agent) => agent.id}>
            {(agent) => (
              <AgentRow
                agent={agent()}
                phone
                onPress={() => props.onAgent(agent().id)}
              />
            )}
          </Each>
        </If>
      </Scroll>
      <If when={!phone()}>
        <View
          style={{
            ...listHeader,
            height: props.collapsed ? 29 : 35,
            borderTopWidth: 1,
            borderColor: c().border,
            ...(props.collapsed
              ? { paddingHorizontal: 0, justifyContent: "center" }
              : {}),
          }}
        >
          <If
            when={props.collapsed}
            else={
              <>
                <View
                  role="button"
                  accessibilityLabel={text("toggleAgents")}
                  accessibilityState={{ expanded: expanded() }}
                  onPress={toggleAgents}
                  style={{ ...row, gap: 6, cursor: "pointer" }}
                >
                  <Icon
                    name={expanded() ? "down" : "right"}
                    size={10}
                    tone="muted"
                  />
                  <Caption text={text("agents")} />
                </View>
                <Button
                  label={text("newAgent")}
                  icon="plus"
                  iconOnly
                  tone="ghost"
                  size={22}
                  onPress={() => props.onCreateAgent()}
                  style={{ backgroundColor: "transparent" }}
                />
              </>
            }
          >
            <RailButton
              label={text("toggleAgents")}
              icon={expanded() ? "down" : "right"}
              size={24}
              expanded={expanded()}
              onPress={toggleAgents}
            />
            <RailButton
              label={text("newAgent")}
              icon="plus"
              size={24}
              onPress={props.onCreateAgent}
            />
          </If>
        </View>
        <If when={expanded()}>
          <View
            style={{
              maxHeight: props.collapsed ? 240 : 230,
              flexShrink: props.collapsed ? 1 : 0,
            }}
          >
            <Scroll scrollbar={false} style={{ flexGrow: 0, flexShrink: 1 }}>
              <Each of={host.people()} key={(agent) => agent.id}>
                {(agent) => (
                  <AgentRow
                    agent={agent()}
                    phone={false}
                    collapsed={props.collapsed}
                    onPress={() => props.onAgent(agent().id)}
                  />
                )}
              </Each>
            </Scroll>
          </View>
        </If>
      </If>
    </View>
  );
}
