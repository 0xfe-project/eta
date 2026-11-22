import type { ViewRef } from "nsh";
import { mount, signal, Text, View } from "nsh";
import { SmoothScroll } from "../../src/components/smooth-scroll";

// A SmoothScroll whose style reads signals, as the app's call sites do: a
// menu's `maxHeight: room()` (undefined until the menu is placed), the
// workspace board's `tablet() ? 8 : 7`, a process step's `height`. The
// buttons change them; "box: ..." says where the scroll view was laid out.
function Fixture() {
  const room = signal<number | undefined>(undefined);
  const tablet = signal(false);
  const height = signal<number | undefined>(undefined);
  const box = signal("");
  let node: ViewRef | undefined;
  const look = async () => {
    const at = await node?.measure();
    if (at)
      box.set(
        `box: top ${Math.round(at.pagePosition.y)} height ${Math.round(at.bounds.size.height)}`,
      );
  };
  const later = () => setTimeout(() => void look(), 50);
  later();
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", height: 40 }}>
        <View role="button" onPress={() => (room.set(200), later())}>
          <Text>room 200</Text>
        </View>
        <View role="button" onPress={() => (room.set(120), later())}>
          <Text>room 120</Text>
        </View>
        <View role="button" onPress={() => (tablet.set(true), later())}>
          <Text>tablet</Text>
        </View>
        <View role="button" onPress={() => (height.set(90), later())}>
          <Text>height 90</Text>
        </View>
      </View>
      <View style={{ height: 600, alignItems: "stretch" }}>
        <SmoothScroll
          ref={(view) => {
            node = view;
          }}
          style={{
            maxHeight: room(),
            height: height(),
            marginTop: tablet() ? 8 : 7,
            flexShrink: 0,
          }}
        >
          <View style={{ height: 1000 }} />
        </SmoothScroll>
      </View>
      <Text>{box()}</Text>
    </View>
  );
}
mount(Fixture);
