import type {
  RoutineTriggerMode,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type { ViewStyle } from "nsh";
import type { TriggerConfigField } from "./trigger-config";
import { safeArea, View } from "nsh";
import { Select } from "nsh/base";
import {
  Button,
  colors,
  Field,
  focusRing,
  fontFamily,
  Fonts,
  Icon,
  Label,
  monoFontFamily,
  row,
  textFaces,
  textStyle,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import {
  canHover,
  MenuFrame,
  MenuRow,
  touchRow,
  touchScreen,
} from "../../components/menu";
import { screenInsets } from "../../components/safe-area";
import { groupHeaderStyle } from "../../components/theme";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { Badge, Callout, ToggleSwitch } from "../../ui";
import {
  formatTriggerConfigSummary,
  providerLabel,
  triggerModeLabel,
} from "./schedule";
import { enumSelectionValue, validateTriggerField } from "./trigger-config";

const selectMenuWidth = { phone: 240, tablet: 220, desktop: 220 } as const;
const optionHeight = { tablet: 36, desktop: 32 } as const;
const popupWidth = 360;
const popupHeight = 312;
const searchHeight = 36;
const sheetRowHeight = 52;
const sheetMaxHeight = "80%";
const multilineFieldHeight = 76;
const pollingFieldWidth = { sheet: 140, tablet: 112, desktop: 120 } as const;

export interface EditorSelectOption {
  label: string;
  checked: boolean;
  onSelect: () => void;
}

/**
 * The phone form's select: a 44pt trigger, opening the design's titled
 * bottom sheet of 48pt rows with the selected one tinted.
 */
export function PhoneSelect(props: {
  label: string;
  title: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  options: EditorSelectOption[];
  triggerStyle?: ViewStyle;
}) {
  const c = colors();
  const hasValue = () => props.value !== "";
  return (
    <MenuFrame
      disabled={props.disabled}
      popupStyle={{
        width: selectMenuWidth.phone,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      sheetStyle={{ paddingBottom: space[24] }}
      sheetHeader={
        <View
          style={{
            ...row,
            height: control.touch,
            paddingHorizontal: space[16],
          }}
        >
          <Label weight={weight.strong}>{props.title}</Label>
        </View>
      }
      trigger={
        <View
          accessibilityLabel={props.label}
          hoverStyle={
            canHover && !props.disabled
              ? { backgroundColor: c().selected }
              : undefined
          }
          focusVisibleStyle={focusRing(c(), "inset")}
          style={{
            ...row,
            height: control.touch,
            gap: space[8],
            paddingHorizontal: space[12],
            cursor: props.disabled ? "default" : "pointer",
            borderWidth: 1,
            borderColor: c().border,
            backgroundColor: c().canvas,
            ...props.triggerStyle,
          }}
        >
          <Label
            lines={1}
            tone={hasValue() ? "ink" : "muted"}
            style={{ flex: 1, minWidth: 0 }}
          >
            {hasValue() ? props.value : (props.placeholder ?? "")}
          </Label>
          <Icon name="down" size={icon.md} tone="muted" />
        </View>
      }
    >
      <Each of={props.options}>
        {(option) => (
          <MenuRow
            role="menuitemradio"
            checked={option().checked}
            label={option().label}
            style={{
              ...row,
              height: space[48],
              flexShrink: 0,
              paddingHorizontal: space[16],
              borderTopWidth: 1,
              borderColor: c().border,
              backgroundColor: option().checked ? c().selected : undefined,
            }}
            onSelect={option().onSelect}
          >
            <Label style={{ flex: 1 }}>{option().label}</Label>
            <View
              style={{ width: space[16], height: space[16], flexShrink: 0 }}
            >
              <If when={option().checked}>
                <Icon name="check" size={icon.md} />
              </If>
            </View>
          </MenuRow>
        )}
      </Each>
    </MenuFrame>
  );
}

/**
 * The form's selects. In the tablet and desktop layouts they open as the
 * design's popover under the trigger's left edge, whatever the platform;
 * the phone form has its own titled sheet.
 */
export function EditorSelect(props: {
  label: string;
  /** The phone sheet's title. */
  title?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  options: EditorSelectOption[];
  tablet?: boolean;
  phone?: boolean;
  triggerStyle?: ViewStyle;
}) {
  const c = colors();
  const hasValue = () => props.value !== "";
  return (
    <If
      when={!props.phone}
      else={
        <PhoneSelect
          label={props.label}
          title={props.title ?? props.label}
          value={props.value}
          placeholder={props.placeholder}
          disabled={props.disabled}
          options={props.options}
          triggerStyle={props.triggerStyle}
        />
      }
    >
      <MenuFrame
        disabled={props.disabled}
        popupStyle={{
          width: props.tablet
            ? selectMenuWidth.tablet
            : selectMenuWidth.desktop,
          borderWidth: 1,
          borderColor: c().strong,
          backgroundColor: c().canvas,
        }}
        trigger={
          <View
            accessibilityLabel={props.label}
            hitSlop={touchScreen ? space[8] : undefined}
            hoverStyle={
              canHover && !props.disabled
                ? { backgroundColor: c().selected }
                : undefined
            }
            focusVisibleStyle={focusRing(c(), "inset")}
            style={{
              ...row,
              justifyContent: "space-between",
              gap: props.tablet ? space[12] : space[8],
              cursor: props.disabled ? "default" : "pointer",
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().canvas,
              ...props.triggerStyle,
            }}
          >
            <Label
              variant="small"
              tone={hasValue() ? "ink" : "muted"}
              lines={1}
              style={{ flex: 1, minWidth: 0 }}
            >
              {hasValue() ? props.value : (props.placeholder ?? "")}
            </Label>
            <Icon
              name="down"
              size={icon.sm}
              tone={props.tablet ? "ink" : "muted"}
            />
          </View>
        }
      >
        <Each of={props.options}>
          {(option) => (
            <MenuRow
              role="menuitemradio"
              checked={option().checked}
              label={option().label}
              style={{
                ...row,
                height: touchScreen
                  ? touchRow
                  : props.tablet
                    ? optionHeight.tablet
                    : optionHeight.desktop,
                gap: space[8],
                paddingHorizontal: space[12],
                backgroundColor: option().checked ? c().selected : undefined,
              }}
              onSelect={option().onSelect}
            >
              <Label variant="small" lines={1} style={{ flex: 1 }}>
                {option().label}
              </Label>
              <View
                style={{ width: space[12], height: space[12], flexShrink: 0 }}
              >
                <If when={option().checked}>
                  <Icon name="check" size={icon.sm} />
                </If>
              </View>
            </MenuRow>
          )}
        </Each>
      </MenuFrame>
    </If>
  );
}

interface SearchableChoice {
  value: string;
  title: string;
  subtitle?: string;
  description?: string;
  group?: string;
}

function TriggerSearchSelect(props: {
  label: string;
  placeholder: string;
  searchPlaceholder: string;
  searchLabel: string;
  emptyText: string;
  items: SearchableChoice[];
  value: string | null;
  phone: boolean;
  disabled?: boolean;
  triggerStyle?: ViewStyle;
  onChange: (value: string) => void;
}) {
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();
  const surfaceInsets = screenInsets();
  const bottomInset = () => Math.max(safeArea().bottom, surfaceInsets().bottom);
  const selectedItem = () =>
    props.items.find((item) => item.value === props.value);
  return (
    <Select
      accessibilityLabel={props.label}
      items={props.items.map((item) => ({
        value: item.value,
        title: item.title,
        group: item.group,
      }))}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      searchable
      searchPlaceholder={props.searchPlaceholder}
      searchAccessibilityLabel={props.searchLabel}
      cover={false}
      offset={2}
      backdropStyle={
        props.phone ? { backgroundColor: c().sheetScrim } : undefined
      }
      popupStyle={
        props.phone
          ? {
              width: "100%",
              borderWidth: 0,
              borderTopWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
              maxHeight: sheetMaxHeight,
              paddingBottom: space[8] + bottomInset(),
            }
          : {
              minWidth: popupWidth,
              borderWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
              maxHeight: popupHeight,
            }
      }
      searchStyle={{
        color: c().ink,
        placeholderColor: c().muted,
        fontFamily: fontFamily(fonts().interface),
        ...textStyle(type("small")),
        paddingHorizontal: props.phone ? space[16] : space[12],
        height: props.phone ? control.touch : searchHeight,
        backgroundColor: "transparent",
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
      groupStyle={{
        ...groupHeaderStyle(type("caption"), fonts(), c()),
        paddingHorizontal: props.phone ? space[16] : space[12],
        paddingTop: space[8],
        paddingBottom: space[4],
      }}
      itemClass={`focus:bg-[${c().selected}]`}
      itemStyle={{
        minHeight: props.phone
          ? sheetRowHeight
          : touchScreen
            ? touchRow
            : control.md,
        paddingHorizontal: 0,
        color: c().ink,
        fontFamily: fontFamily(fonts().interface),
        fontSize: type("small").size,
      }}
      empty={
        <View
          style={{
            alignItems: "center",
            paddingVertical: space[24],
            paddingHorizontal: space[12],
          }}
        >
          <Label variant="small" tone="muted">
            {props.emptyText}
          </Label>
        </View>
      }
      renderItem={(item) => {
        const entry = props.items.find((choice) => choice.value === item.value);
        const chosen = item.value === props.value;
        return (
          <View
            testID={`trigger-search-item-${item.value}`}
            hoverStyle={
              canHover ? { backgroundColor: c().selected } : undefined
            }
            activeStyle={{ backgroundColor: c().selected }}
            style={{
              ...row,
              flex: 1,
              minHeight: props.phone
                ? sheetRowHeight
                : touchScreen
                  ? touchRow
                  : control.md,
              gap: props.phone ? space[12] : space[8],
              paddingVertical: space[4],
              paddingHorizontal: props.phone ? space[16] : space[12],
              ...(props.phone
                ? { borderTopWidth: 1, borderColor: c().border }
                : {}),
              backgroundColor: chosen ? c().selected : "transparent",
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
              <Label variant="small" lines={1}>
                {item.title}
              </Label>
              <If when={entry?.subtitle}>
                {(sub) => (
                  <Label variant="caption" tone="muted" lines={1}>
                    {sub()}
                  </Label>
                )}
              </If>
              <If when={entry?.description}>
                {(desc) => (
                  <Label variant="caption" tone="muted" lines={2}>
                    {desc()}
                  </Label>
                )}
              </If>
            </View>
            <View
              style={{ width: space[12], height: space[12], flexShrink: 0 }}
            >
              <If when={chosen}>
                <Icon name="check" size={icon.sm} />
              </If>
            </View>
          </View>
        );
      }}
      trigger={
        <View
          hoverStyle={
            canHover && !props.disabled
              ? { backgroundColor: c().selected }
              : undefined
          }
          focusVisibleStyle={focusRing(c(), "inset")}
          style={{
            ...row,
            justifyContent: "space-between",
            gap: space[8],
            paddingHorizontal: space[8],
            borderWidth: 1,
            borderColor: c().border,
            backgroundColor: c().canvas,
            cursor: props.disabled ? "default" : "pointer",
            ...props.triggerStyle,
          }}
        >
          <Label
            variant={props.phone ? "body" : "small"}
            tone={selectedItem() ? "ink" : "muted"}
            lines={1}
            style={{ flex: 1, minWidth: 0 }}
          >
            {selectedItem()?.title ?? props.placeholder}
          </Label>
          <Icon
            name="down"
            size={props.phone ? icon.md : icon.sm}
            tone="muted"
          />
        </View>
      }
      onChange={({ value }) => {
        if (value) props.onChange(value);
      }}
    />
  );
}

function ProviderStatusNotice(props: {
  provider: TriggerProviderStatus;
  onOpenPlugins?: () => void;
  onOpenPluginSettings?: () => void;
}) {
  const name = () => providerLabel(props.provider.provider);
  const settingsAction = () =>
    props.onOpenPluginSettings ?? props.onOpenPlugins;
  const pluginsAction = () => props.onOpenPlugins ?? props.onOpenPluginSettings;
  const details = () => {
    switch (props.provider.status) {
      case "needs_key":
        return {
          tone: "warning" as const,
          icon: "warning" as const,
          title: uiText("triggerProviderNeedsKey", { provider: name() }),
          description: uiText("triggerProviderNeedsKeyHint"),
          actionLabel: settingsAction()
            ? uiText("openPluginSettings")
            : undefined,
          onAction: settingsAction(),
        };
      case "key_rejected":
        return {
          tone: "danger" as const,
          icon: "warning" as const,
          title: uiText("triggerProviderKeyRejected", { provider: name() }),
          description:
            props.provider.error?.trim() ||
            uiText("triggerProviderKeyRejectedHint"),
          actionLabel: settingsAction()
            ? uiText("openPluginSettings")
            : undefined,
          onAction: settingsAction(),
        };
      case "disabled":
        return {
          tone: "neutral" as const,
          icon: "plugins" as const,
          title: uiText("triggerProviderDisabled", { provider: name() }),
          description: uiText("triggerProviderDisabledHint"),
          actionLabel: settingsAction()
            ? uiText("openPluginSettings")
            : undefined,
          onAction: settingsAction(),
        };
      case "error":
        return {
          tone: "danger" as const,
          icon: "warning" as const,
          title: uiText("triggerProviderError", { provider: name() }),
          description:
            props.provider.error?.trim() || uiText("triggerProviderErrorHint"),
          actionLabel: pluginsAction() ? uiText("openPlugins") : undefined,
          onAction: pluginsAction(),
        };
      case "ready":
        return null;
    }
  };
  return (
    <If when={details()}>
      {(info) => (
        <Callout
          tone={info().tone}
          icon={info().icon}
          title={info().title}
          description={info().description}
          actions={
            info().onAction && info().actionLabel ? (
              <Button
                label={info().actionLabel!}
                size={control.sm}
                onPress={info().onAction!}
              />
            ) : undefined
          }
        />
      )}
    </If>
  );
}

export function TriggerSection(props: {
  phone: boolean;
  sheet: boolean;
  tablet: boolean;
  controlHeight: number;
  controlInset: number;
  catalogLoading: boolean;
  catalogLoaded: boolean;
  catalogError: string;
  triggers: TriggerCatalogItem[];
  providers: TriggerProviderStatus[];
  provider: string;
  source: string;
  triggerSlug: string;
  accountId: string | null;
  mode: RoutineTriggerMode | null;
  pollingIntervalText: string;
  pollingError: string;
  config: Record<string, unknown>;
  drafts: Record<string, string>;
  touched: Record<string, boolean>;
  fields: TriggerConfigField[];
  selectedItem: TriggerCatalogItem | undefined;
  editingExisting: boolean;
  onRefresh: () => void;
  onSelectProvider: (provider: string) => void;
  onSelectSource: (source: string) => void;
  onSelectTrigger: (item: TriggerCatalogItem) => void;
  onSelectAccount: (accountId: string) => void;
  onSelectMode: (mode: RoutineTriggerMode) => void;
  onChangePollingInterval: (text: string) => void;
  onChangeConfig: (key: string, value: unknown) => void;
  onChangeDraft: (key: string, text: string) => void;
  onBlurField: (key: string) => void;
  onOpenPlugins?: () => void;
  onOpenPluginSettings?: () => void;
}) {
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();

  const selectStyle = () =>
    props.sheet
      ? { height: control.touch, paddingHorizontal: props.controlInset }
      : {
          height: props.controlHeight,
          paddingHorizontal: props.controlInset,
          gap: space[8],
          borderColor: c().border,
        };

  const inputStyle = (extra?: ViewStyle) => ({
    height: props.controlHeight,
    paddingHorizontal: props.controlInset,
    ...textStyle(type("small")),
    ...extra,
  });

  const providerIds = () => {
    const ids = new Set<string>();
    for (const item of props.triggers) ids.add(item.provider);
    for (const status of props.providers) ids.add(status.provider);
    if (props.provider) ids.add(props.provider);
    return [...ids].sort((a, b) => a.localeCompare(b));
  };

  const sourceChoices = (): SearchableChoice[] => {
    if (!props.provider) return [];
    const seen = new Map<string, string>();
    for (const item of props.triggers) {
      if (item.provider !== props.provider) continue;
      if (!seen.has(item.source)) {
        seen.set(item.source, item.sourceName || item.source);
      }
    }
    if (props.source && !seen.has(props.source)) {
      seen.set(props.source, props.source);
    }
    return [...seen.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([slug, name]) => ({
        value: slug,
        title: name,
        subtitle: name !== slug ? slug : undefined,
      }));
  };

  const triggerChoices = (): SearchableChoice[] => {
    if (!props.provider || !props.source) return [];
    const matched = props.triggers.filter(
      (item) =>
        item.provider === props.provider && item.source === props.source,
    );
    const list: SearchableChoice[] = matched.map((item) => ({
      value: item.trigger,
      title: item.name || item.trigger,
      subtitle: item.name !== item.trigger ? item.trigger : undefined,
      description: item.description || undefined,
    }));
    if (
      props.triggerSlug &&
      !matched.some((item) => item.trigger === props.triggerSlug)
    ) {
      list.unshift({
        value: props.triggerSlug,
        title: props.triggerSlug,
      });
    }
    return list;
  };

  const nonReadyProviders = () =>
    props.providers.filter((item) => item.status !== "ready");

  const visibleProviderIssues = () => {
    if (props.triggers.length === 0) return nonReadyProviders();
    if (!props.provider) return [];
    return nonReadyProviders().filter(
      (item) => item.provider === props.provider,
    );
  };

  const accounts = () => props.selectedItem?.accounts ?? [];
  const accountOptions = () => {
    const list = accounts().map((account) => ({
      id: account.id,
      label:
        account.label && account.label !== account.id
          ? `${account.label} (${account.id})`
          : account.id,
    }));
    if (
      props.accountId &&
      !list.some((account) => account.id === props.accountId)
    ) {
      list.unshift({ id: props.accountId, label: props.accountId });
    }
    return list;
  };

  const availableModes = (): RoutineTriggerMode[] =>
    props.selectedItem?.modes.length
      ? props.selectedItem.modes
      : props.mode
        ? [props.mode]
        : [];

  const effectiveMode = (): RoutineTriggerMode | null =>
    props.mode ?? (availableModes().length === 1 ? availableModes()[0]! : null);

  const showPolling = () =>
    effectiveMode() === "poll" ||
    (effectiveMode() !== "webhook" && props.pollingIntervalText.trim() !== "");

  const pluginsAction = () => props.onOpenPlugins ?? props.onOpenPluginSettings;

  const hasReadyProvider = () =>
    props.providers.length === 0 ||
    props.providers.some((item) => item.status === "ready");

  const selectedProviderHasNoSources = () =>
    Boolean(props.provider) &&
    sourceChoices().length === 0 &&
    visibleProviderIssues().length === 0 &&
    !props.editingExisting;

  const showNoTriggersNotice = () =>
    props.catalogLoaded &&
    !props.catalogLoading &&
    !props.catalogError &&
    ((props.triggers.length === 0 && hasReadyProvider()) ||
      (props.triggers.length > 0 && selectedProviderHasNoSources()));

  const showAccountSelect = () =>
    accounts().length > 1 ||
    ((props.catalogLoaded || !props.editingExisting) &&
      Boolean(props.accountId) &&
      !accounts().some((account) => account.id === props.accountId));

  const sourceInCatalog = () =>
    Boolean(props.source) &&
    props.triggers.some(
      (item) =>
        item.provider === props.provider && item.source === props.source,
    );

  const showSourceSelect = () =>
    Boolean(props.provider) &&
    (sourceChoices().length > 1 ||
      (props.editingExisting &&
        (props.catalogLoaded || Boolean(props.catalogError)) &&
        Boolean(props.source) &&
        !sourceInCatalog()));

  const triggerInCatalog = () =>
    Boolean(props.triggerSlug) &&
    props.triggers.some(
      (item) =>
        item.provider === props.provider &&
        item.source === props.source &&
        item.trigger === props.triggerSlug,
    );

  const showTriggerSelect = () =>
    Boolean(props.provider && props.source) &&
    (triggerChoices().length > 1 ||
      (props.editingExisting &&
        (props.catalogLoaded || Boolean(props.catalogError)) &&
        Boolean(props.triggerSlug) &&
        !triggerInCatalog()));

  const missingInCatalog = () =>
    props.catalogLoaded &&
    !props.catalogLoading &&
    !props.catalogError &&
    props.editingExisting &&
    Boolean(props.triggerSlug) &&
    !props.selectedItem;

  const fieldError = (field: TriggerConfigField) => {
    const err = validateTriggerField(
      field,
      props.config,
      props.drafts,
      props.provider,
    );
    if (!err) return "";
    const emptyRequired =
      err === uiText("triggerFieldEnterValue") ||
      err === uiText("triggerFieldArrayRequired");
    if (emptyRequired && !props.touched[field.key]) return "";
    return err;
  };

  return (
    <View
      style={{
        gap: space[12],
        padding: space[12],
        borderWidth: 1,
        borderColor: c().border,
        backgroundColor: c().canvas,
      }}
    >
      <View style={{ ...row, justifyContent: "space-between", gap: space[8] }}>
        <Label variant="small" weight={weight.strong}>
          {uiText("eventTrigger")}
        </Label>
        <Button
          label={uiText("refreshTriggers")}
          icon="refresh"
          spinIcon
          busy={props.catalogLoading}
          size={control.sm}
          tone="ghost"
          onPress={props.onRefresh}
        />
      </View>

      <If when={props.catalogLoading && !props.catalogLoaded}>
        <EmptyState
          size="row"
          status="loading"
          loading={uiText("loadingTriggers")}
          error={null}
          empty={{ title: "" }}
          style={{ paddingHorizontal: 0, paddingVertical: space[4] }}
        />
      </If>

      <If when={props.catalogError}>
        <Callout
          tone="danger"
          icon="warning"
          title={uiText("triggersDidNotLoad")}
          description={props.catalogError}
          actions={
            <Button
              label={uiText("retry")}
              size={control.sm}
              onPress={props.onRefresh}
            />
          }
        />
      </If>

      <Each of={visibleProviderIssues()} key={(item) => item.provider}>
        {(item) => (
          <ProviderStatusNotice
            provider={item()}
            onOpenPlugins={props.onOpenPlugins}
            onOpenPluginSettings={props.onOpenPluginSettings}
          />
        )}
      </Each>

      <If when={showNoTriggersNotice()}>
        <Callout
          tone="warning"
          icon="plugins"
          title={uiText("noTriggersAvailable")}
          description={uiText("noTriggersAvailableHint")}
          actions={
            pluginsAction() ? (
              <Button
                label={uiText("openPlugins")}
                size={control.sm}
                onPress={pluginsAction()!}
              />
            ) : undefined
          }
        />
      </If>

      <If
        when={
          providerIds().length > 0 &&
          (props.triggers.length > 0 || props.editingExisting)
        }
      >
        <View style={{ gap: space[12] }}>
          <View style={{ gap: space[4] }}>
            <Label variant="small" tone={props.sheet ? "mutedInk" : undefined}>
              {uiText("triggerProvider")}
            </Label>
            <EditorSelect
              label={uiText("triggerProvider")}
              value={props.provider ? providerLabel(props.provider) : ""}
              placeholder={uiText("selectTriggerProvider")}
              tablet={props.tablet}
              phone={props.phone}
              triggerStyle={selectStyle()}
              options={providerIds().map((id) => ({
                label: providerLabel(id),
                checked: props.provider === id,
                onSelect: () => props.onSelectProvider(id),
              }))}
            />
          </View>

          <If when={showSourceSelect()}>
            <View style={{ gap: space[4] }}>
              <Label
                variant="small"
                tone={props.sheet ? "mutedInk" : undefined}
              >
                {uiText("triggerSource")}
              </Label>
              <TriggerSearchSelect
                label={uiText("triggerSource")}
                placeholder={uiText("selectTriggerSource")}
                searchPlaceholder={uiText("searchTriggerSources")}
                searchLabel={uiText("searchTriggerSources")}
                emptyText={uiText("noTriggerSourcesMatch")}
                items={sourceChoices()}
                value={props.source || null}
                phone={props.phone}
                triggerStyle={selectStyle()}
                onChange={props.onSelectSource}
              />
            </View>
          </If>

          <If when={showTriggerSelect()}>
            <View style={{ gap: space[4] }}>
              <Label
                variant="small"
                tone={props.sheet ? "mutedInk" : undefined}
              >
                {uiText("triggerType")}
              </Label>
              <TriggerSearchSelect
                label={uiText("triggerType")}
                placeholder={uiText("selectTriggerType")}
                searchPlaceholder={uiText("searchTriggers")}
                searchLabel={uiText("searchTriggers")}
                emptyText={uiText("noTriggersMatch")}
                items={triggerChoices()}
                value={props.triggerSlug || null}
                phone={props.phone}
                triggerStyle={selectStyle()}
                onChange={(slug) => {
                  const found = props.triggers.find(
                    (item) =>
                      item.provider === props.provider &&
                      item.source === props.source &&
                      item.trigger === slug,
                  );
                  if (found) props.onSelectTrigger(found);
                }}
              />
            </View>
          </If>
        </View>
      </If>

      <If when={props.selectedItem}>
        {(item) => (
          <View
            style={{
              gap: space[4],
              padding: space[8],
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
            }}
          >
            <View
              style={{
                ...row,
                gap: space[8],
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <Label variant="small" weight={weight.strong}>
                {item().name}
              </Label>
              <Label
                variant="caption"
                tone="muted"
                style={{ fontFamily: monoFontFamily(fonts()) }}
              >
                {item().trigger}
              </Label>
              <If when={effectiveMode()}>
                {(mode) => (
                  <Badge
                    label={triggerModeLabel(mode())}
                    size="caption"
                    tone="neutral"
                  />
                )}
              </If>
            </View>
            <If when={item().description}>
              <Label variant="caption" tone="muted">
                {item().description}
              </Label>
            </If>
            <If when={item().instructions}>
              <Label variant="caption" tone="mutedInk">
                {item().instructions!}
              </Label>
            </If>
            <If
              when={
                item().requiresWebhookSetup && effectiveMode() === "webhook"
              }
            >
              <Label variant="caption" tone="warningInk">
                {uiText("triggerWebhookNote")}
              </Label>
            </If>
          </View>
        )}
      </If>

      <If when={missingInCatalog()}>
        <Callout
          tone="warning"
          icon="warning"
          title={uiText("triggerUnavailableInCatalog")}
          description={`${props.provider} / ${props.source} / ${props.triggerSlug}`}
        />
      </If>

      <If when={showAccountSelect()}>
        <View style={{ gap: space[4] }}>
          <View style={{ ...row, gap: space[4], alignItems: "baseline" }}>
            <Label variant="small" tone={props.sheet ? "mutedInk" : undefined}>
              {uiText("triggerAccount")}
            </Label>
            <If when={accounts().length > 1}>
              <Label variant="caption" tone="muted">
                {uiText("triggerFieldRequired")}
              </Label>
            </If>
          </View>
          <EditorSelect
            label={uiText("triggerAccount")}
            value={
              accountOptions().find((item) => item.id === props.accountId)
                ?.label ?? ""
            }
            placeholder={uiText("selectTriggerAccount")}
            tablet={props.tablet}
            phone={props.phone}
            triggerStyle={selectStyle()}
            options={accountOptions().map((account) => ({
              label: account.label,
              checked: props.accountId === account.id,
              onSelect: () => props.onSelectAccount(account.id),
            }))}
          />
          <If when={accounts().length > 1 && !props.accountId}>
            <Label variant="caption" tone="muted">
              {uiText("triggerAccountRequired")}
            </Label>
          </If>
        </View>
      </If>

      <If when={availableModes().length > 1}>
        <View style={{ gap: space[4] }}>
          <Label variant="small" tone={props.sheet ? "mutedInk" : undefined}>
            {uiText("triggerDeliveryMode")}
          </Label>
          <EditorSelect
            label={uiText("triggerDeliveryMode")}
            value={
              effectiveMode() === "webhook"
                ? uiText("triggerModeWebhook")
                : effectiveMode() === "poll"
                  ? uiText("triggerModePoll")
                  : ""
            }
            placeholder={uiText("triggerDeliveryMode")}
            tablet={props.tablet}
            phone={props.phone}
            triggerStyle={selectStyle()}
            options={availableModes().map((mode) => ({
              label:
                mode === "webhook"
                  ? uiText("triggerModeWebhook")
                  : uiText("triggerModePoll"),
              checked: effectiveMode() === mode,
              onSelect: () => props.onSelectMode(mode),
            }))}
          />
        </View>
      </If>

      <If when={showPolling()}>
        <View style={{ gap: space[4] }}>
          <Label variant="small" tone={props.sheet ? "mutedInk" : undefined}>
            {props.provider === "file-watch"
              ? uiText("triggerFileWatchPollingInterval")
              : uiText("triggerPollingInterval")}
          </Label>
          <Field
            label={
              props.provider === "file-watch"
                ? uiText("triggerFileWatchPollingInterval")
                : uiText("triggerPollingInterval")
            }
            placeholder={
              props.provider === "rss" || props.provider === "web-monitor"
                ? "15"
                : "5"
            }
            value={props.pollingIntervalText}
            invalid={Boolean(props.pollingError)}
            onChange={props.onChangePollingInterval}
            style={inputStyle({
              width: props.sheet
                ? pollingFieldWidth.sheet
                : props.tablet
                  ? pollingFieldWidth.tablet
                  : pollingFieldWidth.desktop,
            })}
          />
          <Label variant="caption" tone={props.pollingError ? "red" : "muted"}>
            {props.pollingError ||
              (props.provider === "file-watch"
                ? uiText("triggerFileWatchPollingHint")
                : uiText("triggerPollingIntervalHint"))}
          </Label>
        </View>
      </If>

      <If when={props.selectedItem && props.fields.length === 0}>
        <Label variant="caption" tone="muted">
          {uiText("triggerNoConfigNeeded")}
        </Label>
      </If>

      <If
        when={
          props.catalogLoaded &&
          !props.catalogLoading &&
          !props.selectedItem &&
          Object.keys(props.config).length > 0
        }
      >
        <Label variant="caption" tone="muted">
          {formatTriggerConfigSummary(props.config)}
        </Label>
      </If>

      <If when={props.fields.length > 0}>
        <View style={{ gap: space[12], paddingTop: space[4] }}>
          <Label variant="small" weight={weight.strong}>
            {uiText("triggerConfigHeading")}
          </Label>
          <Each of={props.fields} key={(field) => field.key}>
            {(field) => {
              const spec = () => field();
              const err = () => fieldError(spec());
              return (
                <View style={{ gap: space[4] }}>
                  <If
                    when={spec().kind === "boolean"}
                    else={
                      <>
                        <View
                          style={{
                            ...row,
                            gap: space[4],
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <Label
                            variant="small"
                            tone={props.sheet ? "mutedInk" : undefined}
                          >
                            {spec().title}
                          </Label>
                          <Label variant="caption" tone="muted">
                            {spec().required
                              ? uiText("triggerFieldRequired")
                              : uiText("triggerFieldOptional")}
                          </Label>
                          <If when={spec().deprecated}>
                            <Badge
                              label={uiText("triggerDeprecated")}
                              tone="warning"
                              size="caption"
                            />
                          </If>
                        </View>
                        <If when={spec().description}>
                          <Label variant="caption" tone="muted">
                            {spec().description}
                          </Label>
                        </If>
                        <If
                          when={spec().kind === "enum"}
                          else={
                            <If
                              when={
                                spec().kind === "array" &&
                                (spec().arrayOptions?.length ?? 0) > 0
                              }
                              else={
                                <Field
                                  label={spec().title}
                                  placeholder={
                                    spec().placeholder ||
                                    (spec().kind === "object"
                                      ? '{"key": "value"}'
                                      : spec().kind === "array"
                                        ? spec().arrayItemKind === "other"
                                          ? '["item"]'
                                          : "a, b"
                                        : "")
                                  }
                                  masked={spec().secret}
                                  multiline={
                                    spec().multiline || spec().kind === "object"
                                  }
                                  invalid={Boolean(err())}
                                  value={
                                    spec().kind === "number" ||
                                    spec().kind === "integer" ||
                                    spec().kind === "array" ||
                                    spec().kind === "object"
                                      ? Object.hasOwn(props.drafts, spec().key)
                                        ? (props.drafts[spec().key] ?? "")
                                        : props.config[spec().key] !== undefined
                                          ? String(props.config[spec().key])
                                          : ""
                                      : typeof props.config[spec().key] ===
                                          "string"
                                        ? String(props.config[spec().key])
                                        : props.config[spec().key] !==
                                              undefined &&
                                            props.config[spec().key] !== null
                                          ? String(props.config[spec().key])
                                          : ""
                                  }
                                  onBlur={() => props.onBlurField(spec().key)}
                                  onChange={(text) => {
                                    if (
                                      spec().kind === "number" ||
                                      spec().kind === "integer" ||
                                      spec().kind === "array" ||
                                      spec().kind === "object"
                                    ) {
                                      props.onChangeDraft(spec().key, text);
                                    } else {
                                      props.onChangeConfig(spec().key, text);
                                    }
                                  }}
                                  style={
                                    spec().multiline || spec().kind === "object"
                                      ? {
                                          height: multilineFieldHeight,
                                          paddingVertical: space[8],
                                          paddingHorizontal: props.controlInset,
                                          ...textStyle(type("small"), "prose"),
                                        }
                                      : inputStyle()
                                  }
                                />
                              }
                            >
                              <View style={{ gap: space[8] }}>
                                <View
                                  style={{
                                    ...row,
                                    gap: space[8],
                                    flexWrap: "wrap",
                                  }}
                                >
                                  <Each
                                    of={spec().arrayOptions ?? []}
                                    key={(opt) => opt.value}
                                  >
                                    {(opt) => {
                                      const selected = () => {
                                        const current =
                                          props.config[spec().key];
                                        return (
                                          Array.isArray(current) &&
                                          current.some((item) =>
                                            Object.is(item, opt().raw),
                                          )
                                        );
                                      };
                                      return (
                                        <View
                                          role="checkbox"
                                          accessibilityLabel={`${spec().title}: ${opt().label}`}
                                          accessibilityState={{
                                            checked: selected(),
                                          }}
                                          hoverStyle={
                                            canHover
                                              ? {
                                                  backgroundColor: c().selected,
                                                }
                                              : undefined
                                          }
                                          activeStyle={{
                                            backgroundColor: c().selected,
                                          }}
                                          focusVisibleStyle={focusRing(
                                            c(),
                                            "inset",
                                          )}
                                          onPress={() => {
                                            const current = Array.isArray(
                                              props.config[spec().key],
                                            )
                                              ? [
                                                  ...(props.config[
                                                    spec().key
                                                  ] as unknown[]),
                                                ]
                                              : [];
                                            const next = selected()
                                              ? current.filter(
                                                  (item) =>
                                                    !Object.is(item, opt().raw),
                                                )
                                              : [...current, opt().raw];
                                            props.onBlurField(spec().key);
                                            props.onChangeConfig(
                                              spec().key,
                                              next.length > 0
                                                ? next
                                                : undefined,
                                            );
                                          }}
                                          style={{
                                            ...row,
                                            gap: space[8],
                                            minHeight: props.sheet
                                              ? control.touch
                                              : control.md,
                                            paddingHorizontal: space[12],
                                            paddingVertical: space[4],
                                            borderWidth: 1,
                                            borderColor: selected()
                                              ? c().strong
                                              : c().border,
                                            backgroundColor: selected()
                                              ? c().selected
                                              : c().canvas,
                                          }}
                                        >
                                          <View
                                            style={{
                                              width: space[12],
                                              height: space[12],
                                              flexShrink: 0,
                                            }}
                                          >
                                            <If when={selected()}>
                                              <Icon
                                                name="check"
                                                size={icon.sm}
                                              />
                                            </If>
                                          </View>
                                          <Label variant="small">
                                            {opt().label}
                                          </Label>
                                        </View>
                                      );
                                    }}
                                  </Each>
                                </View>
                                <If
                                  when={
                                    !spec().required &&
                                    Array.isArray(props.config[spec().key]) &&
                                    (props.config[spec().key] as unknown[])
                                      .length > 0
                                  }
                                >
                                  <View style={{ alignItems: "flex-start" }}>
                                    <Button
                                      label={uiText("clear")}
                                      tone="ghost"
                                      size={control.sm}
                                      onPress={() =>
                                        props.onChangeConfig(
                                          spec().key,
                                          undefined,
                                        )
                                      }
                                    />
                                  </View>
                                </If>
                              </View>
                            </If>
                          }
                        >
                          <View style={{ ...row, gap: space[8] }}>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <EditorSelect
                                label={spec().title}
                                value={
                                  spec().options.find(
                                    (opt) =>
                                      opt.value ===
                                      enumSelectionValue(
                                        spec(),
                                        props.config[spec().key],
                                      ),
                                  )?.label ?? ""
                                }
                                placeholder={uiText("selectValue")}
                                tablet={props.tablet}
                                phone={props.phone}
                                triggerStyle={selectStyle()}
                                options={spec().options.map((opt) => ({
                                  label: opt.label,
                                  checked:
                                    enumSelectionValue(
                                      spec(),
                                      props.config[spec().key],
                                    ) === opt.value,
                                  onSelect: () => {
                                    props.onBlurField(spec().key);
                                    props.onChangeConfig(spec().key, opt.raw);
                                  },
                                }))}
                              />
                            </View>
                            <If
                              when={
                                !spec().required &&
                                enumSelectionValue(
                                  spec(),
                                  props.config[spec().key],
                                ) !== null
                              }
                            >
                              <Button
                                label={uiText("clear")}
                                tone="ghost"
                                size={control.sm}
                                onPress={() =>
                                  props.onChangeConfig(spec().key, undefined)
                                }
                              />
                            </If>
                          </View>
                        </If>
                      </>
                    }
                  >
                    <View style={{ ...row, gap: space[12] }}>
                      <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                        <View
                          style={{
                            ...row,
                            gap: space[4],
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <Label variant="small">{spec().title}</Label>
                          <If when={spec().deprecated}>
                            <Badge
                              label={uiText("triggerDeprecated")}
                              tone="warning"
                              size="caption"
                            />
                          </If>
                        </View>
                        <If when={spec().description}>
                          <Label variant="caption" tone="muted">
                            {spec().description}
                          </Label>
                        </If>
                      </View>
                      <ToggleSwitch
                        label={spec().title}
                        checked={props.config[spec().key] === true}
                        compact
                        onChange={(checked) =>
                          props.onChangeConfig(spec().key, checked)
                        }
                      />
                    </View>
                  </If>
                  <If when={err()}>
                    <Label variant="caption" tone="red">
                      {err()}
                    </Label>
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
    </View>
  );
}
