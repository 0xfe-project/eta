import type { MessageView } from "@eta/client-contracts";

export interface CaptainReviewItem {
  id: string;
  kind: string;
  body: string;
  data: Record<string, unknown>;
  detail: string;
}

export function isCaptainReviewMessage(message: MessageView): boolean {
  if (message.author !== "system") return false;
  const structured = message.data.captainReview;
  return (
    message.text.includes("<captain-review>") ||
    (typeof structured === "object" && structured !== null)
  );
}

export function reviewItemsOf(message: MessageView): CaptainReviewItem[] {
  const structured = message.data.captainReview;
  if (
    typeof structured === "object" &&
    structured !== null &&
    Array.isArray((structured as { reviews?: unknown }).reviews)
  )
    return (structured as { reviews: unknown[] }).reviews
      .map(structuredReview)
      .filter((review): review is CaptainReviewItem => review !== undefined);
  return parseReviews(message.text);
}

function structuredReview(value: unknown): CaptainReviewItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  if (
    typeof source.kind !== "string" ||
    typeof source.body !== "string" ||
    typeof source.id !== "string"
  )
    return undefined;
  const data =
    typeof source.data === "object" && source.data !== null
      ? (source.data as Record<string, unknown>)
      : {};
  return {
    id: source.id,
    kind: source.kind,
    body: source.body,
    data,
    detail:
      typeof source.detail === "string"
        ? source.detail
        : JSON.stringify(data, null, 2),
  };
}

function parseReviews(text: string): CaptainReviewItem[] {
  const open = text.indexOf("<captain-review>");
  const close = text.lastIndexOf("</captain-review>");
  if (open < 0 || close <= open) return [];
  const source = text.slice(open + "<captain-review>".length, close);
  const headers = [...source.matchAll(/^(\d+)\. \[([^\]]+)\]\s?/gm)];
  return headers.flatMap((header, index) => {
    const start = (header.index ?? 0) + header[0].length;
    const end = headers[index + 1]?.index ?? source.length;
    const content = source.slice(start, end).trim();
    const detailAt = content.indexOf("\n{");
    const body = detailAt < 0 ? content : content.slice(0, detailAt).trim();
    const detail = detailAt < 0 ? "" : content.slice(detailAt + 1).trim();
    let data: Record<string, unknown> = {};
    if (detail !== "") {
      try {
        const parsed: unknown = JSON.parse(detail);
        if (typeof parsed === "object" && parsed !== null)
          data = parsed as Record<string, unknown>;
      } catch {
        // Older or truncated review data still keeps its readable body.
      }
    }
    return [
      {
        id: `${header[1]}:${header[2]}`,
        kind: header[2]!,
        body,
        data,
        detail: detail || JSON.stringify(data, null, 2),
      },
    ];
  });
}
