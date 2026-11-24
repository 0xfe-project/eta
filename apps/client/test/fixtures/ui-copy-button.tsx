import { mount, View } from "nsh";
import { CopyButton } from "../../src/ui";

mount(() => (
  <View>
    <CopyButton label="Copy token" value="eta-secret-123" />
  </View>
));
