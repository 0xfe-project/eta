import type {
  MachineResults,
  TailscaleServeStatusView,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import { Clipboard, Image, Overlay, signal, View, windowSize } from "nsh";
import qrCode from "qrcode-generator";
import { Button, colors, Field, Label, Modal, row } from "../../../components";
import { CloseButton } from "../../../components/navigation-buttons";
import { control, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { Callout, Chip, CopyButton } from "../../../ui";
import {
  alternateTailscalePort,
  isLoopbackUrl,
  mergeTailscaleServeResult,
  normalizeCustomHostUrl,
  routeChipLabel,
  setTailscaleServeArgs,
  TAILSCALE_SERVE_CALL_TIMEOUT_MS,
  tailscaleDiagnosticText,
  tailscaleHttpsUrl,
} from "./remote-access";

/** The pairing code, square, and the sheet or popover around it: narrower than any dialog. */
const qrWidth = { phone: 180, wide: 140 } as const;
const pairingWidth = 304;
const widePopoverThreshold = 1440;

/**
 * The pairing code. Beside the wide settings dialog it is a popover to its right; on a tablet it
 * drops from the Connect phone button (`anchor`); on a phone it is a sheet.
 */
export function PhonePairing(props: {
  phone: boolean;
  anchor?: ViewRef;
  initialAddresses?: MachineResults["addresses"];
  onAddressesChange?: (next: MachineResults["addresses"]) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const addresses = signal<MachineResults["addresses"] | undefined>(
    props.initialAddresses,
  );
  const tailscale = signal<TailscaleServeStatusView | undefined>(
    props.initialAddresses?.tailscaleServe,
  );
  const loadingAddresses = signal(
    host.can("machines.addresses") && !props.initialAddresses,
  );
  const mode = signal<"route" | "custom">("route");
  const selectedUrl = signal("");
  const customInput = signal("");
  const customError = signal("");
  const qr = signal<{ link: string; url: string; image: string } | undefined>(
    undefined,
  );
  const qrError = signal("");
  const qrBusy = signal(false);
  const tailscaleBusy = signal<"" | "enabling" | "disabling">("");
  const copied = signal(false);
  let qrSeq = 0;

  const wide = () => windowSize().width >= widePopoverThreshold && !props.phone;
  const popover = () => wide() || (!props.phone && !!props.anchor);
  const reachableRoutes = () =>
    (addresses()?.routes ?? []).filter((route) => route.reachable);
  const hasReachable = () => reachableRoutes().length > 0;
  const ts = () => tailscale() ?? addresses()?.tailscaleServe;
  const tsDiagnostic = () => tailscaleDiagnosticText(ts());
  const retryPort = () => alternateTailscalePort(ts());
  const canEnableTailscale = () => {
    const status = ts();
    return (
      host.can("machines.setTailscaleServe") &&
      !!status &&
      status.installed &&
      status.running
    );
  };

  async function generate(url?: string) {
    const seq = ++qrSeq;
    qrBusy.set(true);
    qrError.set("");
    qr.set(undefined);
    copied.set(false);
    if (url && isLoopbackUrl(url)) {
      qrBusy.set(false);
      return;
    }
    try {
      const link = await host.call<MachineResults["phoneLink"]>(
        "machines",
        "phoneLink",
        url ? { url } : {},
      );
      if (seq !== qrSeq) return;
      if (isLoopbackUrl(link.url)) return;
      const image = qrCode(0, "M");
      image.addData(link.link);
      image.make();
      qr.set({
        ...link,
        image: `data:image/svg+xml;base64,${btoa(image.createSvgTag(4, 16))}`,
      });
    } catch {
      if (seq !== qrSeq) return;
      qrError.set(uiText("phoneCodeFailed"));
    } finally {
      if (seq === qrSeq) qrBusy.set(false);
    }
  }

  async function loadInitial() {
    if (!host.can("machines.addresses")) {
      await generate();
      return;
    }
    loadingAddresses.set(!addresses());
    try {
      const next = await host.call<MachineResults["addresses"]>(
        "machines",
        "addresses",
        {},
      );
      addresses.set(next);
      tailscale.set(next.tailscaleServe);
      props.onAddressesChange?.(next);
      const best =
        next.preferredUrl ??
        next.routes.find((route) => route.reachable)?.url ??
        "";
      if (best && !isLoopbackUrl(best)) {
        mode.set("route");
        selectedUrl.set(best);
        void generate(best);
      }
    } catch {
      await generate();
    } finally {
      loadingAddresses.set(false);
    }
  }

  async function setTailscaleServe(enabled: boolean, port?: number) {
    if (tailscaleBusy()) return;
    tailscaleBusy.set(enabled ? "enabling" : "disabling");
    qrError.set("");
    try {
      const result = await host.call<MachineResults["setTailscaleServe"]>(
        "machines",
        "setTailscaleServe",
        setTailscaleServeArgs(enabled, port),
        { timeoutMs: TAILSCALE_SERVE_CALL_TIMEOUT_MS },
      );
      const merged = mergeTailscaleServeResult(addresses(), result);
      addresses.set(merged);
      tailscale.set(result.tailscaleServe);
      props.onAddressesChange?.(merged);
      if (enabled && result.ok) {
        const nextUrl =
          result.tailscaleServe.activeUrl ??
          result.preferredUrl ??
          result.routes.find((route) => route.reachable)?.url ??
          "";
        if (nextUrl && !isLoopbackUrl(nextUrl)) {
          mode.set("route");
          selectedUrl.set(nextUrl);
          void generate(nextUrl);
        }
      }
    } catch (err) {
      qrError.set(problemText(err));
    } finally {
      tailscaleBusy.set("");
    }
  }

  function submitCustomUrl() {
    const parsed = normalizeCustomHostUrl(customInput());
    if (!parsed.ok) {
      customError.set(
        uiText(
          parsed.reason === "loopback"
            ? "phoneCustomUrlLoopback"
            : "phoneCustomUrlInvalid",
        ),
      );
      return;
    }
    customError.set("");
    mode.set("custom");
    selectedUrl.set(parsed.url);
    void generate(parsed.url);
  }

  void loadInitial();

  const customForm = (inline: boolean) => (
    <View style={{ gap: space[8] }}>
      <If when={!inline}>
        <Label variant="caption" tone="muted">
          {uiText("phoneCustomUrlLabel")}
        </Label>
      </If>
      <View style={inline ? { ...row, gap: space[8] } : { gap: space[8] }}>
        <Field
          compact={!props.phone}
          label={uiText("phoneHostAddress")}
          value={customInput()}
          placeholder={uiText("phoneRoutePlaceholder")}
          invalid={!!customError()}
          style={inline ? { flex: 1, minWidth: 0 } : undefined}
          onChange={(value) => {
            customInput.set(value);
            customError.set("");
          }}
          onSubmit={submitCustomUrl}
        />
        <Button
          label={uiText("generateCode")}
          tone={inline ? "primary" : "plain"}
          size={props.phone ? control.touch : control.md}
          disabled={!customInput().trim()}
          busy={qrBusy()}
          onPress={submitCustomUrl}
        />
      </View>
      <If when={customError()}>
        <Label variant="caption" tone="red">
          {customError()}
        </Label>
      </If>
    </View>
  );

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
      <If
        when={!loadingAddresses()}
        else={
          <Label variant="small" tone="muted">
            {uiText("generatingTheCode")}
          </Label>
        }
      >
        <If
          when={hasReachable() || !!qr()}
          else={
            <View style={{ gap: space[12] }}>
              <Label variant="small" tone="mutedInk">
                {uiText("phoneCantReachThisAddress")}
              </Label>
              <If when={canEnableTailscale()}>
                <View style={{ gap: space[4] }}>
                  <Button
                    label={
                      tailscaleBusy() === "enabling"
                        ? uiText("tailscaleHttpsEnabling")
                        : uiText("tailscaleHttpsEnable")
                    }
                    tone="primary"
                    size={props.phone ? control.touch : control.lg}
                    busy={tailscaleBusy() === "enabling"}
                    disabled={tailscaleBusy() === "disabling"}
                    onPress={() =>
                      void setTailscaleServe(
                        true,
                        ts()?.diagnostic === "probe-failed" &&
                          ts()?.port &&
                          ts()!.port !== 443
                          ? ts()!.port
                          : undefined,
                      )
                    }
                  />
                  <If when={ts()?.magicDnsName && !tsDiagnostic()}>
                    <Label variant="caption" mono tone="muted" lines={1}>
                      {tailscaleHttpsUrl(ts()!.magicDnsName!, ts()!.port)}
                    </Label>
                  </If>
                </View>
              </If>
              <If when={tsDiagnostic()}>
                {(detail) => (
                  <View style={{ gap: space[8] }}>
                    <Callout
                      tone={
                        ts()?.diagnostic === "not-installed" ||
                        ts()?.diagnostic === "not-running"
                          ? "neutral"
                          : "warning"
                      }
                      title={detail()}
                    />
                    <If when={retryPort()}>
                      {(port) => (
                        <Button
                          label={uiText("tailscaleHttpsRetryPort", {
                            port: port(),
                          })}
                          size={props.phone ? control.touch : control.md}
                          busy={tailscaleBusy() === "enabling"}
                          disabled={tailscaleBusy() === "disabling"}
                          onPress={() => void setTailscaleServe(true, port())}
                        />
                      )}
                    </If>
                    <If
                      when={
                        host.can("machines.setTailscaleServe") &&
                        (ts()?.enabled || ts()?.holderStatus === "ours")
                      }
                    >
                      <Button
                        label={
                          tailscaleBusy() === "disabling"
                            ? uiText("tailscaleHttpsDisabling")
                            : uiText("tailscaleHttpsDisable")
                        }
                        size={props.phone ? control.touch : control.md}
                        busy={tailscaleBusy() === "disabling"}
                        disabled={tailscaleBusy() === "enabling"}
                        onPress={() =>
                          void setTailscaleServe(false, ts()?.port)
                        }
                      />
                    </If>
                  </View>
                )}
              </If>
              <If when={qrError()}>
                <Label variant="small" tone="red">
                  {qrError()}
                </Label>
              </If>
              <View
                style={{
                  borderTopWidth: 1,
                  borderColor: c().border,
                  paddingTop: space[12],
                }}
              >
                {customForm(false)}
              </View>
            </View>
          }
        >
          <View style={{ ...row, flexWrap: "wrap", gap: space[4] }}>
            <Each of={reachableRoutes()} key={(route) => route.url}>
              {(route) => (
                <Chip
                  label={routeChipLabel(route(), reachableRoutes())}
                  selected={mode() === "route" && selectedUrl() === route().url}
                  onPress={() => {
                    mode.set("route");
                    customError.set("");
                    if (selectedUrl() !== route().url || !qr()) {
                      selectedUrl.set(route().url);
                      void generate(route().url);
                    }
                  }}
                />
              )}
            </Each>
            <Chip
              label={uiText("phoneRouteCustom")}
              selected={mode() === "custom"}
              onPress={() => {
                mode.set("custom");
                customError.set("");
              }}
            />
          </View>
          <If when={mode() === "custom"}>{customForm(true)}</If>
          <If when={qr()}>
            <View
              role="button"
              accessibilityLabel={
                copied()
                  ? uiText("connectLinkCopied")
                  : uiText("copyConnectLink")
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
            <View
              style={{
                ...row,
                gap: space[8],
                justifyContent: "space-between",
              }}
            >
              <Label
                variant="caption"
                mono
                tone="muted"
                lines={1}
                style={{ flex: 1, minWidth: 0 }}
              >
                {qr()!.url}
              </Label>
              <CopyButton
                value={() => qr()?.link ?? ""}
                label={uiText("copyConnectLink")}
                copiedLabel={uiText("connectLinkCopied")}
                size={control.sm}
              />
            </View>
            <Label variant="caption" tone="mutedInk">
              {copied()
                ? uiText("connectLinkCopiedItContainsYour")
                : uiText("inEtaOnYourPhoneTap")}
            </Label>
          </If>
          <If when={!qr() && qrBusy()}>
            <Label variant="small" tone="muted">
              {uiText("generatingTheCode")}
            </Label>
          </If>
          <If when={!qr() && qrError()}>
            <Label variant="small" tone="red">
              {qrError()}
            </Label>
          </If>
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
