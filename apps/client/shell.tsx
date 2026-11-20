import type {
  AgentView,
  CaptainOperationView,
  ConversationSummary,
} from "@eta/client-contracts";
import type { JSX, ViewRef } from "nsh";
import type { IconName } from "./icons";
import type { Message } from "./locale";
import type { Layout } from "./ui";
import { blobatar } from "blobatar";
import { computed, Image, Scroll, signal, View } from "nsh";
import { CaptainContextRing } from "./captain-context-ring";
import { pickerTarget } from "./element-picker";
import { relativeTime, useHost } from "./host";
import { phoneTabPaths } from "./icons";
import { uiText, useText } from "./locale";
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
} from "./ui";

export type Page =
  | "chat"
  | "tasks"
  | "email"
  | "routines"
  | "plugins"
  | "settings"
  | "captain"
  | "pending"
  | "more"
  | "onboard";
type Destination = readonly [Page, Message, IconName];

const sections: Destination[] = [
  ["chat", "chat", "chat"],
  ["tasks", "tasks", "tasks"],
  ["email", "email", "email"],
  ["routines", "routines", "routines"],
  ["plugins", "plugins", "plugins"],
];

interface Navigation {
  page: Page;
  onNavigate: (page: Page) => void;
}

interface ChatListProps {
  layout: Layout;
  selected: string;
  onConversation: (id: string) => void;
  onAgent: (id: string) => void;
  onCreate: () => void;
  onCreateAgent: () => void;
}

export function AgentFace(props: { id?: string | null; size?: number }) {
  const size = () => props.size ?? 20;
  // Seed by ID as in the legacy clients so renames preserve an agent's face.
  const src = computed(
    () =>
      `data:image/svg+xml;utf8,${encodeURIComponent(blobatar(props.id ?? "agent"))}`,
  );
  return (
    <Image
      src={src()}
      fadeDuration={0}
      style={{ width: size(), height: size(), flexShrink: 0 }}
    />
  );
}

function CaptainFace(props: { size: number }) {
  const host = useHost();
  return <AgentFace id={host.captain()?.id ?? "Captain"} size={props.size} />;
}

function RailButton(props: {
  label: string;
  icon: IconName;
  size?: number;
  width?: number;
  iconSize?: number;
  selected?: boolean;
  expanded?: boolean;
  count?: number;
  attach?: (node: ViewRef | null) => void;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.count ? String(props.count) : undefined}
      accessibilityState={{
        selected: props.selected,
        expanded: props.expanded,
      }}
      ref={props.attach}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
      style={{
        width: props.width ?? props.size ?? 28,
        height: props.size ?? 28,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        backgroundColor: props.selected ? c().selected : "transparent",
        cursor: "pointer",
      }}
    >
      <View
        style={{
          width: props.iconSize ?? 14,
          height: props.iconSize ?? 14,
          position: "relative",
        }}
      >
        <Icon name={props.icon} size={props.iconSize} />
        <If when={(props.count ?? 0) > 0}>
          <View
            style={{
              position: "absolute",
              right: -5,
              top: -2,
              height: 13,
              minWidth: 10,
              paddingHorizontal: 2,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
            }}
          >
            <Label size={9} line={12}>
              {props.count}
            </Label>
          </View>
        </If>
      </View>
    </View>
  );
}

function RailEntry(props: {
  label: string;
  agent?: boolean;
  selected?: boolean;
  status?: "active" | "waiting" | "idle";
  onPress: () => void;
  children: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={{
        outlineWidth: 1,
        outlineColor: c().blue,
        outlineOffset: -1,
      }}
      style={{
        position: "relative",
        height: props.agent ? 48 : 41,
        flexShrink: 0,
        alignItems: "center",
        paddingTop: props.agent ? 6 : 5,
        paddingHorizontal: 4,
        gap: 3,
        borderBottomWidth: 1,
        borderColor: c().border,
        backgroundColor: props.selected ? c().selected : "transparent",
        cursor: "pointer",
      }}
    >
      {props.children}
      <Label
        size={10}
        line={12}
        lines={1}
        style={{ maxWidth: props.agent ? "100%" : 49, textAlign: "center" }}
      >
        {props.label}
      </Label>
      <If when={props.status}>
        <View
          style={{
            position: "absolute",
            top: 2,
            right: props.agent ? 2 : undefined,
            left: props.agent ? undefined : 2,
            width: 6,
            height: 6,
            opacity: props.status === "idle" ? 0.4 : 1,
            backgroundColor:
              props.status === "idle"
                ? c().muted
                : props.status === "waiting"
                  ? c().amber
                  : props.agent
                    ? c().blue
                    : c().green,
          }}
        />
      </If>
    </View>
  );
}

function NavItem(props: {
  item: Destination;
  selected: boolean;
  layout: Layout;
  count?: number;
  onPress: () => void;
}) {
  const c = colors();
  const text = useText();
  const picker = pickerTarget("NavItem", "apps/client/shell.tsx");
  const wide = () => props.layout === "desktop";
  const phone = () => props.layout === "phone";
  return (
    <View
      {...picker}
      role="button"
      accessibilityLabel={text(props.item[1])}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onPress()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...(wide() ? row : { alignItems: "center", justifyContent: "center" }),
        height: wide() ? 28 : phone() ? 63 : 48,
        width: phone() ? "20%" : "100%",
        flexShrink: 0,
        paddingHorizontal: wide() ? 7 : 0,
        gap: wide() ? 8 : 4,
        backgroundColor:
          props.selected && !phone() ? c().selected : "transparent",
        cursor: "pointer",
      }}
    >
      <Icon
        name={props.item[2]}
        size={wide() ? 14 : phone() ? 22 : 18}
        tone={props.selected || wide() ? "ink" : "muted"}
      />
      <Label
        size={wide() ? 14 : 10}
        line={wide() ? 20 : 14}
        tone={wide() || props.selected ? "ink" : "muted"}
        weight={phone() && props.selected ? 600 : 400}
        style={wide() ? { flex: 1 } : undefined}
      >
        {text(props.item[1])}
      </Label>
      <If when={(props.count ?? 0) > 0}>
        <Label
          size={wide() ? 12 : 10}
          line={14}
          tone={wide() ? "ink" : "buttonInk"}
          style={
            wide()
              ? {}
              : {
                  position: "absolute",
                  height: 14,
                  minWidth: 14,
                  textAlign: "center",
                  top: phone() ? 8 : 4,
                  left: phone() ? "56%" : "62%",
                  backgroundColor: phone() ? c().blue : c().button,
                }
          }
        >
          {props.count}
        </Label>
      </If>
    </View>
  );
}

export function TabletRail(props: Navigation) {
  const text = useText();
  const c = colors();
  const host = useHost();
  const check = () =>
    host.tasks().filter((task) => task.status === "in_review").length;
  return (
    <View
      web={{ element: "nav" }}
      style={{
        width: sizes.rail,
        height: "100%",
        flexShrink: 0,
        padding: 4,
        gap: 4,
        borderRightWidth: 1,
        borderColor: c().border,
        backgroundColor: c().surface,
      }}
    >
      <View
        role="button"
        accessibilityLabel={text("captain")}
        onPress={() => props.onNavigate("captain")}
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          height: 56,
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
      >
        <CaptainFace size={28} />
      </View>
      <Each of={sections}>
        {(item) => (
          <NavItem
            item={item()}
            layout="tablet"
            selected={props.page === item()[0]}
            count={item()[0] === "tasks" ? check() : 0}
            onPress={() => props.onNavigate(item()[0])}
          />
        )}
      </Each>
      <View style={{ flex: 1 }} />
      <View
        style={{
          borderTopWidth: 1,
          borderColor: c().border,
          paddingBottom: 6,
          paddingTop: 3,
        }}
      >
        <NavItem
          item={["settings", "settings", "settings"]}
          layout="tablet"
          selected={props.page === "settings"}
          onPress={() => props.onNavigate("settings")}
        />
      </View>
    </View>
  );
}

const phoneTabs = [
  ["chat", "chat"],
  ["pending", "pending"],
  ["captain", "captain"],
  ["tasks", "tasks"],
  ["more", "more"],
] as const;

type PhoneTab = (typeof phoneTabs)[number];

function PhoneTabItem(props: {
  tab: PhoneTab;
  selected: boolean;
  count: number;
  onPress: () => void;
}) {
  const c = colors();
  const text = useText();
  const picker = pickerTarget("PhoneTabItem", "apps/client/shell.tsx");
  const page = () => props.tab[0];
  const glyph = () => {
    const name = page();
    if (name === "captain") return "";
    const paths = phoneTabPaths[name][props.selected ? "selected" : "idle"];
    const color = props.selected ? c().ink : c().muted;
    const markup = paths
      .map(
        (path) =>
          `<path d="${path.d}" fill="${color}" opacity="${"opacity" in path ? path.opacity : 1}"/>`,
      )
      .join("");
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${markup}</svg>`,
    )}`;
  };
  return (
    <View
      {...picker}
      role="button"
      accessibilityLabel={text(props.tab[1])}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onPress()}
      style={{
        flex: 1,
        height: 63,
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        position: "relative",
        cursor: "pointer",
      }}
    >
      <If when={page() === "captain"}>
        <CaptainFace size={32} />
      </If>
      <If when={page() !== "captain"}>
        <Image
          src={glyph()}
          fadeDuration={0}
          style={{ width: 22, height: 22, flexShrink: 0 }}
        />
        <Label
          size={10}
          line={12}
          weight={props.selected ? 600 : 400}
          tone={props.selected ? "ink" : "muted"}
        >
          {text(props.tab[1])}
        </Label>
      </If>
      <If when={props.count > 0}>
        <View
          style={{
            position: "absolute",
            top: 8,
            left: "55%",
            height: 14,
            minWidth: 14,
            paddingHorizontal: 3,
            backgroundColor: c().blue,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Label size={10} line={12} style={{ color: "#ffffff" }}>
            {props.count}
          </Label>
        </View>
      </If>
    </View>
  );
}

export function PhoneNavigation(props: Navigation) {
  const c = colors();
  const host = useHost();
  const waiting = () =>
    host.pending().length +
    host.tasks().filter((task) => task.status === "in_review").length +
    host
      .list<CaptainOperationView>("captain", "operations")
      .filter((op) => op.requiresApproval && op.status === "pending").length;
  return (
    <View
      web={{ element: "nav" }}
      style={{
        ...row,
        height: sizes.phoneNav,
        flexShrink: 0,
        borderTopWidth: 1,
        borderColor: c().border,
        backgroundColor: c().canvas,
      }}
    >
      <Each of={phoneTabs}>
        {(tab) => (
          <PhoneTabItem
            tab={tab()}
            selected={
              props.page === tab()[0] ||
              (tab()[0] === "pending" && props.page === "routines") ||
              (tab()[0] === "more" &&
                ["email", "plugins", "settings"].includes(props.page))
            }
            count={tab()[0] === "pending" ? waiting() : 0}
            onPress={() => props.onNavigate(tab()[0])}
          />
        )}
      </Each>
    </View>
  );
}

function CaptainCard(props: { onPress: () => void }) {
  const text = useText();
  const host = useHost();
  const c = colors();
  return (
    <View style={{ flexShrink: 0, padding: 14 }}>
      <View
        role="button"
        accessibilityLabel={text("captain")}
        onPress={() => props.onPress()}
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          ...row,
          alignItems: "flex-start",
          gap: 12,
          minHeight: 54,
          paddingVertical: 8,
          paddingHorizontal: 14,
          borderWidth: 1,
          borderColor: c().border,
          backgroundColor: c().canvas,
          cursor: "pointer",
        }}
      >
        <CaptainFace size={24} />
        <View style={{ flex: 1, gap: 1 }}>
          <View style={{ ...row, gap: 8 }}>
            <Label weight={500}>{text("captain")}</Label>
            <Label size={10} tone="muted">
              {text(host.captain()?.status === "working" ? "working" : "idle")}
            </Label>
          </View>
          <Label size={10} line={15} tone="muted" lines={1}>
            {text("captainNoConversation")}
          </Label>
        </View>
      </View>
    </View>
  );
}

function RailCaptain(props: { selected: boolean; onPress: () => void }) {
  const c = colors();
  const text = useText();
  return (
    <View
      style={{
        height: 80,
        flexShrink: 0,
        alignItems: "center",
        paddingTop: 7,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View
        role="button"
        accessibilityLabel={text("captain")}
        accessibilityState={{ selected: props.selected }}
        onPress={props.onPress}
        hoverStyle={{ backgroundColor: c().selected }}
        focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
        style={{
          width: 48,
          height: 64,
          alignItems: "center",
          gap: 3,
          backgroundColor: props.selected ? c().selected : "transparent",
          cursor: "pointer",
        }}
      >
        <View
          style={{
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <CaptainContextRing />
          <CaptainFace size={36} />
        </View>
        <Label size={10} line={14}>
          {text("captain")}
        </Label>
      </View>
    </View>
  );
}

function GroupRow(props: {
  group: ConversationSummary;
  selected: boolean;
  layout: Layout;
  collapsed?: boolean;
  onPress: () => void;
}) {
  const host = useHost();
  const c = colors();
  const phone = () => props.layout === "phone";
  const people = () => props.group.participants.slice(0, 3);
  const project = () =>
    host.projects().find((project) => project.id === props.group.projectId);
  const time = () =>
    relativeTime(
      Math.max(props.group.lastMessageAt ?? 0, props.group.updatedAt),
    );
  const detailed = () => (
    <View
      role="button"
      accessibilityLabel={props.group.name}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onPress()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        minHeight: phone() ? 64 : 53,
        flexShrink: 0,
        paddingHorizontal: phone() ? 16 : 14,
        paddingVertical: 7,
        gap: phone() ? 8 : 2,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
        backgroundColor: props.selected ? c().selected : "transparent",
        ...(phone() ? row : {}),
      }}
    >
      <If when={phone()}>
        <View style={{ ...row, width: 40, flexShrink: 0 }}>
          <Each of={people()}>
            {(person) => <AgentFace id={person().agentId} size={16} />}
          </Each>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label lines={1}>{props.group.name}</Label>
          <Label size={12} tone="muted" lines={1}>
            {props.group.preview}
          </Label>
        </View>
        <If when={props.group.unread > 0}>
          <View style={{ backgroundColor: c().blue, width: 6, height: 6 }} />
        </If>
        <Label size={10} tone="muted">
          {time()}
        </Label>
        <Icon name="right" size={12} tone="faint" />
      </If>
      <If when={!phone()}>
        <View style={{ ...row, gap: 6 }}>
          <View style={row}>
            <Each of={people()}>
              {(person) => <AgentFace id={person().agentId} size={16} />}
            </Each>
          </View>
          <Label size={16} line={20} lines={1} style={{ flex: 1 }}>
            {props.group.name}
          </Label>
          <Label size={10} line={14} tone="muted">
            {time()}
          </Label>
        </View>
        <Label size={10} line={14} tone="muted" lines={1}>
          {project()?.display ?? ""}
        </Label>
      </If>
    </View>
  );
  return (
    <If when={props.collapsed} else={detailed()}>
      <RailEntry
        label={props.group.name}
        selected={props.selected}
        status={
          props.group.participants.some((person) => person.status !== "idle")
            ? "active"
            : undefined
        }
        onPress={props.onPress}
      >
        <View style={{ ...row, height: 14 }}>
          <Each of={people()} key={(person) => person.agentId}>
            {(person, index) => (
              <View style={{ marginLeft: index() ? -3 : 0 }}>
                <AgentFace id={person().agentId} size={14} />
              </View>
            )}
          </Each>
        </View>
      </RailEntry>
    </If>
  );
}

function AgentRow(props: {
  agent: AgentView;
  phone: boolean;
  collapsed?: boolean;
  onPress: () => void;
}) {
  const c = colors();
  const detailed = () => (
    <View
      role="button"
      accessibilityLabel={props.agent.name}
      onPress={() => props.onPress()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: props.phone ? 52 : 33,
        paddingHorizontal: 16,
        flexShrink: 0,
        gap: props.phone ? 26 : 8,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <AgentFace id={props.agent.id} size={20} />
      <Label lines={1} style={{ flex: 1 }}>
        {props.agent.name}
      </Label>
      <If when={props.phone}>
        <Label size={11} tone="muted">
          {props.agent.status === "working"
            ? uiText("working2")
            : uiText("idle")}
        </Label>
        <Icon name="right" size={12} tone="faint" />
      </If>
      <If when={!props.phone}>
        <View
          style={{
            width: 6,
            height: 6,
            backgroundColor:
              props.agent.status === "working" ? c().blue : "#bdbdbd",
          }}
        />
      </If>
    </View>
  );
  return (
    <If when={props.collapsed} else={detailed()}>
      <RailEntry
        label={props.agent.name}
        agent
        status={
          props.agent.status === "working"
            ? "active"
            : props.agent.status === "waiting_for_input"
              ? "waiting"
              : "idle"
        }
        onPress={props.onPress}
      >
        <AgentFace id={props.agent.id} size={24} />
      </RailEntry>
    </If>
  );
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

export function DesktopSidebar(
  props: Navigation &
    Omit<ChatListProps, "layout"> & {
      collapsed: boolean;
      onToggle: () => void;
    },
) {
  const text = useText();
  const c = colors();
  const host = useHost();
  const check = () =>
    host.tasks().filter((task) => task.status === "in_review").length;
  let focusToggle = false;
  function toggleSidebar() {
    focusToggle = true;
    props.onToggle();
  }
  function attachToggle(node: ViewRef | null) {
    if (!node || !focusToggle) return;
    focusToggle = false;
    node.focus();
  }
  return (
    <View
      style={{
        width: props.collapsed ? sizes.rail : sizes.sidebar,
        height: "100%",
        flexShrink: 0,
        borderRightWidth: 1,
        borderColor: c().border,
        backgroundColor: c().surface,
      }}
    >
      <View
        style={{
          ...row,
          justifyContent: props.collapsed ? "center" : "space-between",
          height: 40,
          paddingHorizontal: props.collapsed ? 4 : 14,
          borderBottomWidth: 1,
          borderColor: c().border,
          flexShrink: 0,
        }}
      >
        <Label
          size={props.collapsed ? 10 : 16}
          line={props.collapsed ? 14 : 20}
          tone={props.collapsed ? "muted" : "ink"}
          style={{ letterSpacing: props.collapsed ? 0.8 : 3.2 }}
        >
          ETA
        </Label>
        <If when={!props.collapsed}>
          <RailButton
            label={text("collapseSidebar")}
            icon="sidebar"
            size={24}
            width={16}
            iconSize={12}
            expanded
            attach={attachToggle}
            onPress={toggleSidebar}
          />
        </If>
      </View>
      <If
        when={props.collapsed}
        else={<CaptainCard onPress={() => props.onNavigate("captain")} />}
      >
        <RailCaptain
          selected={props.page === "captain"}
          onPress={() => props.onNavigate("captain")}
        />
      </If>
      <View
        web={{ element: "nav" }}
        style={{
          flexShrink: 0,
          borderBottomWidth: 1,
          borderColor: c().border,
          ...(props.collapsed
            ? { alignItems: "center", paddingVertical: 7 }
            : { paddingHorizontal: 7, paddingBottom: 5, gap: 1 }),
        }}
      >
        <If when={props.collapsed}>
          <RailButton
            label={text("expandSidebar")}
            icon="sidebar"
            size={22}
            expanded={false}
            attach={attachToggle}
            onPress={toggleSidebar}
          />
        </If>
        <Each of={sections}>
          {(item) => (
            <If
              when={props.collapsed}
              else={
                <NavItem
                  item={item()}
                  layout="desktop"
                  selected={props.page === item()[0]}
                  count={item()[0] === "tasks" ? check() : 0}
                  onPress={() => props.onNavigate(item()[0])}
                />
              }
            >
              <RailButton
                label={text(item()[1])}
                icon={item()[2]}
                selected={props.page === item()[0]}
                count={item()[0] === "tasks" ? check() : 0}
                onPress={() => props.onNavigate(item()[0])}
              />
            </If>
          )}
        </Each>
      </View>
      <ChatList
        layout="desktop"
        collapsed={props.collapsed}
        selected={props.selected}
        onConversation={props.onConversation}
        onAgent={props.onAgent}
        onCreate={props.onCreate}
        onCreateAgent={props.onCreateAgent}
      />
      <View
        style={{
          paddingHorizontal: 7,
          height: 37,
          justifyContent: "center",
          flexShrink: 0,
          ...(props.collapsed
            ? {
                alignItems: "center",
                borderTopWidth: 1,
                borderColor: c().border,
              }
            : {}),
        }}
      >
        <If
          when={props.collapsed}
          else={
            <NavItem
              item={["settings", "settings", "settings"]}
              layout="desktop"
              selected={props.page === "settings"}
              onPress={() => props.onNavigate("settings")}
            />
          }
        >
          <RailButton
            label={text("settings")}
            icon="settings"
            selected={props.page === "settings"}
            onPress={() => props.onNavigate("settings")}
          />
        </If>
      </View>
    </View>
  );
}
