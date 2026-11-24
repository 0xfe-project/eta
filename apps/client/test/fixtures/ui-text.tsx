import { mount, View } from "nsh";
import { Caption, Icon, Label, RowChevron } from "../../src/ui";

mount(() => (
  <View>
    <Label variant="body">Regular body</Label>
    <Label variant="small" mono>
      bun test
    </Label>
    <Caption text="Section" />
    <Icon name="check" />
    <Icon name="check" accessibilityLabel="Verified" />
    <RowChevron />
  </View>
));
