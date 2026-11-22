import { mount, signal, Storage, Text, View } from "nsh";
import { Button } from "../../src/components";
import { AgentFace } from "../../src/components/agent-face";
import { AnimatedAgentFace } from "../../src/components/agent-face-motion";

// A row of animated faces over the same faces as still images, for seeds of every silhouette.
// Storage `animate` "0" starts them still; the "Animate" button turns the motion on and off.
// Storage `size` sets the side (96 by default).
const seeds = [
  "2c9e55aa",
  "6e12ce64",
  "c3a676e3",
  "7dce50f0",
  "c236507e",
  "8270ccec",
];

function Fixture(props: { animate: boolean; size: number }) {
  const animate = signal(props.animate);
  return (
    <View style={{ flex: 1, padding: 24, gap: 16, backgroundColor: "#ffffff" }}>
      <Button
        label="Animate"
        selected={animate()}
        onPress={() => animate.set(!animate())}
      />
      <Text>{animate() ? "Animating" : "Still"}</Text>
      <View style={{ flexDirection: "row", gap: 16 }}>
        <Each of={seeds}>
          {(seed) => (
            <View testID={`moving:${seed()}`}>
              <AnimatedAgentFace
                seed={seed()}
                size={props.size}
                animate={animate()}
              />
            </View>
          )}
        </Each>
      </View>
      <View style={{ flexDirection: "row", gap: 16 }}>
        <Each of={seeds}>
          {(seed) => (
            <View testID={`still:${seed()}`}>
              <AgentFace seed={seed()} size={props.size} />
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

void Promise.all([Storage.getItem("animate"), Storage.getItem("size")]).then(
  ([animate, size]) =>
    mount(() => (
      <Fixture animate={animate !== "0"} size={Number(size ?? 96)} />
    )),
);
