import type { Layout } from "../../src/components";
import { mount, signal, Text, View, windowSize } from "nsh";
import { ActionItem, ActionMenu, Screen } from "../../src/components";
import { LayoutSelect } from "../../src/components/select";
import { TaskMenu, TaskMenuItem } from "../../src/pages/tasks/menu";

// The shared action menu (the task panel's "⋯") and the Tasks page's menu (the task page's "⋯"),
// in the layout the window's width gives, as the app picks it: under 600 a phone, under 1200 a
// tablet, and a dropdown. "Chose" says what was chosen.
function layoutOf(width: number): Layout {
  return width < 600 ? "phone" : width < 1200 ? "tablet" : "desktop";
}

function Fixture() {
  const chosen = signal("nothing");
  const channel = signal("full");
  const layout = () => layoutOf(windowSize().width);
  return (
    <Screen.Provider value={layout}>
      <View style={{ flex: 1, padding: 16, gap: 16 }}>
        <Text>{`Chose ${chosen()}`}</Text>
        <View style={{ flexDirection: "row", gap: 16 }}>
          <ActionMenu label="Task actions">
            <ActionItem label="Edit" onSelect={() => chosen.set("Edit")} />
            <ActionItem
              label="Archive"
              onSelect={() => chosen.set("Archive")}
            />
          </ActionMenu>
          <TaskMenu
            width={172}
            align="end"
            trigger={
              <View accessibilityLabel="More task actions">
                <Text>⋯</Text>
              </View>
            }
          >
            <TaskMenuItem
              label="Copy link"
              onSelect={() => chosen.set("Copy link")}
            />
          </TaskMenu>
          <LayoutSelect
            accessibilityLabel="Channel"
            items={[
              { value: "full", title: "Full releases" },
              { value: "pre", title: "Pre-releases" },
            ]}
            value={channel()}
            trigger={
              <View>
                <Text>{`Channel: ${channel()}`}</Text>
              </View>
            }
            onChange={({ value }) => value && channel.set(value)}
          />
        </View>
      </View>
    </Screen.Provider>
  );
}

mount(Fixture);
