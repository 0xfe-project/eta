import type { ViewRef } from "nsh";
import { Clipboard, Image, Overlay, signal, View, windowSize } from "nsh";
import qrCode from "qrcode-generator";
import { Button, colors, Field, Label, Modal, row } from "../../../components";
import { CloseButton } from "../../../components/navigation-buttons";
import { control, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";

/** The pairing code, square, and the sheet or popover around it: narrower than any dialog. */
const qrWidth = { phone: 180, wide: 140 } as const;
const pairingWidth = 280;

/**
 * The pairing code. Beside the wide settings dialog it is a popover to its right; on a tablet it
 * drops from the Connect phone button (`anchor`); on a phone it is a sheet.
 */
export function PhonePairing(props: {
  phone: boolean;
  anchor?: ViewRef;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const qr = signal<{ link: string; url: string; image: string } | undefined>(
    undefined,
  );
  /** The host answers on a loopback address, which a phone can't reach. */
  const loopback = signal(false);
  const address = signal("");
  const error = signal("");
  const busy = signal(false);
  const copied = signal(false);
  const wide = () => windowSize().width >= 1380 && !props.phone;
  const popover = () => wide() || (!props.phone && !!props.anchor);

  async function generate(url?: string) {
    busy.set(true);
    error.set("");
    qr.set(undefined);
    loopback.set(false);
    copied.set(false);
    try {
      const link = await host.call<{ link: string; url: string }>(
        "machines",
        "phoneLink",
        url ? { url } : {},
      );
      loopback.set(
        /^(?:localhost|\[::1\]|127(?:\.\d+){3})$/.test(
          new URL(link.url).hostname,
        ),
      );
      const image = qrCode(0, "M");
      image.addData(link.link);
      image.make();
      qr.set({
        ...link,
        image: `data:image/svg+xml;base64,${btoa(image.createSvgTag(4, 16))}`,
      });
    } catch {
      error.set(uiText("phoneCodeFailed"));
    } finally {
      busy.set(false);
    }
  }

  void generate();
  const body = () => (
    <View
      style={
        props.phone
          ? {
              gap: space[12],
              paddingHorizontal: space[16],
              paddingBottom: space[16],
            }
          : { gap: space[12], padding: space[16] }
      }
    >
      <If when={popover()}>
        <View style={{ ...row, justifyContent: "space-between" }}>
          <Label variant="small" weight={weight.strong}>
            {uiText("scanWithYourPhone")}
          </Label>
          <CloseButton size={control.sm} onPress={props.onClose} />
        </View>
      </If>
      <If when={qr()}>
        <If when={loopback()}>
          <Label variant="caption" tone="mutedInk">
            {uiText("phoneCantReachThisAddress")}
          </Label>
        </If>
        <View
          role="button"
          accessibilityLabel={
            copied() ? uiText("connectLinkCopied") : uiText("copyConnectLink")
          }
          tooltip={uiText("copyConnectLink")}
          onPress={() => {
            const link = qr()?.link;
            if (link)
              void host.action(async () => {
                await Clipboard.writeText(link);
                copied.set(true);
              });
          }}
          style={{
            alignSelf: "center",
            backgroundColor: "#ffffff", // design-value: a QR code is read black on white in either theme
            borderWidth: 1,
            borderColor: c().border,
            padding: space[12],
            cursor: "pointer",
          }}
        >
          <Image
            src={qr()!.image}
            style={
              props.phone
                ? { width: qrWidth.phone, height: qrWidth.phone }
                : { width: qrWidth.wide, height: qrWidth.wide }
            }
            fadeDuration={0}
            accessibilityLabel={uiText("etaPairingCode")}
          />
        </View>
        <If when={!loopback() || copied()}>
          <Label variant="caption" tone="mutedInk">
            {copied()
              ? uiText("connectLinkCopiedItContainsYour")
              : uiText("inEtaOnYourPhoneTap")}
          </Label>
        </If>
      </If>
      <If when={!qr()}>
        <Label variant="small" tone={error() ? "red" : "muted"}>
          {error() || uiText("generatingTheCode")}
        </Label>
        <If when={error()}>
          <Field
            label={uiText("phoneHostAddress")}
            value={address()}
            placeholder={uiText("hostAddress")}
            onChange={address.set}
            onSubmit={() => void generate(address().trim())}
          />
          <Button
            label={uiText("generateCode")}
            disabled={!address().trim()}
            busy={busy()}
            onPress={() => void generate(address().trim())}
          />
        </If>
      </If>
    </View>
  );

  return (
    <If
      when={popover()}
      else={
        <Modal
          title={uiText("scanWithYourPhone")}
          phone={props.phone}
          sheet={props.phone}
          plainSheetHeader={props.phone}
          overPhoneNavigation={props.phone}
          width={pairingWidth}
          onClose={props.onClose}
        >
          {body()}
        </Modal>
      }
    >
      <Overlay
        anchor={
          wide()
            ? {
                x: (windowSize().width + 770) / 2 + 25,
                y: Math.max(0, (windowSize().height - 578) / 2),
              }
            : props.anchor
        }
        placement={wide() ? "right" : "bottom"}
        align={wide() ? "start" : "end"}
        offset={wide() ? 0 : 8}
        onCancel={props.onClose}
        onPressOutside={props.onClose}
        style={{ width: pairingWidth }}
      >
        <View
          role="dialog"
          accessibilityLabel={uiText("scanWithYourPhone")}
          style={{
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
          }}
        >
          {body()}
        </View>
      </Overlay>
    </If>
  );
}
