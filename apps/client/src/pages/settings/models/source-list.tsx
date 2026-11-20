import type {
  LlmAccounts,
  LlmConnection,
  LlmModel,
  ProviderCheck,
  ProviderSummary,
  ProvidersView,
} from "@eta/client-contracts";
import type { EntityStatus } from "../section";
import { keyMissing, providerLabel } from "@eta/client-contracts";
import { ActionItem, colors } from "../../../components";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { EntityRow, LetterBox } from "../section";
import { logoKey, useSourceLogos } from "./logos";

/** Every model source in one list: the gateway's accounts first, then the config's providers. */
export function useModelSources() {
  const host = useHost();
  const providers = () =>
    host.section<ProvidersView>("providers", "config")?.providers ?? [];
  const accounts = () =>
    host.section<LlmAccounts>("llm", "accounts")?.connections ?? [];
  const count = () => providers().length + accounts().length;
  return { providers, accounts, count };
}

export function ModelSourceList(props: {
  onProvider: (provider: ProviderSummary) => void;
}) {
  const host = useHost();
  const c = colors();
  const { providers, accounts } = useModelSources();
  const logo = useSourceLogos();
  const checks = () =>
    host.section<Record<string, ProviderCheck>>("providers", "checks") ?? {};
  const models = () => host.list<LlmModel>("llm", "models");
  const connector = (item: LlmConnection) =>
    host
      .section<LlmAccounts>("llm", "accounts")
      ?.connectors.find((entry) => entry.id === item.connector);
  const providerStatus = (item: ProviderSummary): EntityStatus => {
    const check = checks()[item.id];
    if (keyMissing(item))
      return { label: uiText("sourceNeedsKey"), color: c().amber };
    if (check?.state === "invalid_key")
      return { label: uiText("sourceKeyRefused"), color: c().red };
    if (check?.state === "unreachable")
      return { label: uiText("sourceUnreachable"), color: c().red };
    return { label: uiText("sourceWorking"), color: c().green };
  };
  const accountStatus = (item: LlmConnection): EntityStatus => {
    if (item.state === "disabled")
      return { label: uiText("sourceDisabled"), color: c().faint };
    if (item.state === "needs_login" || item.state === "error")
      return item.error?.code === "invalid_api_key"
        ? { label: uiText("sourceKeyRefused"), color: c().red }
        : { label: uiText("sourceNeedsLogin"), color: c().amber };
    return { label: uiText("sourceWorking"), color: c().green };
  };
  return (
    <>
      <Each of={accounts()} key={(item) => item.id}>
        {(item) => (
          <EntityRow
            title={connector(item())?.name ?? item().label}
            titleTone={item().state === "disabled" ? "muted" : "ink"}
            leading={
              <LetterBox
                name={connector(item())?.name ?? item().label}
                logo={logo(logoKey.connector(item().connector))}
              />
            }
            meta={uiText("sourceModelCount", {
              count: models().filter(
                (model) =>
                  model.connector === item().connector && model.available,
              ).length,
            })}
            status={accountStatus(item())}
            menuLabel={item().label}
            menu={
              <ActionItem
                label={
                  item().state === "disabled"
                    ? uiText("enable")
                    : uiText("disable")
                }
                onSelect={() =>
                  void host.action(() =>
                    host.call("llm", "setEnabled", {
                      id: item().id,
                      enabled: item().state === "disabled",
                    }),
                  )
                }
              />
            }
          />
        )}
      </Each>
      <Each of={providers()} key={(item) => item.id}>
        {(item) => (
          <EntityRow
            title={providerLabel(item())}
            leading={
              <LetterBox
                name={providerLabel(item())}
                logo={logo(logoKey.provider(item().id))}
              />
            }
            meta={uiText("sourceModelCount", { count: item().models.length })}
            status={providerStatus(item())}
            caret
            onPress={() => props.onProvider(item())}
          />
        )}
      </Each>
    </>
  );
}
