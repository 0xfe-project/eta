import type { JSX } from "nsh";
import type { ProvidersView } from "@eta/client-contracts";
import type { TextKey } from "../../i18n";
import { Keyboard, keyboardFrame, safeArea, Text, View } from "nsh";
import type { InputRef } from "nsh";
import { Input } from "nsh/base";
import { agents, machines } from "../../app/lists";
import {
  connectTo,
  disconnect,
  failure,
  host,
  lastOnlineAt,
  phase,
  retry,
} from "../../app/session";
import { language, t } from "../../i18n";
import { nav } from "../../nav/stack";
import { clock } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { ToastHost } from "../../ui/toast";
import { eager, useTarget } from "../../wire/target";
import { parseConnectLink } from "@eta/client-contracts/connect-link";
import { form, scanHostCode } from "./scan";

const SCREEN =
  "flex-1 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]";
const FAILURES = {
  token: "connect.failure.token",
  network: "connect.failure.network",
  timeout: "connect.failure.timeout",
} as const;

/**
 * Forget the host, from Settings or 08b′. The form goes up first: `disconnect` takes the wire away, and
 * every screen behind `ready` reads it. Pushed pages stay out of the next connection.
 */
export function leaveHost(): void {
  nav.popToRoot();
  disconnect();
}

/** A page's own 52-high button. */
function Wide(props: {
  title: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  icon?: JSX.Element;
  testID?: string;
}) {
  const box = () => {
    if (props.disabled) return "bg-muted";
    return props.primary
      ? "bg-primary active:opacity-80"
      : "border border-border-strong active:bg-muted";
  };
  const label = () => {
    if (props.disabled) return "text-muted-foreground";
    return props.primary ? "text-primary-foreground" : "text-foreground";
  };
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      testID={props.testID}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      class={`h-[52px] shrink-0 flex-row items-center justify-center gap-2 ${box()}`}
    >
      {props.icon}
      <Text class={`text-lead leading-[18px] ${label()}`}>{props.title}</Text>
    </View>
  );
}

function Mark() {
  return (
    <Text class="text-gauge leading-[64px] tracking-[0.14em] text-foreground">
      ETA
    </Text>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  inputRef?: (ref: InputRef) => void;
  masked?: boolean;
  error?: boolean;
  placeholder?: string;
  testID: string;
}) {
  return (
    <View
      class={`h-[56px] shrink-0 flex-row items-center gap-3 border-t px-4 ${props.error ? "border-b border-state-error" : "border-border"}`}
    >
      <Text
        class={`${language() === "zh" ? "w-[32px]" : "w-[52px]"} shrink-0 text-sm leading-4 ${props.error ? "text-state-error" : "text-muted-foreground"}`}
      >
        {props.label}
      </Text>
      <Input
        ref={props.inputRef}
        testID={props.testID}
        accessibilityLabel={props.label}
        value={props.value}
        onChange={({ value }) => props.onChange(value)}
        onSubmit={props.onSubmit}
        masked={props.masked}
        placeholder={props.placeholder}
        keyboardType={props.masked ? "default" : "url"}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType={props.masked ? "go" : "next"}
        submitBehavior={props.masked ? "blurAndSubmit" : "submit"}
        class={`min-w-0 grow basis-0 text-input leading-[20px] text-foreground placeholder:text-faint ${props.masked && props.value !== "" ? "tracking-[0.14em]" : ""}`}
      />
    </View>
  );
}

/** 08 and 08a: one form, whether this is the first try or the last one failed. */
export function ConnectScreen() {
  // Back from Settings: the address may help, the token stays with the host that was left.
  if (phase() === "form")
    form.set({ address: host()?.address ?? "", token: "" });

  const edit = (next: { address?: string; token?: string }, typed: string) => {
    const link = parseConnectLink(typed);
    form.set(link ?? { ...form(), ...next });
  };
  let tokenInput: InputRef | undefined;
  const failed = () => phase() === "failed";
  const connecting = () => phase() === "connecting";
  const ready = () => form().address.trim() !== "" && !connecting();
  const connect = () => {
    if (!ready()) return;
    Keyboard.dismiss();
    connectTo({ address: form().address.trim(), token: form().token.trim() });
  };
  const failureKey = (): TextKey => FAILURES[failure() ?? "network"];

  // Makes room itself: the host's own pan loses the token field when its taller keyboard comes up.
  return (
    <View
      class="flex-1 bg-background pt-[env(safe-area-inset-top)]"
      style={{
        paddingBottom:
          keyboardFrame().height > 0
            ? keyboardFrame().height
            : safeArea().bottom,
      }}
    >
      <If
        when={failed()}
        else={
          <View class="grow basis-0 justify-end gap-3 px-4 pb-[32px]">
            <Mark />
            <Text class="text-title leading-[32px] tracking-[-0.01em] text-foreground">
              {t("connect.tagline")}
            </Text>
            <Text class="text-base leading-[23px] text-muted-foreground">
              {t("connect.intro")}
            </Text>
          </View>
        }
      >
        <View class="grow basis-0 justify-end gap-3 px-4 pb-[24px]">
          <Text class="text-gauge-sm leading-[34px] tracking-[-0.02em] text-foreground">
            {t("connect.failed")}
          </Text>
          <Text class="text-base leading-[23px] text-state-error">
            {t(failureKey())}
          </Text>
        </View>
      </If>
      <View class="shrink-0">
        <Field
          label={t("connect.address")}
          testID="connect-address"
          value={form().address}
          placeholder={t("connect.addressHint")}
          onChange={(address) => edit({ address }, address)}
          onSubmit={() => tokenInput?.focus()}
        />
        <Field
          label={t("connect.token")}
          testID="connect-token"
          inputRef={(ref) => {
            tokenInput = ref;
          }}
          masked
          error={failed() && failure() === "token"}
          value={form().token}
          onChange={(token) => edit({ token }, token)}
          onSubmit={connect}
        />
      </View>
      <View class="shrink-0 gap-2 px-4 py-2">
        <Wide
          primary
          disabled={!ready()}
          testID="connect-submit"
          title={
            connecting()
              ? t("connect.connecting")
              : failed()
                ? t("common.retry")
                : t("connect.connect")
          }
          onPress={connect}
        />
        <If when={!failed()}>
          <Wide
            title={t("connect.scan")}
            icon={<Icon name="qrCode" size={20} />}
            onPress={scanHostCode}
          />
        </If>
      </View>
      <ToastHost />
    </View>
  );
}

/** 08b′: it stopped retrying. The agents have not stopped. */
export function DisconnectedScreen() {
  const line = () => {
    const at = lastOnlineAt();
    return [
      host()?.address,
      at === undefined ? undefined : t("connect.lastOnline", { at: clock(at) }),
    ]
      .filter((part) => part !== undefined)
      .join(" · ");
  };
  return (
    <View class={SCREEN}>
      <View class="grow basis-0 justify-end gap-2 px-4 pb-[32px]">
        <Mark />
        <Text class="text-title leading-[32px] tracking-[-0.01em] text-foreground">
          {t("connect.lost")}
        </Text>
        <Text class="text-md leading-[20px] text-muted-foreground">
          {line()}
        </Text>
        <Text class="text-md leading-[20px] text-muted-foreground">
          {t("connect.stillRunning")}
        </Text>
      </View>
      <View class="shrink-0 gap-2 px-4 py-2">
        <Wide primary title={t("common.retry")} onPress={retry} />
        <Wide title={t("connect.switchHost")} onPress={leaveHost} />
      </View>
    </View>
  );
}

function Step(props: {
  number: number;
  title: string;
  body: string;
  current: boolean;
  done?: boolean;
  last?: boolean;
}) {
  const color = () =>
    props.current ? "text-foreground" : "text-muted-foreground";
  return (
    <View
      class={`h-[76px] shrink-0 flex-row items-center gap-3 border-t border-border px-4 ${props.last ? "border-b" : ""}`}
    >
      <View class="w-[20px] shrink-0">
        <If
          when={props.done}
          else={
            <Text class={`text-md leading-4 ${color()}`}>
              {String(props.number)}
            </Text>
          }
        >
          <Icon name="check" size={14} color="muted-foreground" />
        </If>
      </View>
      <View class="min-w-0 grow basis-0">
        <Text class={`text-lead leading-[22px] ${color()}`}>{props.title}</Text>
        <Text class="text-sm leading-[18px] text-muted-foreground">
          {props.body}
        </Text>
      </View>
    </View>
  );
}

/** 08c: a host with no agents. Finishing the steps on the computer brings the app in by itself. */
export function UninitializedScreen() {
  const providers = useTarget("providers");
  useTarget("llm");

  /** The gateway's accounts serve models too (web: `useModels`). */
  const bound = () =>
    (providers.section<ProvidersView>("config")?.providers.length ?? 0) > 0 ||
    (eager<unknown[]>("llm", "models")?.length ?? 0) > 0;
  const hostName = () =>
    machines().find((machine) => machine.kind === "primary")?.name ??
    t("connect.thisHost");
  const stepsLeft = () => (bound() ? 1 : 2) - (agents().length > 0 ? 1 : 0);

  return (
    <View class={SCREEN}>
      <View class="shrink-0 gap-2 px-4 pt-[32px] pb-[28px]">
        <Text class="text-gauge-sm leading-[34px] tracking-[-0.02em] text-foreground">
          {t("connect.notReady", { host: hostName() })}
        </Text>
        <Text class="text-base leading-[23px] text-muted-foreground">
          {t(stepsLeft() === 1 ? "connect.stepsLeft.1" : "connect.stepsLeft.2")}
        </Text>
      </View>
      <View class="shrink-0">
        <Step
          number={1}
          title={t("connect.step.model")}
          body={t(
            bound() ? "connect.step.modelDone" : "connect.step.modelTodo",
          )}
          current={!bound()}
          done={bound()}
        />
        <Step
          number={2}
          title={t("connect.step.agent")}
          body={t("connect.step.agentTodo")}
          current={bound()}
          last
        />
      </View>
      <View class="grow" />
      <View class="shrink-0 px-4 py-3">
        <Text class="text-md leading-[20px] text-muted-foreground">
          {t("connect.autoUpdate")}
        </Text>
      </View>
    </View>
  );
}
