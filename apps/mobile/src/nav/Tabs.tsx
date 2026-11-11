import type { JSX } from "nsh";
import type { IconName } from "../ui/icons";
import type { TextKey } from "../i18n";
import { signal, Text, View } from "nsh";
import { NavPage } from "nsh/base";
import { pendingInteractions } from "../app/lists";
import { ConversationsTab } from "../features/conversations";
import { InboxTab } from "../features/inbox";
import { TasksTab } from "../features/tasks";
import { t } from "../i18n";
import { ConnectionBanner } from "../ui/ConnectionBanner";
import { Icon } from "../ui/Icon";

export type TabName = "inbox" | "conversations" | "tasks";

const tab = signal<TabName>("inbox");

const TABS: { name: TabName; icon: IconName; label: TextKey }[] = [
  { name: "inbox", icon: "bell", label: "common.tab.inbox" },
  { name: "conversations", icon: "chats", label: "common.tab.conversations" },
  { name: "tasks", icon: "checklist", label: "common.tab.tasks" },
];

/** A tab keeps its state and scroll while another shows. */
function Pane(props: { name: TabName; children: JSX.Element }) {
  return (
    <View style={{ flex: 1, display: tab() === props.name ? "flex" : "none" }}>
      {props.children}
    </View>
  );
}

/** Pending 6 on the other tabs; on its own tab the count is the page's headline. */
function label(name: TabName, text: string): string {
  if (name !== "inbox" || tab() === "inbox") return text;
  const waiting = pendingInteractions().length;
  return waiting === 0 ? text : `${text} ${waiting}`;
}

export function Tabs() {
  return (
    <NavPage
      headerVisible={false}
      class="flex-1 bg-background pt-[env(safe-area-inset-top)]"
    >
      <ConnectionBanner />
      <View class="flex-1">
        <Pane name="inbox">
          <InboxTab />
        </Pane>
        <Pane name="conversations">
          <ConversationsTab />
        </Pane>
        <Pane name="tasks">
          <TasksTab />
        </Pane>
      </View>
      <View class="shrink-0 border-t border-border-strong bg-background pb-[env(safe-area-inset-bottom)]">
        <View class="h-[52px] flex-row">
          <Each of={TABS}>
            {(entry) => {
              const active = () => tab() === entry().name;
              return (
                <View
                  role="tab"
                  testID={`tab-${entry().name}`}
                  onPress={() => tab.set(entry().name)}
                  class="grow basis-0 items-center justify-center gap-[2px]"
                >
                  <Icon
                    name={entry().icon}
                    size={20}
                    color={active() ? "foreground" : "muted-foreground"}
                  />
                  <Text
                    class={`text-micro leading-[14px] ${active() ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {label(entry().name, t(entry().label))}
                  </Text>
                </View>
              );
            }}
          </Each>
        </View>
      </View>
    </NavPage>
  );
}
