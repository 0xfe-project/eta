import type { KeyEvent } from "nsh";
import { mount, signal, Text, View } from "nsh";
import {
  createAdjustable,
  createDisclosure,
  createDismissable,
  createPressable,
  createRovingFocus,
  createSelection,
  createTypeahead,
  definePrimitive,
  dismissStackSize,
  dismissTop,
} from "../../src/ui/behaviors";

const DemoPrimitive = definePrimitive({
  name: "DemoDisclosure",
  setup: (options: { defaultOpen?: boolean }) =>
    createDisclosure({ defaultOpen: options.defaultOpen }),
  parts: (useState) => ({
    Trigger: (props: { label: string }) => {
      const state = useState();
      const press = createPressable({
        label: () => props.label,
        expanded: state.open,
        onPress: state.toggle,
      });
      return (
        <View {...press.viewProps()} testID="primitive-trigger">
          <Text>{props.label}</Text>
        </View>
      );
    },
    Content: (props: { text: string }) => {
      const state = useState();
      return (
        <If when={state.open()}>
          <Text testID="primitive-content">{props.text}</Text>
        </If>
      );
    },
  }),
});

function keyEvent(key: string, shift = false): KeyEvent {
  return {
    key,
    code: "",
    modifiers: {
      alt: false,
      altGraph: false,
      control: false,
      platform: false,
      shift,
    },
    repeat: false,
    defaultPrevented: false,
  };
}

function App() {
  const pressCount = signal(0);
  const disabledPress = signal(false);
  const busyPress = signal(false);
  const pressable = createPressable({
    label: () => "Action",
    disabled: disabledPress,
    busy: busyPress,
    onPress: () => pressCount.update((n) => n + 1),
  });

  const dismissLog = signal<string[]>([]);
  const topEnabled = signal(true);
  const showSecond = signal(true);
  createDismissable({
    onDismiss: () => dismissLog.update((all) => [...all, "first"]),
  });

  const items = [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta", disabled: true },
    { id: "gamma", label: "Gamma" },
    { id: "delta", label: "Delta" },
  ] as const;
  const roving = createRovingFocus({
    orientation: "horizontal",
    items: () => items,
  });
  const selection = createSelection<string>({
    mode: "multiple",
    defaultValue: ["alpha"],
  });
  const matched = signal("");
  const typeahead = createTypeahead({
    items: () => items,
    activeId: roving.activeId,
    onMatch: (id) => {
      matched.set(id);
      roving.focusId(id as (typeof items)[number]["id"]);
    },
  });
  const width = signal(300);
  const adjustable = createAdjustable({
    min: () => 200,
    max: () => 500,
    value: width,
    step: 20,
    largeStep: 100,
    onChange: width.set,
  });

  return (
    <View>
      <View {...pressable.viewProps()} testID="pressable">
        <Text>{`press:${pressCount()}`}</Text>
      </View>
      <View onPress={() => disabledPress.set(!disabledPress())}>
        <Text>Toggle disabled</Text>
      </View>
      <View onPress={() => busyPress.set(!busyPress())}>
        <Text>Toggle busy</Text>
      </View>

      <If when={showSecond()}>
        <SecondDismissable
          enabled={topEnabled}
          onDismiss={() => {
            dismissLog.update((all) => [...all, "second"]);
            showSecond.set(false);
          }}
        />
      </If>
      <View onPress={() => dismissTop()}>
        <Text>Dismiss top</Text>
      </View>
      <View onPress={() => topEnabled.set(!topEnabled())}>
        <Text>Toggle top enabled</Text>
      </View>
      <Text testID="dismiss-state">{`stack:${dismissStackSize()} log:${dismissLog().join(",")}`}</Text>

      <View onPress={() => roving.onKeyDown(keyEvent("ArrowRight"))}>
        <Text>Rove right</Text>
      </View>
      <View onPress={() => roving.onKeyDown(keyEvent("End"))}>
        <Text>Rove end</Text>
      </View>
      <View onPress={() => typeahead.onKeyDown(keyEvent("d"))}>
        <Text>Type d</Text>
      </View>
      <Text testID="roving-state">{`active:${roving.activeId()} match:${matched()}`}</Text>

      <View onPress={() => selection.toggle("gamma")}>
        <Text>Toggle gamma</Text>
      </View>
      <View onPress={() => selection.clear()}>
        <Text>Clear selection</Text>
      </View>
      <Text testID="selection-state">{`sel:${selection.selected().join(",")}`}</Text>

      <View onPress={() => adjustable.onKeyDown(keyEvent("ArrowRight"))}>
        <Text>Step up</Text>
      </View>
      <View onPress={() => adjustable.onKeyDown(keyEvent("ArrowRight", true))}>
        <Text>Large up</Text>
      </View>
      <View onPress={() => adjustable.onKeyDown(keyEvent("Home"))}>
        <Text>Adj min</Text>
      </View>
      <Text testID="adj-state">{`width:${width()}`}</Text>

      <DemoPrimitive.Root>
        <DemoPrimitive.Trigger label="Open details" />
        <DemoPrimitive.Content text="Hidden body" />
      </DemoPrimitive.Root>
    </View>
  );
}

function SecondDismissable(props: {
  enabled: () => boolean;
  onDismiss: () => void;
}) {
  createDismissable({
    onDismiss: props.onDismiss,
    enabled: props.enabled,
  });
  return <View />;
}

mount(() => <App />);
