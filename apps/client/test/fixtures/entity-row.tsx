import { mount, signal, Text, View, windowSize } from "nsh";
import { ActionItem, palette, Palette, Screen } from "../../src/components";
import { EntityRow } from "../../src/pages/settings/section";

function App() {
  const c = () => palette("light");
  const layout = () => (windowSize().width < 600 ? "phone" : "desktop");
  const rowPresses = signal(0);
  const menuSelects = signal(0);
  const caretPresses = signal(0);
  const stackedPresses = signal(0);
  const archiveRestores = signal(0);
  const refReady = signal(false);

  return (
    <Palette.Provider value={c}>
      <Screen.Provider value={layout}>
        <View style={{ flex: 1, backgroundColor: c().canvas }}>
          <View testID="row-with-menu">
            <EntityRow
              title="Alice"
              meta="openai:gpt-5"
              status={{ label: "Idle", color: c().faint }}
              menuLabel="Alice"
              menu={
                <ActionItem
                  label="Edit"
                  onSelect={() => menuSelects.update((n) => n + 1)}
                />
              }
              controlRef={(node) => {
                if (node) refReady.set(true);
              }}
              onPress={() => rowPresses.update((n) => n + 1)}
            />
          </View>
          <View testID="row-with-caret">
            <EntityRow
              title="Source"
              meta="3 models"
              status={{ label: "Working", color: c().green }}
              caret
              onPress={() => caretPresses.update((n) => n + 1)}
            />
          </View>
          <View testID="row-stacked">
            <EntityRow
              title="Phone agent"
              meta="Frontend engineer"
              status={{ label: "Idle", color: c().faint }}
              stacked
              caret
              menuLabel="Phone agent"
              menu={<ActionItem label="Hidden menu" onSelect={() => {}} />}
              onPress={() => stackedPresses.update((n) => n + 1)}
            />
          </View>
          <View testID="row-static-caret">
            <EntityRow title="Static caret" meta="Read only" caret />
          </View>
          <View testID="row-static-menu">
            <EntityRow
              title="Archived chat"
              meta="project"
              lane={false}
              menuLabel="Archived chat"
              menu={
                <ActionItem
                  label="Restore"
                  onSelect={() => archiveRestores.update((n) => n + 1)}
                />
              }
            />
          </View>
          <Text>{`row:${rowPresses()} menu:${menuSelects()} caret:${caretPresses()} stacked:${stackedPresses()} restore:${archiveRestores()} ref:${refReady()}`}</Text>
        </View>
      </Screen.Provider>
    </Palette.Provider>
  );
}

mount(App);
