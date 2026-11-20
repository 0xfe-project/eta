import type { MessageView } from "@eta/client-contracts";
import type { light } from "../../components/theme";
import { signal, View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

interface CaptainReviewItem {
  id: string;
  kind: string;
  body: string;
  data: Record<string, unknown>;
  detail: string;
}

type Tone = "attention" | "danger" | "neutral";

const kinds: Record<
  string,
  { label: Parameters<typeof uiText>[0]; tone: Tone }
> = {
  assignment_settled: { label: "reviewSettled", tone: "neutral" },
  assignment_blocked: { label: "reviewBlocked", tone: "attention" },
  assignment_stalled: { label: "reviewStalled", tone: "attention" },
  assignment_inbox: { label: "reviewInbox", tone: "attention" },
  inbox_decision: { label: "reviewDecision", tone: "attention" },
  inbox_pending: { label: "reviewInboxPending", tone: "attention" },
  task_run_offline: { label: "reviewOffline", tone: "danger" },
  task_run_stuck: { label: "reviewStuck", tone: "danger" },
  task_stalled: { label: "reviewTaskStalled", tone: "attention" },
  task_blocked: { label: "reviewTaskBlocked", tone: "attention" },
  task_failure: { label: "reviewFailure", tone: "danger" },
  task_failure_non_retryable: { label: "reviewFailureFinal", tone: "danger" },
  review_failed: { label: "reviewFailed", tone: "danger" },
  inbox_relay_waiting: { label: "reviewWaiting", tone: "attention" },
};

const marks: Record<Tone, keyof typeof light> = {
  danger: "red",
  attention: "amber",
  neutral: "faint",
};

/** The observations of a Captain review row: structured, or parsed from older text. */
export function reviewItemsOf(message: MessageView): CaptainReviewItem[] {
  if (message.author !== "system") return [];
  const structured = message.data.captainReview;
  if (
    structured &&
    typeof structured === "object" &&
    "reviews" in structured &&
    Array.isArray(structured.reviews)
  )
    return structured.reviews.flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const source = value as Record<string, unknown>;
      if (typeof source.body !== "string") return [];
      const data =
        source.data && typeof source.data === "object"
          ? (source.data as Record<string, unknown>)
          : {};
      return [
        {
          id: typeof source.id === "string" ? source.id : source.body,
          kind: typeof source.kind === "string" ? source.kind : "",
          body: source.body,
          data,
          detail:
            typeof source.detail === "string"
              ? source.detail
              : JSON.stringify(data, null, 2),
        },
      ];
    });
  const open = message.text.indexOf("<captain-review>");
  const close = message.text.lastIndexOf("</captain-review>");
  if (open < 0 || close <= open) return [];
  const source = message.text.slice(open + "<captain-review>".length, close);
  const headers = [...source.matchAll(/^(\d+)\. \[([^\]]+)\]\s?/gm)];
  return headers.map((header, index) => {
    const start = (header.index ?? 0) + header[0].length;
    const end = headers[index + 1]?.index ?? source.length;
    const content = source.slice(start, end).trim();
    const detailAt = content.indexOf("\n{");
    const detail = detailAt < 0 ? "" : content.slice(detailAt + 1).trim();
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = detail ? JSON.parse(detail) : {};
      if (parsed && typeof parsed === "object")
        data = parsed as Record<string, unknown>;
    } catch {
      // A truncated detail still leaves the readable body.
    }
    return {
      id: `${header[1]}:${header[2]}`,
      kind: header[2]!,
      body: detailAt < 0 ? content : content.slice(0, detailAt).trim(),
      data,
      detail,
    };
  });
}

export function CaptainReview(props: {
  items: CaptainReviewItem[];
  time: string;
}) {
  const c = colors();
  return (
    <View style={{ borderWidth: 1, borderColor: c().border }}>
      <View
        style={{ ...row, gap: 8, paddingVertical: 5, paddingHorizontal: 10 }}
      >
        <Label size={12} line={16} weight={500} style={{ flexShrink: 0 }}>
          {uiText("captainReviewTitle")}
        </Label>
        <Label
          size={10}
          line={12}
          tone="faint"
          lines={1}
          style={{ flex: 1, letterSpacing: 0.8, textTransform: "uppercase" }}
        >
          {uiText("captainObservations", { count: props.items.length })}
        </Label>
        <Label
          size={10}
          line={12}
          tone="faint"
          style={{ letterSpacing: 0.8, textTransform: "uppercase" }}
        >
          {props.time}
        </Label>
      </View>
      <Each of={props.items} key={(item) => item.id}>
        {(item) => <Observation item={item()} />}
      </Each>
    </View>
  );
}

function Observation(props: { item: CaptainReviewItem }) {
  const c = colors();
  const host = useHost();
  const raw = signal(false);
  const kind = () => kinds[props.item.kind];
  const tone = () => kind()?.tone ?? "neutral";
  const ordinary = () => tone() === "neutral";
  const context = () => {
    const data = props.item.data;
    const values: string[] = [];
    if (typeof data.agentId === "string") {
      const name = host.agent(data.agentId)?.name;
      if (name) values.push(name);
    }
    if (typeof data.taskNumber === "number")
      values.push(uiText("reviewTaskNumber", { number: data.taskNumber }));
    if (typeof data.interactionId === "string")
      values.push(uiText("reviewInboxChip"));
    return values;
  };
  return (
    <View
      style={{
        gap: 4,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderTopWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={{ ...row, gap: 8 }}>
        <View style={{ ...row, flex: 1, gap: 6 }}>
          <StatusDot color={c()[marks[tone()]]} />
          <Label
            size={10}
            line={12}
            tone={ordinary() ? "muted" : "ink"}
            style={{ letterSpacing: 0.8, textTransform: "uppercase" }}
          >
            {uiText(kind()?.label ?? "reviewOther")}
          </Label>
        </View>
        <Label size={10} line={12} tone="faint">
          {props.item.kind}
        </Label>
      </View>
      <Label size={13} line={21} tone={ordinary() ? "muted" : "ink"}>
        {props.item.body}
      </Label>
      <If when={context().length}>
        <View style={{ ...row, gap: 5, paddingTop: 2 }}>
          <Each of={context()}>
            {(value) => (
              <View
                style={{
                  paddingHorizontal: 5,
                  borderWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label size={10} line={14} tone="muted">
                  {value()}
                </Label>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={props.item.detail}>
        <View style={{ paddingTop: 2, alignItems: "flex-start" }}>
          <View
            role="button"
            accessibilityState={{ expanded: raw() }}
            onPress={() => raw.set(!raw())}
            style={{ ...row, gap: 4, cursor: "pointer" }}
          >
            <Icon name={raw() ? "down" : "right"} size={8} tone="faint" />
            <Label
              size={10}
              line={12}
              tone="faint"
              style={{ letterSpacing: 0.6, textTransform: "uppercase" }}
            >
              {uiText("reviewRawDetails")}
            </Label>
          </View>
        </View>
        <If when={raw()}>
          <Label
            size={11}
            line={16}
            tone="muted"
            style={{
              padding: 8,
              backgroundColor: c().surface,
              fontFamily: "monospace",
            }}
          >
            {props.item.detail}
          </Label>
        </If>
      </If>
    </View>
  );
}
