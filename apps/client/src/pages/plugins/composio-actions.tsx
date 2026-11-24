import type { PluginResults } from "@eta/client-contracts";
import { COMPOSIO_NO_MANAGED_LOGIN } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, Label, Modal } from "../../components";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

type Host = ReturnType<typeof useHost>;

/**
 * Starts a sign-in for one toolkit on Composio and opens its page in the browser. Connecting and
 * signing in again are the same thing to Composio, so both go through here.
 */
export async function linkAndOpen(
  host: Host,
  open: (url: string) => Promise<unknown>,
  slug: string,
): Promise<void> {
  const link = await host
    .call<PluginResults["composioLink"]>("plugins", "composioLink", { slug })
    .catch((error: unknown) => {
      // The host's text names a marker; the user reads the sentence in their language.
      throw error instanceof Error &&
        error.message.startsWith(COMPOSIO_NO_MANAGED_LOGIN)
        ? new Error(uiText("composioNoManagedLogin"))
        : error;
    });
  await open(link.redirectUrl);
}

/**
 * Asks before a toolkit is disconnected on Composio, which cannot be undone there, and then does
 * it. The market's detail and the installed page's group both open this one dialog, so there is
 * one operation. When Composio cannot do it the dialog stays, with a line that says only that.
 */
export function ComposioDisconnect(props: {
  slug: string;
  name: string;
  phone: boolean;
  onDone: () => void;
  onClose: () => void;
}) {
  const host = useHost();
  const busy = signal(false);
  const failed = signal(false);
  async function run() {
    if (busy()) return;
    busy.set(true);
    failed.set(false);
    try {
      const done = await host.call<PluginResults["composioDisconnect"]>(
        "plugins",
        "composioDisconnect",
        { slug: props.slug },
      );
      if (done.status === "ready") props.onDone();
      else failed.set(true);
    } catch {
      failed.set(true);
    } finally {
      busy.set(false);
    }
  }
  return (
    <Modal
      title={uiText("composioDisconnectTitle", { name: props.name })}
      // design-value: dialog width, as the other disconnect-style dialogs
      width={432}
      phone={props.phone}
      sheet={props.phone}
      overPhoneNavigation
      modalFocus
      dismissible={!busy()}
      onClose={props.onClose}
    >
      {/* design-value: 10px between the dialog's lines, not on the space scale */}
      <View style={{ padding: space[16], gap: 10 }}>
        <Label>{uiText("composioDisconnectBody", { name: props.name })}</Label>
        <If when={failed()}>
          <Label tone="red">{uiText("composioDisconnectFailed")}</Label>
        </If>
        <Button
          label={uiText("composioDisconnectConfirm")}
          tone="danger"
          disabled={busy()}
          onPress={() => void run()}
        />
        <Button
          label={uiText("cancel")}
          tone="ghost"
          disabled={busy()}
          onPress={props.onClose}
        />
      </View>
    </Modal>
  );
}
