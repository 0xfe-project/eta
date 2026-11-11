import type { EtaMailEnvelope } from "./context";
import { load } from "cheerio";
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import { encodeLogoAlt } from "./context";

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
export const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFElEQVR42mMQEhb5TwxmGFVIX4UAFJl54dzcLaAAAAAASUVORK5CYII=";

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function markdownHtml(source: string): string {
  const safe = sanitizeHtml(markdown.render(source), {
    allowedTags: [
      "p",
      "br",
      "strong",
      "em",
      "del",
      "code",
      "pre",
      "blockquote",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "a",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    allowedAttributes: { a: ["href", "title"] },
    allowedSchemes: ["http", "https", "mailto"],
  });
  const $ = load(safe, null, false);
  $("p").attr(
    "style",
    "margin:0 0 18px;color:#2b2d30;font:400 17px/1.7 Arial,sans-serif;",
  );
  $("h1,h2,h3,h4").attr(
    "style",
    "margin:26px 0 11px;color:#17191b;font-weight:700;line-height:1.3;letter-spacing:-.02em;",
  );
  $("h1").attr(
    "style",
    "margin:6px 0 18px;font:700 28px/1.2 Arial,sans-serif;",
  );
  $("h2").attr(
    "style",
    "margin:26px 0 12px;font:700 22px/1.3 Arial,sans-serif;",
  );
  $("ul,ol").attr(
    "style",
    "margin:0 0 19px;padding-left:24px;font:400 16px/1.7 Arial,sans-serif;",
  );
  $("li").attr("style", "margin:6px 0;");
  $("strong").attr("style", "color:#17191b;");
  $("a").attr("style", "color:#17191b;text-decoration:underline;");
  $("blockquote").attr(
    "style",
    "margin:20px 0;padding:16px 18px;border-left:3px solid #17191b;background:#f4f5f6;color:#50545a;",
  );
  $("pre").attr(
    "style",
    "padding:16px;background:#f4f5f6;font:13px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap;",
  );
  $("table").attr(
    "style",
    "width:100%;border-collapse:collapse;font:14px/1.5 Arial,sans-serif;",
  );
  $("th,td").attr(
    "style",
    "padding:9px 11px;border-bottom:1px solid #e4e6e8;text-align:left;",
  );
  return $.html();
}

/**
 * The part a person reads and can check in one look: what is being asked of them, and where the
 * sender is standing. It is generated from the payload, so the body can never say something the
 * agent side does not carry.
 */
function contextBlock(payload: EtaMailEnvelope["payload"]): string {
  const rows: [string, string][] = [];
  const needed = payload.ask.needed ?? payload.ask.question;
  if (needed !== null) rows.push(["Needs you", needed]);
  if (payload.ask.by !== null) rows.push(["Due", payload.ask.by]);
  if (payload.work.doing !== null) rows.push(["Doing", payload.work.doing]);
  const where = [payload.work.repo, payload.work.branch]
    .filter((part): part is string => part !== null)
    .join(" @ ");
  const place = where !== "" ? where : payload.from.cwd;
  if (place !== null) rows.push(["Location", place]);
  if (rows.length === 0) return "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 22px;border-top:1px solid #eceef0;">${rows
    .map(
      ([label, value]) =>
        `<tr><td style="width:74px;padding:9px 14px 9px 0;border-bottom:1px solid #f2f3f4;color:#8a8f94;font:700 10px ui-monospace,Menlo,monospace;letter-spacing:.11em;vertical-align:top;">${escape(
          label,
        )}</td><td style="padding:9px 0;border-bottom:1px solid #f2f3f4;color:#2b2d30;font:400 15px/1.6 Arial,sans-serif;">${escape(
          value,
        )}</td></tr>`,
    )
    .join("")}</table>`;
}

export interface MailTemplateInput {
  envelope: EtaMailEnvelope;
  title: string;
  status: string;
  markdown: string;
  packets: string[];
  messageId: string;
  ctaUrl?: string;
}

export function renderMail(input: MailTemplateInput): string {
  const points = input.packets
    .map(
      (packet, index) =>
        `<img src="cid:eta-data@demo" width="10" height="10" alt="${escape(packet)}" data-index="${index + 1}" style="display:inline-block;width:10px;height:10px;border:0;margin:0 4px;vertical-align:middle;background:#17191b;" />`,
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(input.title)}</title></head>
<body style="margin:0;padding:0;background:#eef1f3;font-family:Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef1f3;"><tr><td align="center" style="padding:30px 14px 42px;">
<table role="presentation" width="620" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:620px;background:#fff;border:1px solid #e2e5e7;">
<tr><td style="padding:20px 34px;border-bottom:1px solid #eceef0;"><table role="presentation" width="100%"><tr><td style="font:700 12px Arial,sans-serif;letter-spacing:.12em;color:#17191b;">ETA / MAIL</td><td align="right"><span style="padding:6px 10px;background:#f1f3f4;color:#5f6469;font:700 10px Arial,sans-serif;letter-spacing:.08em;">${escape(input.status)}</span></td></tr></table></td></tr>
<tr><td align="center" style="padding:36px 28px 24px;"><img src="cid:eta-logo@eta" width="104" height="104" alt="${escape(encodeLogoAlt(input.envelope))}" style="display:block;border:0;margin:0 auto;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:15px auto 0;"><tr><td style="height:20px;line-height:20px;white-space:nowrap;">${points}</td></tr></table></td></tr>
<tr><td style="padding:0 40px 34px;"><p style="margin:0 0 7px;color:#8a8f94;font:700 10px Arial,sans-serif;letter-spacing:.11em;text-transform:uppercase;">ETA TASK UPDATE</p><h1 style="margin:0 0 20px;color:#17191b;font:700 30px/1.22 Arial,sans-serif;letter-spacing:-.03em;">${escape(input.title)}</h1>${markdownHtml(input.markdown)}${contextBlock(input.envelope.payload)}</td></tr>
${input.ctaUrl ? `<tr><td align="center" style="padding:0 34px 30px;"><a href="${escape(input.ctaUrl)}" style="display:inline-block;min-width:180px;padding:16px 28px;background:#17191b;color:#fff;text-decoration:none;font:600 15px Arial,sans-serif;text-align:center;">Open session</a></td></tr>` : ""}
<tr><td style="padding:24px 40px 34px;border-top:1px solid #eceef0;"><p style="margin:0;color:#8a8f94;font:11px/1.5 ui-monospace,Menlo,monospace;overflow-wrap:anywhere;">${escape(input.messageId)}</p><p style="margin:10px 0 0;color:#9a9fa4;font:10px/1.5 Arial,sans-serif;">This email was sent by ETA. The full agent-side context is in the X-ETA-Payload-* headers, the logo alt, and the data point alt.</p></td></tr>
</table><p style="margin:16px 0 0;color:#9ba0a5;font:10px Arial,sans-serif;letter-spacing:.08em;">ETA MULTI-AGENT COMMUNICATION</p></td></tr></table></body></html>`;
}
