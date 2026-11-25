import type {
  LlmAccounts,
  LlmConnection,
  LlmModel,
  LlmQuota,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  grow,
  Label,
  row,
  SmoothScroll,
} from "../../../components";
import { showToast } from "../../../components/toast";
import { border, icon, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { LetterBox, PaneBack, SectionHeader } from "../section";
import { logoKey, useSourceLogos } from "./logos";

export function SubscriptionDetail(props: {
  connector: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const logo = useSourceLogos();
  const tab = signal<"models" | "connection">("models");
  const refreshing = signal(false);
  async function refresh() {
    if (refreshing() || !host.can("llm.refresh")) return;
    refreshing.set(true);
    const ok = await host.action(() => host.call("llm", "refresh", {}));
    refreshing.set(false);
    if (ok) showToast({ title: uiText("refreshList") });
  }
  const accounts = () => host.section<LlmAccounts>("llm", "accounts");
  const connections = () =>
    accounts()?.connections.filter(
      (item) => item.connector === props.connector,
    ) ?? [];
  const quota = () => host.section<LlmQuota[]>("llm", "quota");
  const models = () =>
    host
      .list<LlmModel>("llm", "models")
      .filter((item) => item.connector === props.connector);
  const name = () =>
    accounts()?.connectors.find((item) => item.id === props.connector)?.name ??
    props.connector;
  const accountName = (item: LlmConnection) => {
    const label =
      connections().filter((account) => account.label === item.label).length > 1
        ? `${item.label} (${item.id})`
        : item.label;
    const plan =
      quota()?.find(
        (q) =>
          q.connectionId === item.id && q.quotaRevision === item.quotaRevision,
      )?.plan || item.plan;
    return [label, plan, item.state].filter(Boolean).join(" · ");
  };
  return (
    <View style={grow}>
      <SectionHeader
        title={name()}
        leading={
          <>
            <PaneBack onPress={props.onClose} />
            <If when={props.phone}>
              <LetterBox
                name={name()}
                logo={logo(logoKey.connector(props.connector))}
              />
            </If>
          </>
        }
        phone={props.phone}
      >
        <If when={host.can("llm.refresh")}>
          <Button
            label={uiText("refreshList")}
            icon="refresh"
            spinIcon
            busy={refreshing()}
            iconOnly
            iconSize={icon.md}
            tone="ghost"
            onPress={() => void refresh()}
          />
        </If>
      </SectionHeader>
      <SmoothScroll style={grow} scrollbar={false}>
        <View
          role="tablist"
          style={{
            ...row,
            alignItems: "stretch",
            height: space[40],
            flexShrink: 0,
            gap: props.phone ? 0 : space[20],
            paddingHorizontal: props.phone ? 0 : space[16],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Each of={["models", "connection"] as const}>
            {(item) => (
              <View
                role="tab"
                accessibilityState={{ selected: tab() === item() }}
                accessibilityLabel={
                  item() === "models"
                    ? uiText("models2")
                    : uiText("sourceConnectionTab")
                }
                onPress={() => tab.set(item())}
                style={{
                  ...row,
                  gap: space[4],
                  ...(props.phone ? { flex: 1, justifyContent: "center" } : {}),
                  borderBottomWidth: border.thick,
                  borderColor: tab() === item() ? c().ink : "transparent",
                  cursor: "pointer",
                }}
              >
                <Label
                  weight={
                    tab() === item()
                      ? props.phone
                        ? weight.strong
                        : weight.regular
                      : weight.regular
                  }
                  tone={
                    tab() === item()
                      ? "ink"
                      : props.phone
                        ? "mutedInk"
                        : "muted"
                  }
                >
                  {item() === "models"
                    ? uiText("models2")
                    : uiText("sourceConnectionTab")}
                </Label>
                <If when={item() === "models" && !props.phone}>
                  <Label variant="small" tone="muted">
                    {models().length}
                  </Label>
                </If>
              </View>
            )}
          </Each>
        </View>
        <If
          when={tab() === "models"}
          else={
            <Each of={connections()} key={(item) => item.id}>
              {(item) => (
                <Label style={{ padding: space[16] }}>
                  {accountName(item())}
                </Label>
              )}
            </Each>
          }
        >
          <Label
            weight={weight.strong}
            style={{ padding: space[16] }}
          >{`${uiText("models2")} ${models().length}`}</Label>
          <Each of={models()} key={(item) => item.id}>
            {(model) => (
              <Label
                style={{
                  paddingHorizontal: space[16],
                  paddingVertical: space[8],
                }}
              >
                {model().name}
              </Label>
            )}
          </Each>
        </If>
      </SmoothScroll>
    </View>
  );
}
