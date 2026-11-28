import type {
  RoutineFields,
  RoutineInfo,
  RoutineResults,
  RoutineSchedule,
  RoutineTrigger,
  RoutineTriggerMode,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import { HOURLY_STEPS } from "@eta/client-contracts";
import { effect, signal, untracked, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  dialogWidth,
  Field,
  focusRing,
  grow,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import {
  control as controlHeight,
  icon,
  opacity,
  space,
  weight,
} from "../../components/tokens";
import { formatLocale, uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { Segmented, TimeField } from "../../ui";
import { timeZones, upcomingTimes, weekday } from "./schedule";
import {
  buildTriggerConfigPayload,
  initialTriggerConfigState,
  parseTriggerConfigSchema,
  validateTriggerField,
} from "./trigger-config";
import { EditorSelect, PhoneSelect, TriggerSection } from "./trigger-fields";

type RoutineTriggerKind = "schedule" | "trigger" | "both";

const MAX_POLL_MINUTES = 7 * 24 * 60;

/** The time of day beside the frequency. */
const timeFieldWidth = { sheet: 140, tablet: 112, desktop: 116 } as const;
/** The phone sheet's frequency and interval selects. */
const frequencyWidth = { cron: 152, other: 120 } as const;
/** The cron expression field. */
const cronWidth = 160;
/** The time zone field. */
const timezoneWidth = { tablet: 240, desktop: 368 } as const;
/** The brief: in the phone sheet when editing or creating, and on wider screens. */
const briefHeight = { edit: 96, create: 124, wide: 112 } as const;
/** The inline form's column. */
const formWidth = 800;

export function RoutineEditor(props: {
  phone: boolean;
  inline?: boolean;
  tablet?: boolean;
  item?: RoutineInfo;
  brief?: string;
  onPlugins?: () => void;
  onPluginSettings?: () => void;
  onClose: () => void;
  onSave: (id: string) => void;
}) {
  const host = useHost();
  const name = signal(props.item?.name ?? "");
  const brief = signal(props.brief ?? "");
  const existingSchedule = props.item?.schedule ?? null;
  const existingTrigger = props.item?.trigger ?? null;
  const initialKind: RoutineTriggerKind =
    existingSchedule !== null && existingTrigger !== null
      ? "both"
      : existingTrigger !== null
        ? "trigger"
        : "schedule";
  const triggerKind = signal<RoutineTriggerKind>(initialKind);

  const kind = signal<RoutineSchedule["kind"]>(
    existingSchedule?.kind ?? "weekly",
  );
  const at = signal(
    existingSchedule?.kind === "daily" || existingSchedule?.kind === "weekly"
      ? existingSchedule.time
      : "08:00",
  );
  const days = signal<number[]>(
    existingSchedule?.kind === "weekly" ? existingSchedule.days : [1],
  );
  const every = signal<(typeof HOURLY_STEPS)[number]>(
    existingSchedule?.kind === "hourly" ? existingSchedule.every : 1,
  );
  const cron = signal(
    existingSchedule?.kind === "cron" ? existingSchedule.cron : "",
  );
  const kinds = {
    daily: "dailySchedule",
    weekly: "weeklySchedule",
    hourly: "hourlySchedule",
    cron: "cronSchedule",
  } as const;

  const catalogTriggers = signal<TriggerCatalogItem[]>([]);
  const catalogProviders = signal<TriggerProviderStatus[]>([]);
  const catalogLoading = signal(false);
  const catalogLoaded = signal(false);
  const catalogError = signal("");
  let catalogSeq = 0;

  const triggerProvider = signal(existingTrigger?.provider ?? "");
  const triggerSource = signal(existingTrigger?.source ?? "");
  const triggerSlug = signal(existingTrigger?.trigger ?? "");
  const triggerAccountId = signal<string | null>(
    existingTrigger?.accountId ?? null,
  );
  const triggerMode = signal<RoutineTriggerMode | null>(
    existingTrigger?.mode ?? null,
  );
  const pollingIntervalText = signal(
    existingTrigger?.pollingIntervalMinutes
      ? String(existingTrigger.pollingIntervalMinutes)
      : "",
  );
  const triggerConfig = signal<Record<string, unknown>>(
    existingTrigger?.config ? { ...existingTrigger.config } : {},
  );
  const triggerDrafts = signal<Record<string, string>>({});
  const triggerTouched = signal<Record<string, boolean>>({});

  const c = colors();
  const type = textFaces();

  const usesSchedule = () => triggerKind() !== "trigger";
  const usesTrigger = () => triggerKind() !== "schedule";

  function schedule(): RoutineSchedule | undefined {
    switch (kind()) {
      case "daily":
      case "weekly": {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at().trim())) return undefined;
        if (kind() === "daily") return { kind: "daily", time: at().trim() };
        if (days().length)
          return {
            kind: "weekly",
            time: at().trim(),
            days: [...days()].sort(),
          };
        return undefined;
      }
      case "hourly":
        return { kind: "hourly", every: every() };
      case "cron":
        if (cron().trim().split(/\s+/).length === 5)
          return { kind: "cron", cron: cron().trim() };
        return undefined;
    }
  }

  const selectedCatalogItem = () =>
    catalogTriggers().find(
      (item) =>
        item.provider === triggerProvider() &&
        item.source === triggerSource() &&
        item.trigger === triggerSlug(),
    );

  const triggerFields = () =>
    parseTriggerConfigSchema(
      selectedCatalogItem()?.configSchema,
      triggerConfig(),
    );

  function selectProvider(provider: string) {
    if (triggerProvider() === provider) return;
    triggerProvider.set(provider);
    triggerSource.set("");
    triggerSlug.set("");
    triggerAccountId.set(null);
    triggerMode.set(null);
    pollingIntervalText.set("");
    triggerConfig.set({});
    triggerDrafts.set({});
    triggerTouched.set({});

    const sources = [
      ...new Set(
        catalogTriggers()
          .filter((item) => item.provider === provider)
          .map((item) => item.source),
      ),
    ];
    if (sources.length === 1) selectSource(sources[0]!);
  }

  function selectSource(source: string) {
    if (triggerSource() === source) return;
    triggerSource.set(source);
    triggerSlug.set("");
    triggerAccountId.set(null);
    triggerMode.set(null);
    pollingIntervalText.set("");
    triggerConfig.set({});
    triggerDrafts.set({});
    triggerTouched.set({});

    const provider = triggerProvider();
    const matched = catalogTriggers().filter(
      (item) => item.provider === provider && item.source === source,
    );
    if (matched.length === 1) selectTriggerItem(matched[0]!);
  }

  function selectTriggerItem(item: TriggerCatalogItem) {
    triggerProvider.set(item.provider);
    triggerSource.set(item.source);
    triggerSlug.set(item.trigger);
    triggerAccountId.set(
      item.accounts.length === 1 ? item.accounts[0]!.id : null,
    );
    triggerMode.set(item.modes.length > 0 ? item.modes[0]! : null);
    pollingIntervalText.set("");
    const parsed = parseTriggerConfigSchema(item.configSchema);
    const nextState = initialTriggerConfigState(parsed);
    triggerConfig.set(nextState.config);
    triggerDrafts.set(nextState.drafts);
    triggerTouched.set({});
  }

  async function loadTriggers(refresh = false) {
    const seq = ++catalogSeq;
    catalogLoading.set(true);
    catalogError.set("");
    try {
      const result = await host.call<RoutineResults["triggers"]>(
        "routines",
        "triggers",
        refresh ? { refresh: true } : {},
      );
      if (seq !== catalogSeq) return;
      const items = Array.isArray(result.triggers) ? result.triggers : [];
      const providers = Array.isArray(result.providers) ? result.providers : [];
      catalogTriggers.set(items);
      catalogProviders.set(providers);
      catalogLoaded.set(true);

      const matched = items.find(
        (item) =>
          item.provider === untracked(triggerProvider) &&
          item.source === untracked(triggerSource) &&
          item.trigger === untracked(triggerSlug),
      );
      if (matched) {
        const existingConfig = untracked(triggerConfig);
        const existingDrafts = untracked(triggerDrafts);
        const touchedFields = untracked(triggerTouched);
        const fields = parseTriggerConfigSchema(
          matched.configSchema,
          existingConfig,
        );
        const reconciled = initialTriggerConfigState(fields, existingConfig);
        const nextDrafts = { ...reconciled.drafts };
        for (const [key, value] of Object.entries(existingDrafts)) {
          if (touchedFields[key] || !Object.hasOwn(nextDrafts, key)) {
            nextDrafts[key] = value;
          }
        }
        triggerConfig.set(reconciled.config);
        triggerDrafts.set(nextDrafts);
        if (!untracked(triggerAccountId) && matched.accounts.length === 1) {
          triggerAccountId.set(matched.accounts[0]!.id);
        }
        if (!untracked(triggerMode) && matched.modes.length > 0) {
          triggerMode.set(matched.modes[0]!);
        }
      } else if (!untracked(triggerProvider)) {
        const providerIds = [...new Set(items.map((item) => item.provider))];
        if (providerIds.length === 1) selectProvider(providerIds[0]!);
      }
    } catch (error) {
      if (seq !== catalogSeq) return;
      catalogError.set(problemText(error));
    } finally {
      if (seq === catalogSeq) catalogLoading.set(false);
    }
  }

  effect(() => {
    if (!usesTrigger()) return;
    untracked(() => {
      if (!catalogLoaded() && !catalogLoading()) void loadTriggers(false);
    });
  });

  const timezone = signal(
    props.item?.timezone ??
      new Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
  );
  const busy = signal(false);

  const preview = () => {
    if (!usesSchedule()) return "";
    const selected = schedule();
    return selected ? upcomingTimes(selected, timezone()) : "";
  };

  const effectiveTriggerMode = (): RoutineTriggerMode | null => {
    const item = selectedCatalogItem();
    return (
      triggerMode() ?? (item && item.modes.length === 1 ? item.modes[0]! : null)
    );
  };

  const pollingError = () => {
    if (!usesTrigger() || effectiveTriggerMode() === "webhook") return "";
    const raw = pollingIntervalText().trim();
    if (raw === "") return "";
    const num = Number(raw);
    if (!Number.isInteger(num) || num < 1 || num > MAX_POLL_MINUTES) {
      return uiText("triggerPollingIntervalInvalid");
    }
    return "";
  };

  const triggerValid = () => {
    if (!usesTrigger()) return true;
    if (
      !triggerProvider().trim() ||
      !triggerSource().trim() ||
      !triggerSlug().trim()
    ) {
      return false;
    }
    const item = selectedCatalogItem();
    if (item && item.accounts.length > 1 && !triggerAccountId()) return false;
    if (pollingError() !== "") return false;
    const fields = triggerFields();
    const config = triggerConfig();
    const drafts = triggerDrafts();
    return fields.every(
      (field) =>
        validateTriggerField(field, config, drafts, triggerProvider()) ===
        undefined,
    );
  };

  const valid = () =>
    Boolean(
      name().trim() &&
        brief().trim() &&
        timezone().trim() &&
        (!usesSchedule() || schedule()) &&
        triggerValid(),
    );

  async function save() {
    const selectedSchedule = usesSchedule() ? schedule() : null;
    if ((usesSchedule() && !selectedSchedule) || !valid() || busy()) return;
    busy.set(true);

    let nextTrigger: RoutineTrigger | null = null;
    if (usesTrigger()) {
      const effectiveMode = effectiveTriggerMode();
      const pollText = pollingIntervalText().trim();
      const pollingIntervalMinutes =
        effectiveMode !== "webhook" && pollText !== ""
          ? Number(pollText)
          : null;
      nextTrigger = {
        provider: triggerProvider().trim(),
        source: triggerSource().trim(),
        trigger: triggerSlug().trim(),
        accountId: triggerAccountId() || null,
        config: buildTriggerConfigPayload(
          triggerFields(),
          triggerConfig(),
          triggerDrafts(),
        ),
        mode: effectiveMode,
        pollingIntervalMinutes,
      };
    }

    const fields: RoutineFields = {
      name: name().trim(),
      brief: brief().trim(),
      timezone: timezone().trim(),
      schedule: selectedSchedule ?? null,
      ...(props.item
        ? { trigger: nextTrigger }
        : nextTrigger !== null
          ? { trigger: nextTrigger }
          : {}),
    };
    const result = await host.action(() =>
      host.call<RoutineResults["create"]>(
        "routines",
        props.item ? "update" : "create",
        props.item ? { ...fields, routineId: props.item.id } : fields,
      ),
    );
    busy.set(false);
    if (result) {
      props.onClose();
      props.onSave(result.routine.id);
    }
  }

  const zones = () => timeZones(timezone());
  // The phone sheet: 36px controls with 14px text, a footer bar under the fields.
  const sheet = () => props.phone && !props.inline;
  // The tablet form uses 32px controls with a 10px inset; the desktop one 28px and 8px.
  const control = () =>
    sheet()
      ? controlHeight.touch
      : props.tablet
        ? controlHeight.lg
        : controlHeight.md;
  const controlInset = () => (sheet() || props.tablet ? space[12] : space[8]);
  const input = () => ({
    height: control(),
    paddingHorizontal: controlInset(),
    ...textStyle(type("small")),
  });
  const select = () => ({
    height: control(),
    paddingHorizontal: controlInset(),
    gap: space[8],
    borderColor: c().border,
  });
  const interval = (hours: number) =>
    hours === 1 ? uiText("intervalHour") : uiText("intervalHours", { hours });
  const field = (label: string, content: JSX.Element, width?: number) => (
    <View style={{ gap: space[4], width: width ?? "100%", maxWidth: "100%" }}>
      <Label variant="small" tone={sheet() ? "mutedInk" : undefined}>
        {label}
      </Label>
      {content}
    </View>
  );
  const time = () => (
    <If when={kind() === "weekly" || kind() === "daily"}>
      <TimeField
        label={uiText("time")}
        value={at()}
        hourCycle={formatLocale() === "zh-CN" ? "h23" : "h12"}
        height={control()}
        paddingHorizontal={controlInset()}
        iconSize={sheet() ? icon.md : icon.sm}
        style={{
          width: sheet()
            ? timeFieldWidth.sheet
            : props.tablet
              ? timeFieldWidth.tablet
              : timeFieldWidth.desktop,
        }}
        onChange={at.set}
      />
    </If>
  );
  const actions = () => (
    <View
      style={{
        ...row,
        gap: space[8],
        justifyContent: "flex-end",
        ...(sheet()
          ? {
              paddingTop: space[12],
              paddingHorizontal: space[16],
              paddingBottom: space[24],
              borderTopWidth: 1,
              borderColor: c().border,
            }
          : { paddingTop: space[4] }),
      }}
    >
      <Button
        label={uiText("cancel")}
        size={sheet() ? controlHeight.touch : controlHeight.md}
        disabled={busy()}
        style={{ paddingHorizontal: space[16] }}
        onPress={props.onClose}
      />
      <Button
        label={props.item ? uiText("save") : uiText("routineCreate")}
        tone="primary"
        size={sheet() ? controlHeight.touch : controlHeight.md}
        disabled={!valid()}
        busy={busy()}
        dimDisabled={!sheet()}
        style={{
          paddingHorizontal: space[16],
          opacity: sheet() || valid() ? 1 : opacity.disabled,
          // The phone sheet draws a disabled primary in the faint fill.
          ...(sheet() && !valid()
            ? { backgroundColor: c().faint, borderColor: c().faint }
            : {}),
        }}
        onPress={() => void save()}
      />
    </View>
  );
  const form = () => (
    <View
      style={{
        paddingVertical: props.inline && !props.tablet ? space[20] : space[16],
        paddingTop: sheet() ? space[12] : undefined,
        paddingHorizontal: props.tablet
          ? space[24]
          : props.inline
            ? space[32]
            : space[16],
        gap: props.tablet ? space[12] : space[16],
        width: "100%",
        maxWidth: props.inline ? formWidth : undefined,
        borderTopWidth: sheet() ? 1 : 0,
        borderColor: c().border,
      }}
    >
      <If when={props.inline}>
        <View style={{ gap: props.tablet ? space[12] : space[4] }}>
          <View
            role="button"
            accessibilityLabel={props.item?.name ?? uiText("routines2")}
            onPress={props.onClose}
            focusVisibleStyle={focusRing(c(), "inset")}
            style={{
              ...row,
              height: props.tablet ? undefined : controlHeight.md,
              gap: space[4],
              alignSelf: "flex-start",
              cursor: "pointer",
            }}
          >
            <Icon name="arrowLeft" size={icon.sm} />
            <Label variant="small" tone={props.tablet ? "mutedInk" : "muted"}>
              {props.item?.name ?? uiText("routines2")}
            </Label>
          </View>
          <Label weight={weight.strong}>
            {props.item ? uiText("edit") : uiText("newRoutine")}
          </Label>
        </View>
      </If>
      {field(
        uiText("name"),
        <Field
          label={uiText("name")}
          placeholder={uiText("routineNamePlaceholder")}
          value={name()}
          onChange={name.set}
          style={input()}
        />,
      )}
      {field(
        uiText("routineBriefLabel"),
        <>
          <Field
            label={uiText("routineBriefLabel")}
            placeholder={uiText("routineBriefPlaceholder")}
            value={brief()}
            onChange={brief.set}
            multiline
            style={
              sheet()
                ? {
                    height: props.item ? briefHeight.edit : briefHeight.create,
                    paddingVertical: space[8],
                    paddingHorizontal: space[12],
                    ...textStyle(type("small"), "prose"),
                  }
                : {
                    height: briefHeight.wide,
                    padding: space[12],
                    ...textStyle(type("small"), "prose"),
                  }
            }
          />
          <If when={props.tablet}>
            <Label variant="small" tone="muted">
              {uiText("routineRunByCaptain")}
            </Label>
          </If>
          <If when={sheet()}>
            <Label variant="small" tone="muted">
              {uiText("routineRunByCaptain")}
            </Label>
          </If>
        </>,
      )}
      <If when={!props.tablet && !sheet()}>
        <Label variant="small" tone="muted">
          {uiText("routineRunByCaptain")}
        </Label>
      </If>
      {field(
        uiText("triggerKindLabel"),
        <View style={{ alignItems: "flex-start" }}>
          <Segmented<RoutineTriggerKind>
            value={triggerKind()}
            height={sheet() ? controlHeight.lg : controlHeight.md}
            paddingHorizontal={sheet() ? space[8] : space[12]}
            strong={Boolean(props.tablet)}
            options={[
              { value: "schedule", label: uiText("triggerKindSchedule") },
              { value: "trigger", label: uiText("triggerKindEvent") },
              { value: "both", label: uiText("triggerKindBoth") },
            ]}
            onChange={triggerKind.set}
          />
        </View>,
      )}
      <If when={usesTrigger()}>
        <TriggerSection
          phone={props.phone}
          sheet={sheet()}
          tablet={Boolean(props.tablet)}
          controlHeight={control()}
          controlInset={controlInset()}
          catalogLoading={catalogLoading()}
          catalogLoaded={catalogLoaded()}
          catalogError={catalogError()}
          triggers={catalogTriggers()}
          providers={catalogProviders()}
          provider={triggerProvider()}
          source={triggerSource()}
          triggerSlug={triggerSlug()}
          accountId={triggerAccountId()}
          mode={triggerMode()}
          pollingIntervalText={pollingIntervalText()}
          pollingError={pollingError()}
          config={triggerConfig()}
          drafts={triggerDrafts()}
          touched={triggerTouched()}
          fields={triggerFields()}
          selectedItem={selectedCatalogItem()}
          editingExisting={Boolean(existingTrigger)}
          onRefresh={() => void loadTriggers(true)}
          onSelectProvider={selectProvider}
          onSelectSource={selectSource}
          onSelectTrigger={selectTriggerItem}
          onSelectAccount={(id) => triggerAccountId.set(id)}
          onSelectMode={(mode) => {
            triggerMode.set(mode);
            if (mode !== "poll") pollingIntervalText.set("");
          }}
          onChangePollingInterval={pollingIntervalText.set}
          onChangeConfig={(key, value) =>
            triggerConfig.update((prev) => {
              const next = { ...prev };
              if (value === undefined) delete next[key];
              else next[key] = value;
              return next;
            })
          }
          onChangeDraft={(key, text) => {
            triggerDrafts.update((prev) => ({ ...prev, [key]: text }));
            triggerTouched.update((prev) => ({ ...prev, [key]: true }));
          }}
          onBlurField={(key) =>
            triggerTouched.update((prev) => ({ ...prev, [key]: true }))
          }
          onOpenPlugins={props.onPlugins}
          onOpenPluginSettings={props.onPluginSettings}
        />
      </If>
      <If when={usesSchedule()}>
        {field(
          triggerKind() === "both"
            ? uiText("scheduleFallbackLabel")
            : uiText("schedule"),
          <>
            <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
              <EditorSelect
                label={uiText("scheduleFrequency")}
                title={uiText("frequency")}
                value={uiText(kinds[kind()])}
                tablet={props.tablet}
                phone={props.phone}
                triggerStyle={
                  sheet()
                    ? kind() === "hourly"
                      ? { flex: 1, minWidth: 0 }
                      : {
                          width:
                            kind() === "cron"
                              ? frequencyWidth.cron
                              : frequencyWidth.other,
                          flexShrink: 0,
                        }
                    : select()
                }
                options={(Object.keys(kinds) as RoutineSchedule["kind"][]).map(
                  (option) => ({
                    label: uiText(kinds[option]),
                    checked: kind() === option,
                    onSelect: () => kind.set(option),
                  }),
                )}
              />
              <If when={kind() === "weekly"}>
                <View
                  style={{
                    ...row,
                    height: control(),
                    borderWidth: 1,
                    borderColor: props.tablet ? c().border : c().strong,
                  }}
                >
                  <Each of={[1, 2, 3, 4, 5, 6, 0]}>
                    {(day) => (
                      <View
                        role="button"
                        accessibilityLabel={weekday(day())}
                        accessibilityState={{
                          selected: days().includes(day()),
                        }}
                        onPress={() =>
                          days.update((previous) =>
                            previous.includes(day())
                              ? previous.filter((item) => item !== day())
                              : [...previous, day()],
                          )
                        }
                        focusVisibleStyle={focusRing(c(), "inset")}
                        style={{
                          ...(props.tablet
                            ? { paddingHorizontal: space[8] }
                            : { width: controlHeight.md }),
                          alignSelf: "stretch",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          backgroundColor: days().includes(day())
                            ? c().button
                            : undefined,
                        }}
                      >
                        <Label
                          variant="small"
                          tone={
                            days().includes(day())
                              ? "buttonInk"
                              : props.tablet
                                ? "mutedInk"
                                : "muted"
                          }
                        >
                          {weekday(day())}
                        </Label>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
              <If when={!props.tablet}>{time()}</If>
              <If when={kind() === "hourly"}>
                <EditorSelect
                  label={uiText("repeatEvery")}
                  value={interval(every())}
                  tablet={props.tablet}
                  phone={props.phone}
                  triggerStyle={
                    sheet()
                      ? { width: frequencyWidth.other, flexShrink: 0 }
                      : select()
                  }
                  options={HOURLY_STEPS.map((hours) => ({
                    label: interval(hours),
                    checked: every() === hours,
                    onSelect: () => every.set(hours),
                  }))}
                />
              </If>
              <If when={kind() === "cron"}>
                <Field
                  label={uiText("cronExpression")}
                  placeholder="0 8 * * 1-5"
                  value={cron()}
                  onChange={cron.set}
                  style={{
                    ...input(),
                    ...(sheet()
                      ? { flex: 1, minWidth: 0 }
                      : { width: cronWidth }),
                  }}
                />
              </If>
            </View>
            <If when={kind() === "cron" && !props.tablet}>
              <Label variant="small" tone="muted">
                {uiText("minuteHourDayOfMonthMonth")}
              </Label>
            </If>
            <If
              when={props.tablet}
              else={
                <If when={preview()}>
                  <Label variant="small" tone="muted">
                    {preview()}
                  </Label>
                </If>
              }
            >
              <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
                {time()}
                <If when={kind() === "cron"}>
                  <Label variant="caption" tone="muted">
                    {uiText("minuteHourDayOfMonthMonth")}
                  </Label>
                </If>
                <If when={preview()}>
                  <Label variant="caption" tone="muted" style={{ flex: 1 }}>
                    {preview()}
                  </Label>
                </If>
              </View>
            </If>
          </>,
        )}
      </If>
      {field(
        uiText("timeZone"),
        <If
          when={sheet()}
          else={
            <ActionMenu
              label={uiText("timeZone")}
              value={timezone()}
              truncateValue
              triggerStyle={select()}
            >
              <Each of={zones()}>
                {(zone) => (
                  <ActionItem
                    label={zone()}
                    checked={timezone() === zone()}
                    onSelect={() => timezone.set(zone())}
                  />
                )}
              </Each>
            </ActionMenu>
          }
        >
          <PhoneSelect
            label={uiText("timeZone")}
            title={uiText("timeZone")}
            value={timezone()}
            options={zones().map((zone) => ({
              label: zone,
              checked: timezone() === zone,
              onSelect: () => timezone.set(zone),
            }))}
          />
        </If>,
        sheet()
          ? undefined
          : props.tablet
            ? timezoneWidth.tablet
            : timezoneWidth.desktop,
      )}
      <If when={!sheet()}>{actions()}</If>
    </View>
  );
  return (
    <If
      when={props.inline}
      else={
        <Modal
          title={
            props.item
              ? props.phone
                ? uiText("edit")
                : uiText("editRoutine")
              : uiText("newRoutine")
          }
          phone={props.phone}
          sheet={props.phone}
          plainSheetHeader={props.phone}
          overPhoneNavigation={props.phone}
          width={dialogWidth.lg}
          onClose={props.onClose}
        >
          <SmoothScroll style={{ flexShrink: 1 }}>{form()}</SmoothScroll>
          <If when={sheet()}>{actions()}</If>
        </Modal>
      }
    >
      <SmoothScroll style={grow}>{form()}</SmoothScroll>
    </If>
  );
}
