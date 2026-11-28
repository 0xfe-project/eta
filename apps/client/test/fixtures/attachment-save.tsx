import type { useHost } from "../../src/services/host";
import { mount, View } from "nsh";
import { Button, colors } from "../../src/components";
import { NotificationHost } from "../../src/components/notifications";
import { createAttachmentFiles } from "../../src/services/attachment-files";
import { createHost, Host } from "../../src/services/host";

function Fixture() {
  const c = colors();
  const host = createHost();
  const files = createAttachmentFiles({
    address: () => ({ origin: "http://host.test" }),
  } as unknown as ReturnType<typeof useHost>);
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1, backgroundColor: c().canvas }}>
        <Button
          label="Save report"
          onPress={() =>
            void files.save({
              id: "a1",
              name: "report.txt",
              contentType: "text/plain",
            })
          }
        />
        {files.writer()}
        <NotificationHost />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
