import { mount, signal, Text, View } from "nsh";
import { RollingNumber } from "../../src/components/rolling-number";

// A rolling number with a button per value it can be set to; it starts at 38.
const values = [3, 9, 10, 38, 39, 41, 98, 120];

function Fixture() {
  const value = signal(38);
  return (
    <View style={{ flex: 1, padding: 24, gap: 8, backgroundColor: "#ffffff" }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Each of={values}>
          {(to) => (
            <View
              role="button"
              accessibilityLabel={`Set ${to()}`}
              onPress={() => value.set(to())}
            >
              <Text>{`Set ${to()}`}</Text>
            </View>
          )}
        </Each>
      </View>
      <View style={{ flexDirection: "row", alignSelf: "flex-start" }}>
        <RollingNumber value={value()} />
      </View>
    </View>
  );
}
mount(Fixture);
