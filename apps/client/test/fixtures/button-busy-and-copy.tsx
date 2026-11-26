import { Clipboard, mount, signal, View } from "nsh";
import {
  Button,
  Label,
  palette,
  Palette,
  SafeArea,
  Screen,
} from "../../src/components";
import { NotificationHost } from "../../src/components/notifications";
import { showToast } from "../../src/components/toast";
import { space } from "../../src/components/tokens";
import { uiText } from "../../src/i18n";

function Fixture() {
  const c = () => palette("light");
  const saving = signal(false);
  const saveCount = signal(0);
  const refreshing = signal(false);
  const refreshCount = signal(0);

  function save() {
    if (saving()) return;
    saving.set(true);
    saveCount.update((n) => n + 1);
  }

  function refresh() {
    if (refreshing()) return;
    refreshing.set(true);
    refreshCount.update((n) => n + 1);
  }

  function finishRefresh() {
    refreshing.set(false);
    showToast({ title: uiText("refreshList") });
  }

  function copyValue() {
    void Clipboard.writeText("eta-secret-code").then(() =>
      showToast({ title: uiText("copied") }),
    );
  }

  return (
    <Palette.Provider value={c}>
      <Screen.Provider value={() => "desktop"}>
        <SafeArea style={{ backgroundColor: c().canvas, padding: space[16] }}>
          <View style={{ gap: space[12], alignItems: "flex-start" }}>
            <Button
              label="Save changes"
              tone="primary"
              busy={saving()}
              onPress={save}
            />
            <Button label="Finish save" onPress={() => saving.set(false)} />
            <Label>{`saves:${saveCount()}`}</Label>

            <Button
              label="Refresh catalog"
              icon="refresh"
              spinIcon
              busy={refreshing()}
              onPress={refresh}
            />
            <Button label="Finish refresh" onPress={finishRefresh} />
            <Label>{`refreshes:${refreshCount()}`}</Label>

            <Button label="Copy code" onPress={copyValue} />
          </View>
          <NotificationHost />
        </SafeArea>
      </Screen.Provider>
    </Palette.Provider>
  );
}

mount(Fixture);
