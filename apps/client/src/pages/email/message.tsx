import type { EmailMessageView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { TextView } from "nsh/base";
import {
  Button,
  colors,
  fontFamily,
  Fonts,
  Icon,
  Label,
  Markdown,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { relativeTime } from "../../services/host";
import { EmailInfo } from "./thread-context";

export function isAgentMail(subject: string): boolean {
  return /^\[eta-mp\]/i.test(subject);
}

export function mailSubject(subject: string): string {
  return subject.replace(/^\[eta-mp\]\s*/i, "").trim() || "(No subject)";
}

export function EmailBadge() {
  const c = colors();
  return (
    <Label
      size={9}
      line={15}
      tone="buttonInk"
      weight={600}
      style={{ backgroundColor: c().button, paddingHorizontal: 4 }}
    >
      ETA
    </Label>
  );
}

function RfcHeaders(props: { message: EmailMessageView }) {
  return (
    <>
      <EmailInfo label={uiText("from")} value={props.message.from} />
      <EmailInfo label={uiText("to2")} value={props.message.to} />
      <EmailInfo label="Message-ID" value={props.message.rfcMessageId} />
      <EmailInfo label="In-Reply-To" value={props.message.inReplyTo} />
      <EmailInfo
        label="References"
        value={props.message.references.join(", ")}
      />
    </>
  );
}

export function MailMessage(props: {
  message: EmailMessageView;
  subject: string;
  phone: boolean;
  onContext: () => void;
}) {
  const c = colors();
  const fonts = Fonts();
  const headers = signal(false);
  const subject = () =>
    props.message.subject || props.subject || "(No subject)";
  const agentMail = () =>
    isAgentMail(subject()) ||
    Boolean(props.message.meta && props.message.meta.carrier !== "none");
  return (
    <View
      style={{
        padding: props.phone ? 0 : 12,
        borderWidth: props.phone ? 0 : 1,
        borderColor: c().border,
        gap: 7,
      }}
    >
      <View style={{ ...row, gap: 8, alignItems: "flex-start" }}>
        <If when={props.phone}>
          <Label
            size={10}
            line={15}
            tone="muted"
            style={{ backgroundColor: c().selected, paddingHorizontal: 4 }}
          >
            {props.message.direction === "incoming"
              ? uiText("in")
              : uiText("out")}
          </Label>
        </If>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Label size={props.phone ? 12 : 14} weight={600} lines={1}>
            {props.phone ? mailSubject(subject()) : subject()}
          </Label>
          <Label size={12} tone="muted" lines={2}>
            {uiText("fromTo", {
              from: props.message.from,
              to: props.message.to,
            })}
          </Label>
        </View>
        <Label size={11} tone="muted">
          {relativeTime(props.message.createdAt)}
        </Label>
      </View>
      <View
        style={{
          padding: props.phone ? 12 : 0,
          borderWidth: props.phone ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If
          when={
            agentMail() ||
            !props.message.html ||
            (!props.phone && !!props.message.text)
          }
          else={
            <TextView
              html={props.message.html}
              selectable
              styles={{
                root: {
                  fontFamily: fontFamily(fonts().interface),
                  fontSize: 14,
                  lineHeight: 22,
                  color: c().ink,
                },
              }}
              renderImage={(image) => (
                <Label tone="muted">{image.alt || uiText("image")}</Label>
              )}
              links="open"
            />
          }
        >
          <If
            when={agentMail()}
            else={<Label line={22}>{props.message.text}</Label>}
          >
            <Markdown
              value={props.message.text || "No message body"}
              line={22}
            />
          </If>
        </If>
      </View>
      <If when={props.message.rfcMessageId}>
        <View
          role="button"
          accessibilityLabel={uiText("rfc5322Headers")}
          accessibilityState={{ expanded: headers() }}
          onPress={() => headers.set(!headers())}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            gap: 8,
            minHeight: 34,
            borderWidth: 1,
            borderColor: c().border,
            paddingHorizontal: 10,
            cursor: "pointer",
          }}
        >
          <Icon name={headers() ? "down" : "right"} size={10} />
          <Label size={11} weight={600}>
            {uiText("rfc5322Headers")}
          </Label>
          <Label size={11} tone="muted" lines={1} style={{ flex: 1 }}>
            {props.message.rfcMessageId}
          </Label>
        </View>
      </If>
      <If when={headers()}>
        <View style={{ borderTopWidth: 1, borderColor: c().border }}>
          <RfcHeaders message={props.message} />
        </View>
      </If>
      <If when={props.message.meta && props.message.meta.carrier !== "none"}>
        <Button
          label={uiText("threadContext")}
          icon="context"
          style={{ alignSelf: "flex-start" }}
          onPress={props.onContext}
        />
      </If>
    </View>
  );
}
