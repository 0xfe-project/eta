import type { Point } from "nsh";
import type { Layout } from "../components";
import { signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Compact,
  Field,
  grow,
  Header,
  Label,
  row,
  sizes,
  SmoothScroll,
} from "../components";
import { control, icon, space } from "../components/tokens";
import { useText } from "../i18n";
import { useHost } from "../services/host";
import { GroupRow } from "./chat-list-rows";
import { ArchiveGroup, GroupMenu, RenameGroup } from "./group-actions";
import { RailButton } from "./rail-controls";

/** A phone's section heading over the list ("Groups"). */
const sectionHeight = 36;

export interface ChatListProps {
  layout: Layout;
  selected: string;
  onConversation: (id: string) => void;
  onCreate: () => void;
  /** A group was archived from its menu: it left the list. */
  onArchived: (id: string) => void;
}

export function ChatList(
  props: ChatListProps & { width?: number; collapsed?: boolean },
) {
  const text = useText();
  const c = colors();
  const host = useHost();
  const searching = signal(false);
  const query = signal("");
  // The group whose menu is open, and where in its row; then the dialog it chose.
  const menu = signal<{ id: string; at: Point } | undefined>(undefined);
  const renaming = signal("");
  const archiving = signal("");
  const named = (id: string) =>
    host.conversations().find((group) => group.id === id);
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
    height: space[32],
    paddingHorizontal: space[16],
    borderBottomWidth: 1,
    flexShrink: 0,
  } as const;
  return (
    <Compact when={!phone()}>
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
          <Header
            title={text("chat")}
            layout={props.layout}
            inset={phone() ? space[16] : space[12]}
            end={phone() ? space[4] : undefined}
          >
            <View style={{ flex: 1 }} />
            <If when={phone()}>
              <Button
                label={text("searchConversations")}
                icon="search"
                iconOnly
                tone="ghost"
                size={control.touch}
                iconSize={icon.md}
                style={{ marginRight: -space[8] }}
                onPress={() => searching.set(!searching())}
              />
            </If>
            <Button
              label={text("newConversation")}
              icon="plus"
              iconOnly
              tone={phone() ? "ghost" : "plain"}
              size={phone() ? control.touch : undefined}
              iconSize={phone() ? icon.md : undefined}
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
                    size={control.sm}
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
        <SmoothScroll style={grow} scrollbar={false}>
          <If when={phone()}>
            <View
              style={{
                height: sectionHeight,
                borderBottomWidth: 1,
                borderColor: c().border,
                paddingHorizontal: space[16],
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
                onMenu={(at) => menu.set({ id: group().id, at })}
              >
                <If when={menu()?.id === group().id ? menu() : undefined}>
                  {(open) => (
                    <GroupMenu
                      group={group()}
                      at={open().at}
                      onClose={() => menu.set(undefined)}
                      onRename={() => renaming.set(group().id)}
                      onArchive={() => archiving.set(group().id)}
                    />
                  )}
                </If>
              </GroupRow>
            )}
          </Each>
          <If when={!props.collapsed && groups().length === 0}>
            <Label variant="small" tone="muted" style={{ padding: space[16] }}>
              {text(query() ? "noMatchingConversations" : "noConversations")}
            </Label>
          </If>
        </SmoothScroll>
        <If when={named(renaming())}>
          {(group) => (
            <RenameGroup
              group={group()}
              phone={phone()}
              onClose={() => renaming.set("")}
            />
          )}
        </If>
        <If when={named(archiving())}>
          {(group) => (
            <ArchiveGroup
              group={group()}
              phone={phone()}
              onClose={() => archiving.set("")}
              onArchived={props.onArchived}
            />
          )}
        </If>
      </View>
    </Compact>
  );
}
