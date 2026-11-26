import type { RunBlock } from "@eta/client-contracts";
import { colorScheme, mount, View } from "nsh";
import { palette, Palette } from "../../src/components";
import { ProcessStep, ProcessWindow } from "../../src/pages/chat/process-step";

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");

/** A long thought, a call with a long output, a call with a short one, and calls after them. */
const steps: RunBlock[] = [
  { type: "thinking", id: "thought", text: lines(40) },
  {
    type: "tool",
    id: "long",
    name: "bash",
    input: { command: "seq 40" },
    output: lines(40),
    status: "completed",
  },
  {
    type: "tool",
    id: "short",
    name: "bash",
    input: { command: "echo ok" },
    output: "ok",
    status: "completed",
  },
  ...[1, 2, 3, 4, 5, 6].map(
    (index): RunBlock => ({
      type: "tool",
      id: `later-${index}`,
      name: "bash",
      input: { command: `echo ${index}` },
      status: "completed",
    }),
  ),
];

function Fixture() {
  return (
    <Palette.Provider value={() => palette(colorScheme())}>
      <View testID="window">
        <ProcessWindow height={176}>
          <Each of={steps} key={(step) => step.id}>
            {(step) => <ProcessStep value={step()} />}
          </Each>
        </ProcessWindow>
      </View>
    </Palette.Provider>
  );
}

mount(Fixture);
