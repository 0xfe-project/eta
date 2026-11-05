import { keyboardFrame, safeAreaInsets, View } from "nsh";

/** Room for the home indicator, unless the keyboard covers it. */
export function BottomInset() {
  const insets = safeAreaInsets();
  return (
    <View
      style={{ height: keyboardFrame().height > 0 ? 0 : insets().bottom }}
    />
  );
}
