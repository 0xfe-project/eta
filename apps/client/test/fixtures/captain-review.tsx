import { mount, signal, Text, View } from "nsh";
import { CaptainReview } from "../../src/pages/chat/captain-review";
import { createHost, Host } from "../../src/services/host";

function Fixture() {
  const pending = signal(false);
  return (
    <Host.Provider value={createHost()}>
      <View>
        <CaptainReview
          time="Today 07:46 PM"
          onPending={() => pending.set(true)}
          items={[
            {
              id: "settled",
              kind: "assignment_settled",
              body: "The package is ready for review.",
              data: { taskNumber: 7 },
              detail: "Installer complete.",
            },
            {
              id: "waiting",
              kind: "inbox_relay_waiting",
              body: "A decision is required.",
              data: { taskNumber: 11, interactionId: "question" },
              detail: "Choose the next sample.",
            },
          ]}
        />
        <If when={pending()}>
          <Text>Opened pending questions</Text>
        </If>
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
