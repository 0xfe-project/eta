import { mount, signal, Text, View } from "nsh";
import { paneWidth } from "../../src/app/pane-width";
import { Empty, emptyWidth, Header, PaneHandle } from "../../src/ui";

function App() {
  const backs = signal(0);
  return (
    <View style={{ flex: 1 }}>
      <Header
        title="Workspace"
        subtitle="Ready"
        subtitleTone="green"
        count={3}
        onBack={() => backs.set(backs() + 1)}
      />
      <Text>{`backs:${backs()} width:${paneWidth("sidebar")}`}</Text>
      <View style={{ position: "relative", width: 320, height: 120 }}>
        <Empty
          icon="archive"
          title="Nothing yet"
          description="Items will appear here."
          descriptionWidth={emptyWidth.narrow}
        />
        <PaneHandle pane="sidebar" />
      </View>
    </View>
  );
}

mount(() => <App />);
