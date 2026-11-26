import type { RunBlock } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { palette, Palette } from "../../src/components";
import { ProcessStep } from "../../src/pages/chat/process-step";

const steps: RunBlock[] = [
  {
    type: "tool",
    id: "s1",
    name: "esmrun",
    input: { script: "const files = await eta.fs.list('src');" },
    status: "completed",
  },
  {
    type: "tool",
    id: "s2",
    name: "esmrun",
    input: { script: "return await eta.fs.read('src/foo.ts');" },
    details: { effects: [{ name: "view", detail: "src/foo.ts" }] },
    status: "completed",
  },
  {
    type: "tool",
    id: "s3",
    name: "Bash",
    input: { command: "ls -la" },
    status: "completed",
  },
];

function Fixture() {
  const c = () => palette("light");
  return (
    <Palette.Provider value={c}>
      <View style={{ flex: 1, backgroundColor: c().canvas }}>
        {steps.map((step) => (
          <ProcessStep value={step} />
        ))}
      </View>
    </Palette.Provider>
  );
}
mount(Fixture);
