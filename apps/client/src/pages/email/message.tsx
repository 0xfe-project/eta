import type { EmailMessageView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { TextView } from "nsh/base";
import {
  colors,
  fontFamily,
  Fonts,
  Icon,
  Label,
  Markdown,
  monoFontFamily,
  row,
  textFaces,
  textStyle,
} from "../../components";
import { formatLocale, uiText } from "../../i18n";
import { EmailMetaCard } from "./thread-context";

export function isAgentMail(subject: string): boolean {
  return /^\[eta-mp\]/i.test(subject);
}

export function mailSubject(subject: string): string {
  return subject.replace(/^\[eta-mp\]\s*/i, "").trim() || "(No subject)";
}

/** The agent-mail mark; `tall` is the phone thread header's 16px chip. */
export function EmailBadge(props: { tall?: boolean }) {
  const c = colors();
  return (
    <Label
      variant="caption"
      tone="canvas"
      style={{
        backgroundColor: c().ink,
        paddingVertical: props.tall ? 1 : 3,
        paddingHorizontal: 6,
      }}
    >
      ETA
    </Label>
  );
}

function isToday(at: Date, now: Date) {
  return at.toDateString() === now.toDateString();
}

function hourMinute(at: Date) {
  return at.toLocaleTimeString(formatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function monthDay(at: Date) {
  return at.toLocaleDateString(formatLocale(), {
    month: "short",
    day: "numeric",
  });
}

/** Thread list time: the clock time today, "Yesterday", then the day. */
export function mailDay(at: number) {
  const date = new Date(at);
  const now = new Date();
  if (isToday(date, now)) return hourMinute(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isToday(date, yesterday)) return uiText("yesterdayDate");
  return monthDay(date);
}

/** Message time: the day and the clock time, e.g. "Nov 18, 10:42". */
function mailTime(at: number) {
  const date = new Date(at);
  return `${monthDay(date)}, ${hourMinute(date)}`;
}

/** One header: a 112pt muted name, the value in the mono face,
 * and a dash for a header the message does not carry. */
function RfcLine(props: { label: string; value?: string | null }) {
  const fonts = Fonts();
  return (
    <View style={{ ...row, alignItems: "flex-start", gap: 12 }}>
      <Label variant="small" tone="muted" style={{ width: 112, flexShrink: 0 }}>
        {props.label}
      </Label>
      <Label
        variant="small"
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: monoFontFamily(fonts()),
        }}
      >
        {props.value || "—"}
      </Label>
    </View>
  );
}

function MailBody(props: {
  message: EmailMessageView;
  agentMail: boolean;
  html: boolean;
  /** Phone: tighter blocks and a lighter heading. */
  compact?: boolean;
}) {
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  // The text view already spaces its blocks by about 12px.
  const blockMargin = () => (props.compact ? 0 : 10);
  return (
    <If
      when={props.html}
      else={
        <If when={props.agentMail} else={<Label>{props.message.text}</Label>}>
          <If
            when={props.compact}
            else={<Markdown value={props.message.text || "No message body"} />}
          >
            <TextView
              markdown={props.message.text || "No message body"}
              options={{ html: false }}
              selectable
              links="open"
              styles={{
                root: {
                  fontFamily: fontFamily(fonts().interface),
                  ...textStyle(type("body"), "prose"),
                  color: c().ink,
                },
                paragraph: { marginTop: 0, marginBottom: 0 },
                code: { fontFamily: monoFontFamily(fonts()) },
                codeBlockCode: {
                  fontFamily: monoFontFamily(fonts()),
                },
                link: { color: c().blue },
              }}
            />
          </If>
        </If>
      }
    >
      <TextView
        html={props.message.html}
        selectable
        styles={{
          root: {
            fontFamily: fontFamily(fonts().interface),
            ...textStyle(type("body"), "prose"),
            color: props.agentMail ? c().mutedInk : c().ink,
          },
          heading1: {
            ...textStyle(type("title")),
            fontWeight: props.compact ? 600 : 700,
            color: c().ink,
            marginTop: 0,
            marginBottom: blockMargin(),
          },
          paragraph: {
            ...textStyle(type("body"), "prose"),
            marginTop: 0,
            marginBottom: blockMargin(),
          },
          code: { fontFamily: monoFontFamily(fonts()) },
          codeBlockCode: { fontFamily: monoFontFamily(fonts()) },
          link: { color: c().blue },
        }}
        renderImage={(image) => (
          // Agent mail carries its payload in the logo's alt text; it is shown
          // decoded in the context card, never as body text.
          <If when={!props.agentMail}>
            <Label tone="muted">{image.alt || uiText("image")}</Label>
          </If>
        )}
        links="open"
      />
    </If>
  );
}

/** The wide body: a bordered frame cut to a preview until it is expanded. */
function BodyPreview(props: { message: EmailMessageView; agentMail: boolean }) {
  const c = colors();
  const expanded = signal(false);
  const height = signal(0);
  const preview = 210;
  const long = () => height() > preview;
  return (
    <>
      <View
        style={{
          borderWidth: 1,
          borderColor: c().border,
          backgroundColor: c().canvas,
          maxHeight: long() && !expanded() ? preview : undefined,
          overflow: "hidden",
        }}
      >
        <View
          onLayout={(event) => height.set(event.bounds.size.height)}
          style={{ paddingVertical: 20, paddingHorizontal: 28 }}
        >
          <MailBody
            message={props.message}
            agentMail={props.agentMail}
            html={!!props.message.html}
          />
        </View>
        <If when={long() && !expanded()}>
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 70,
              backgroundImage: `linear-gradient(0deg, ${c().canvas} 0%, ${c().canvas}00 100%)`,
            }}
          />
        </If>
      </View>
      <If when={long()}>
        <View
          role="button"
          accessibilityState={{ expanded: expanded() }}
          onPress={() => expanded.set(!expanded())}
          style={{
            ...row,
            justifyContent: "center",
            gap: 6,
            height: 24,
            cursor: "pointer",
          }}
        >
          <Label variant="small">
            {expanded() ? uiText("collapseBody") : uiText("expandBody")}
          </Label>
          <View
            style={{
              transform: expanded() ? [{ rotate: "180deg" }] : undefined,
            }}
          >
            <Icon name="down" size={14} />
          </View>
        </View>
      </If>
    </>
  );
}

export function MailMessage(props: {
  message: EmailMessageView;
  subject: string;
  phone: boolean;
  /** Desktop and phones fold the agent context under the message; tablet
   * opens it from the pane header. */
  inlineContext: boolean;
}) {
  const c = colors();
  const headers = signal(false);
  const subject = () =>
    props.message.subject || props.subject || "(No subject)";
  const agentMail = () =>
    isAgentMail(subject()) ||
    Boolean(props.message.meta && props.message.meta.carrier !== "none");
  const meta = () =>
    props.message.meta && props.message.meta.carrier !== "none"
      ? props.message.meta
      : undefined;
  return (
    <View
      style={props.phone ? { paddingBottom: 16 } : { gap: 10, paddingTop: 14 }}
    >
      <View
        style={{
          ...row,
          gap: 8,
          alignItems: "flex-start",
          ...(props.phone
            ? { paddingTop: 16, paddingBottom: 12, paddingHorizontal: 16 }
            : undefined),
        }}
      >
        <If
          when={props.phone}
          else={
            <Label
              variant="caption"
              style={{
                backgroundColor: c().selected,
                paddingVertical: 4,
                paddingHorizontal: 8,
              }}
            >
              {props.message.direction === "incoming"
                ? uiText("in")
                : uiText("out")}
            </Label>
          }
        >
          <Label
            variant="caption"
            tone="mutedInk"
            style={{
              backgroundColor: c().selected,
              paddingVertical: 1,
              paddingHorizontal: 6,
            }}
          >
            {props.message.direction === "incoming"
              ? uiText("in")
              : uiText("out")}
          </Label>
        </If>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Label weight={600} lines={1}>
            {mailSubject(subject())}
          </Label>
          <Label variant="small" tone="muted" lines={2}>
            {uiText("fromTo", {
              from: props.message.from,
              to: props.message.to,
            })}
          </Label>
        </View>
        <Label variant="caption" tone="muted">
          {mailTime(props.message.createdAt)}
        </Label>
      </View>
      <If
        when={props.phone}
        else={<BodyPreview message={props.message} agentMail={agentMail()} />}
      >
        <View
          style={{
            marginHorizontal: 16,
            padding: 16,
            borderWidth: 1,
            borderColor: c().border,
          }}
        >
          <MailBody
            message={props.message}
            agentMail={agentMail()}
            html={!!props.message.html}
            compact
          />
        </View>
      </If>
      <If when={props.message.rfcMessageId}>
        <View
          style={{
            borderWidth: 1,
            borderColor: c().border,
            ...(props.phone
              ? { marginTop: 12, marginHorizontal: 16 }
              : undefined),
          }}
        >
          <View
            role="button"
            accessibilityLabel={uiText("rfc5322Headers")}
            accessibilityState={{ expanded: headers() }}
            onPress={() => headers.set(!headers())}
            hoverStyle={{ backgroundColor: c().selected }}
            style={{
              ...row,
              gap: 8,
              paddingVertical: props.phone ? 10 : 8,
              paddingHorizontal: 12,
              cursor: "pointer",
            }}
          >
            <View
              style={{
                transform: headers() ? [{ rotate: "180deg" }] : undefined,
              }}
            >
              <Icon
                name="down"
                size={props.phone ? 12 : 14}
                tone={props.phone ? "ink" : "muted"}
              />
            </View>
            <Label variant="caption" weight={600}>
              {uiText("rfc5322Headers")}
            </Label>
            <Label variant="caption" tone="muted" lines={1} style={{ flex: 1 }}>
              {props.message.rfcMessageId}
            </Label>
          </View>
          <If when={headers()}>
            <View
              style={{
                gap: 4,
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <RfcLine label="Message-ID" value={props.message.rfcMessageId} />
              <RfcLine label="In-Reply-To" value={props.message.inReplyTo} />
              <RfcLine
                label="References"
                value={props.message.references.join(", ")}
              />
            </View>
          </If>
        </View>
      </If>
      <If when={props.inlineContext ? meta() : undefined}>
        {(value) => (
          <View
            style={
              props.phone ? { marginTop: 12, marginHorizontal: 16 } : undefined
            }
          >
            <EmailMetaCard meta={value()} phone={props.phone} />
          </View>
        )}
      </If>
    </View>
  );
}
