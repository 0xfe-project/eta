import { mount, Text } from "nsh";
import { onWindows } from "../../src/app/platform";

// Says whether the conversation list takes over the mouse wheel on the
// platform the test opened the app as.
mount(() => <Text>{`wheel: ${onWindows ? "glides" : "native"}`}</Text>);
