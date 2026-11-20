import type {
  EmailAccountInput,
  EmailAccountView,
  EmailResults,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { Layout } from "../../components";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  grow,
  Header,
  Label,
  row,
} from "../../components";
import { BackButton } from "../../components/navigation-buttons";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { SectionHeader } from "./section";

const providers = {
  Gmail: ["imap.gmail.com", "smtp.gmail.com", 465],
  Outlook: ["outlook.office365.com", "smtp.office365.com", 587],
  QQ: ["imap.qq.com", "smtp.qq.com", 465],
  "163": ["imap.163.com", "smtp.163.com", 465],
} as const;
type Provider = keyof typeof providers | "Custom";

export function MailboxEditor(props: {
  item?: EmailAccountView;
  layout: Layout;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const initial = props.item;
  const account = signal(initial);
  const provider = signal<Provider>(
    initial
      ? ((Object.keys(providers) as (keyof typeof providers)[]).find(
          (key) =>
            providers[key][0] === initial.imapHost &&
            providers[key][1] === initial.smtpHost,
        ) ?? "Custom")
      : "Gmail",
  );
  const preset = providers.Gmail;
  const values = signal({
    name: initial?.name ?? "",
    address: initial?.address ?? "",
    username:
      initial && initial.username !== initial.address ? initial.username : "",
    password: "",
    imapHost: initial?.imapHost ?? preset[0],
    smtpHost: initial?.smtpHost ?? preset[1],
    imapPort: String(initial?.imapPort ?? 993),
    smtpPort: String(initial?.smtpPort ?? preset[2]),
    inboxFolder: initial?.inboxFolder ?? "INBOX",
    junkFolder: initial?.junkFolder ?? "",
    poll: String(initial?.pollIntervalSeconds ?? 60),
  });
  type Values = ReturnType<typeof values>;
  const imapSecure = signal(initial?.imapSecure ?? true);
  const smtpSecure = signal(initial?.smtpSecure ?? true);
  const advanced = signal(false);
  const confirmRemove = signal(false);
  const busy = signal(false);
  const error = signal(initial?.lastError ?? "");
  const phone = () => props.layout === "phone";
  const inputWidth = () => (phone() ? ("100%" as const) : 200);
  function pick(next: Provider) {
    provider.set(next);
    if (next === "Custom") {
      advanced.set(true);
      return;
    }
    const [imapHost, smtpHost, smtpPort] = providers[next];
    values.update((old) => ({
      ...old,
      imapHost,
      smtpHost,
      imapPort: "993",
      smtpPort: String(smtpPort),
    }));
    imapSecure.set(true);
    smtpSecure.set(smtpPort === 465);
  }
  const valid = () => {
    const v = values();
    return !!(
      v.address.trim() &&
      v.imapHost.trim() &&
      v.smtpHost.trim() &&
      (v.password || account()) &&
      [v.imapPort, v.smtpPort].every(
        (port) =>
          /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535,
      ) &&
      /^\d+$/.test(v.poll) &&
      Number(v.poll) > 0
    );
  };
  async function save() {
    if (busy() || !valid()) return;
    busy.set(true);
    error.set("");
    try {
      const v = values();
      const input: EmailAccountInput = {
        id: account()?.id,
        name: v.name.trim() || v.address.trim(),
        address: v.address.trim(),
        username: v.username.trim() || v.address.trim(),
        password: v.password || undefined,
        imapHost: v.imapHost.trim(),
        smtpHost: v.smtpHost.trim(),
        imapPort: Number(v.imapPort),
        smtpPort: Number(v.smtpPort),
        imapSecure: imapSecure(),
        smtpSecure: smtpSecure(),
        inboxFolder: v.inboxFolder.trim() || "INBOX",
        junkFolder: v.junkFolder.trim() || null,
        pollIntervalSeconds: Number(v.poll),
      };
      const result = await host.call<EmailResults["saveAccount"]>(
        "email",
        "saveAccount",
        input,
      );
      account.set(result.account);
      values.update((old) => ({ ...old, password: "" }));
      if (result.account.status === "ready") props.onClose();
      else error.set(result.account.lastError || uiText("mailCheckFailed"));
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.set(false);
    }
  }
  async function remove() {
    const id = account()?.id;
    if (!id || busy()) return;
    if (!confirmRemove()) {
      confirmRemove.set(true);
      return;
    }
    busy.set(true);
    error.set("");
    try {
      await host.call("email", "removeAccount", { accountId: id });
      props.onClose();
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.set(false);
    }
  }
  function FormRow(p: {
    title: string;
    children?: JSX.Element;
    horizontal?: boolean;
  }) {
    const stack = () => phone() && !p.horizontal;
    return (
      <View
        style={{
          flexDirection: stack() ? "column" : "row",
          alignItems: stack() ? "stretch" : "center",
          minHeight: phone() ? 44 : 40,
          paddingHorizontal: 16,
          paddingVertical: 8,
          gap: phone() ? 6 : 16,
          justifyContent: "space-between",
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Label
          size={phone() ? 12 : 14}
          line={phone() ? 16 : 20}
          style={phone() ? undefined : { flex: 1, minWidth: 0 }}
        >
          {p.title}
        </Label>
        {p.children}
      </View>
    );
  }
  function InputRow(p: { name: keyof Values; title: string }) {
    return (
      <FormRow title={p.title}>
        <Field
          label={p.title}
          value={values()[p.name]}
          masked={p.name === "password"}
          placeholder={
            p.name === "password" && account() ? "••••••••" : undefined
          }
          onChange={(v) => values.update((old) => ({ ...old, [p.name]: v }))}
          style={
            phone()
              ? { width: inputWidth(), height: 32 }
              : {
                  width: inputWidth(),
                  height: 24,
                  fontSize: 12,
                  lineHeight: 16,
                  paddingHorizontal: 10,
                  paddingVertical: 3,
                  borderColor: c().strong,
                }
          }
        />
      </FormRow>
    );
  }
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <If
        when={phone()}
        else={
          <SectionHeader
            title={account()?.name ?? uiText("connectMailbox")}
            description={uiText("mailCheckExplanation")}
            leading={
              <BackButton
                disabled={busy()}
                style={{ marginLeft: -6 }}
                onPress={props.onClose}
              />
            }
          />
        }
      >
        <Header
          title={account()?.name ?? uiText("connectMailbox")}
          layout={props.layout}
          onBack={busy() ? undefined : props.onClose}
          inset={12}
        />
      </If>
      <Scroll style={grow} scrollbar={false}>
        <If when={account()}>
          {(a) => (
            <View
              style={{
                ...row,
                gap: 6,
                padding: 12,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <StatusDot
                color={
                  a().status === "ready"
                    ? c().green
                    : a().status === "error"
                      ? c().red
                      : c().faint
                }
              />
              <Label size={12}>
                {a().status === "ready"
                  ? uiText("mailConnected")
                  : a().status === "error"
                    ? uiText("mailConnectionError")
                    : uiText("mailUnverified")}
              </Label>
            </View>
          )}
        </If>
        <If when={phone()}>
          <Label
            size={12}
            line={16}
            tone="muted"
            style={{ paddingHorizontal: 16, paddingVertical: 8 }}
          >
            {uiText("mailCheckExplanation")}
          </Label>
        </If>
        <FormRow title={uiText("mailProvider")}>
          <ActionMenu
            label={uiText("mailProvider")}
            value={provider() === "Custom" ? uiText("mailCustom") : provider()}
            triggerStyle={
              phone()
                ? { width: inputWidth() }
                : {
                    width: inputWidth(),
                    height: 24,
                    paddingLeft: 10,
                    paddingRight: 8,
                  }
            }
          >
            <Each of={[...Object.keys(providers), "Custom"] as Provider[]}>
              {(key) => (
                <ActionItem
                  label={key() === "Custom" ? uiText("mailCustom") : key()}
                  checked={provider() === key()}
                  onSelect={() => pick(key())}
                />
              )}
            </Each>
          </ActionMenu>
        </FormRow>
        <InputRow name="address" title={uiText("mailAddress")} />
        <InputRow name="name" title={uiText("mailName")} />
        <InputRow name="password" title={uiText("mailAppPassword")} />
        <If
          when={phone()}
          else={
            <SectionHeader title={uiText("mailAdvanced")}>
              <Button
                label={uiText("mailAdvanced")}
                icon="down"
                iconOnly
                selected={advanced()}
                onPress={() => advanced.set(!advanced())}
              />
            </SectionHeader>
          }
        >
          <FormRow title={uiText("mailAdvanced")} horizontal>
            <Button
              label={uiText("mailAdvanced")}
              icon={advanced() ? "down" : "right"}
              iconOnly
              selected={advanced()}
              onPress={() => advanced.set(!advanced())}
            />
          </FormRow>
        </If>
        <If when={advanced()}>
          <InputRow name="username" title={uiText("mailUsername")} />
          <InputRow name="imapHost" title="IMAP host" />
          <InputRow name="imapPort" title="IMAP port" />
          <FormRow title="IMAP TLS" horizontal>
            <Button
              label="IMAP TLS"
              selected={imapSecure()}
              onPress={() => imapSecure.set(!imapSecure())}
            />
          </FormRow>
          <InputRow name="smtpHost" title="SMTP host" />
          <InputRow name="smtpPort" title="SMTP port" />
          <FormRow title="SMTP TLS" horizontal>
            <Button
              label="SMTP TLS"
              selected={smtpSecure()}
              onPress={() => smtpSecure.set(!smtpSecure())}
            />
          </FormRow>
          <InputRow name="inboxFolder" title={uiText("mailInboxFolder")} />
          <InputRow name="junkFolder" title={uiText("mailJunkFolder")} />
          <InputRow name="poll" title={uiText("mailPoll")} />
        </If>
        <If when={account()}>
          <FormRow title={uiText("mailRemove")} horizontal>
            <Button
              label={
                confirmRemove() ? uiText("confirmRemove") : uiText("remove2")
              }
              disabled={busy()}
              onPress={() => void remove()}
            />
          </FormRow>
        </If>
        <If when={error()}>
          <Label tone="red" size={12} style={{ padding: 12 }}>
            {error()}
          </Label>
        </If>
      </Scroll>
      <View
        style={{
          alignItems: phone() ? "stretch" : "flex-end",
          paddingHorizontal: 16,
          paddingVertical: phone() ? 10 : 12,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={
            account() ? uiText("mailReconnect") : uiText("mailConnectCheck")
          }
          tone="primary"
          dimDisabled={false}
          disabled={busy() || !valid()}
          size={phone() ? 32 : 24}
          style={phone() ? undefined : { paddingHorizontal: 12 }}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
