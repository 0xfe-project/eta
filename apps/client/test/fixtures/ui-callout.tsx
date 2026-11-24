import { mount, View } from "nsh";
import { Callout, WarningLine } from "../../src/ui";

mount(() => (
  <View>
    <Callout
      tone="danger"
      icon="warningFill"
      title="Connection failed"
      description="Host refused the token."
    />
    <Callout tone="info" title="Sync ready" />
    <WarningLine text="Missing model configuration" outline />
  </View>
));
