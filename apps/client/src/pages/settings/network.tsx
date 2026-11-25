import type {
  PrivateNetworkEntryReason,
  ProvidersView,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  Field,
  grow,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { ToggleSwitch } from "../../components/toggle-switch";
import { control, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { SectionHeader } from "./section";

/** Why an entry has no effect, in the reader's language. */
const entryProblem = {
  syntax: "privateNetworkSyntax",
  url: "privateNetworkUrl",
  port: "privateNetworkPort",
  prefix: "privateNetworkPrefix",
  never: "privateNetworkNever",
  loopback: "privateNetworkLoopbackEntry",
} as const satisfies Record<
  PrivateNetworkEntryReason,
  Parameters<typeof uiText>[0]
>;

/** `text` as a sentence of its own. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Settings › Network: what `web_fetch` may reach in private networks (`web.privateNetwork` in the
 * host's config). Every change is one `providers.setPrivateNetwork` with the whole list; the host
 * checks each new entry and refuses one it cannot use, naming why, and lists the entries already
 * in the file that have no effect.
 */
export function NetworkSettings(props: { phone?: boolean }) {
  const host = useHost();
  const c = colors();
  const draft = signal("");
  const problem = signal("");
  const saving = signal(false);
  const config = () => host.section<ProvidersView>("providers", "config");
  const current = () => config()?.privateNetwork;
  const allow = () => current()?.allow ?? [];
  const loopback = () => current()?.loopback ?? false;
  const invalid = (entry: string) =>
    current()?.invalid.find((item) => item.entry === entry)?.reason;
  const editable = () => host.can("providers.setPrivateNetwork");

  async function save(next: { allow: string[]; loopback: boolean }) {
    const state = config();
    if (!state || saving()) return false;
    saving.set(true);
    problem.set("");
    try {
      await host.call("providers", "setPrivateNetwork", {
        revision: state.revision,
        ...next,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const refused = /invalid_private_network: (\w+) /.exec(message);
      const reason = refused?.[1] as PrivateNetworkEntryReason | undefined;
      problem.set(
        reason !== undefined && reason in entryProblem
          ? sentence(uiText(entryProblem[reason]))
          : problemText(error),
      );
      return false;
    } finally {
      saving.set(false);
    }
  }
  async function add() {
    const entry = draft().trim();
    if (entry.length === 0) return;
    if (allow().includes(entry)) {
      draft.set("");
      return;
    }
    if (await save({ allow: [...allow(), entry], loopback: loopback() }))
      draft.set("");
  }

  const rowStyle = {
    ...row,
    minHeight: space[40],
    gap: space[16],
    paddingHorizontal: space[16],
    paddingVertical: space[8],
    borderBottomWidth: 1,
    borderColor: c().border,
  };
  return (
    <SmoothScroll style={grow} scrollbar={false}>
      <SectionHeader
        title={uiText("privateNetwork")}
        description={uiText("privateNetworkSubtitle")}
        phone={props.phone}
      />
      <If
        when={editable()}
        else={
          <View style={rowStyle}>
            <Label variant="small" tone="warning">
              {uiText("privateNetworkUnsupported")}
            </Label>
          </View>
        }
      >
        <If
          when={allow().length}
          else={
            <View style={rowStyle}>
              <Label variant="small" tone="muted">
                {uiText("privateNetworkNone")}
              </Label>
            </View>
          }
        >
          <Each of={allow()} key={(entry) => entry}>
            {(entry) => (
              <View style={{ ...rowStyle, gap: space[8] }}>
                <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                  <Label tone={invalid(entry()) ? "muted" : "ink"} lines={1}>
                    {entry()}
                  </Label>
                  <If when={invalid(entry())}>
                    {(reason) => (
                      <Label variant="small" tone="red">
                        {uiText("privateNetworkIgnored", {
                          reason: uiText(entryProblem[reason()]),
                        })}
                      </Label>
                    )}
                  </If>
                </View>
                <Button
                  label={uiText("privateNetworkRemove", { entry: entry() })}
                  icon="close"
                  iconOnly
                  tone="ghost"
                  disabled={saving()}
                  onPress={() =>
                    void save({
                      allow: allow().filter((item) => item !== entry()),
                      loopback: loopback(),
                    })
                  }
                />
              </View>
            )}
          </Each>
        </If>
        <View
          style={{
            gap: space[4],
            paddingHorizontal: space[16],
            paddingVertical: space[12],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...row, gap: space[8] }}>
            <Field
              label={uiText("privateNetworkAllowed")}
              value={draft()}
              placeholder={uiText("privateNetworkPlaceholder")}
              style={{ flex: 1, minWidth: 0 }}
              onChange={(value) => {
                draft.set(value);
                problem.set("");
              }}
              onSubmit={() => void add()}
            />
            <Button
              label={uiText("privateNetworkAdd")}
              icon="plus"
              size={control.lg}
              disabled={saving() || draft().trim().length === 0}
              onPress={() => void add()}
            />
          </View>
          <If
            when={problem()}
            else={
              <Label variant="small" tone="muted">
                {uiText("privateNetworkEntryHint")}
              </Label>
            }
          >
            <Label variant="small" tone="red">
              {problem()}
            </Label>
          </If>
        </View>
        <View style={rowStyle}>
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label>{uiText("privateNetworkLoopback")}</Label>
            <Label variant="small" tone="muted">
              {uiText("privateNetworkLoopbackHint")}
            </Label>
          </View>
          <ToggleSwitch
            label={uiText("privateNetworkLoopback")}
            checked={loopback()}
            disabled={saving()}
            onChange={(checked) =>
              void save({ allow: allow(), loopback: checked })
            }
          />
        </View>
        <View
          style={{
            gap: space[4],
            paddingHorizontal: space[16],
            paddingVertical: space[12],
          }}
        >
          <Label variant="small" tone="muted">
            {uiText("privateNetworkNote")}
          </Label>
          <Label variant="small" tone="muted">
            {uiText("privateNetworkApplies")}
          </Label>
        </View>
      </If>
    </SmoothScroll>
  );
}
