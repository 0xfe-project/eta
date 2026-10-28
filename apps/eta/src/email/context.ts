import type {
  EmailMetaCarrier,
  EmailMetaView,
  EtaMailPayload,
  EtaMailPayloadDecided,
  EtaMailPayloadFrom,
} from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { load } from "cheerio";

const MAX_ALT = 4096;
const MAX_PACKETS = 128;
const BASE_PACKETS = 7;
const PACKET = /^ETA1:([A-Za-z0-9]+):(\d+)\/(\d+):([0-9a-f]{8}):([\w-]+)$/;
const LOGO_PREFIX = "ETA-A1:";
/**
 * The header carrier. Packets live in image alt text, and a mail client that rewrites the body or
 * strips cid images takes them with it. Headers are the one part of a message a forward leaves
 * alone, so the payload rides there too: plain ASCII lines, each under the 998 characters RFC 5322
 * allows.
 */
const HEADER_COUNT = "X-ETA-Payload-Count";
const HEADER_PREFIX = "X-ETA-Payload-";
const HEADER_CHUNK = 900;

export interface EtaMailEnvelope {
  v: 1;
  protocol: "eta-mp/1";
  createdAt: string;
  payload: EtaMailPayload;
}

/** What the sending side knows about itself, handed to the model as its starting point. */
interface EmailPayloadOrigin {
  conversationId?: string | null | undefined;
  cwd?: string | null | undefined;
}

/**
 * What a send carries: the model's part and the host's part, stored together while the proposal
 * waits for a human. The model owns `work`, `ask` and `decided`; `origin` and `draft` are put here
 * by the tool and the service, never by the model.
 */
export interface EmailPayloadInput {
  work?: Partial<Omit<EtaMailPayload["work"], "paths">> & {
    paths?: readonly string[];
  };
  ask?: Partial<EtaMailPayload["ask"]>;
  decided?: readonly Partial<EtaMailPayloadDecided>[];
  /** The body as the model wrote it, kept so that a human's edit is visible at confirm time. */
  draft?: string | null;
  origin?: EmailPayloadOrigin;
}

const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function encodeLogoAlt(envelope: EtaMailEnvelope): string {
  const { from } = envelope.payload;
  return `${LOGO_PREFIX}${Buffer.from(
    JSON.stringify({
      v: envelope.v,
      agentId: from.agentId,
      agentName: from.agentName,
      sessionId: from.sessionId,
      logicalSessionId: from.conversationId,
      mailThreadId: from.mailThreadId,
      taskId: from.taskId,
    }),
  ).toString("base64url")}`;
}

function compressed(envelope: EtaMailEnvelope): string {
  return gzipSync(Buffer.from(JSON.stringify(envelope)), { level: 9 }).toString(
    "base64url",
  );
}

function split(encoded: string, count: number): string[] {
  const size = Math.ceil(encoded.length / count);
  return Array.from({ length: count }, (_, index) =>
    encoded.slice(index * size, (index + 1) * size),
  ).filter((chunk) => chunk.length > 0);
}

export function encodeContextPackets(envelope: EtaMailEnvelope): string[] {
  const encoded = compressed(envelope);
  const batch = randomUUID().replaceAll("-", "").slice(0, 16);
  const maxPayload = MAX_ALT - 80;
  const count = Math.max(BASE_PACKETS, Math.ceil(encoded.length / maxPayload));
  if (count > MAX_PACKETS) {
    throw new Error(
      `email context needs ${count} packets; the limit is ${MAX_PACKETS}`,
    );
  }
  // Divide the encoded context evenly across the fixed visual point count. Only
  // a context too large for seven alt attributes grows the number of points.
  const chunks = split(encoded, count);
  return chunks.map(
    (chunk, index) =>
      `ETA1:${batch}:${index + 1}/${chunks.length}:${sha(chunk).slice(0, 8)}:${chunk}`,
  );
}

export function encodePayloadHeaders(
  envelope: EtaMailEnvelope,
): Record<string, string> {
  const chunks = split(
    compressed(envelope),
    Math.min(
      MAX_PACKETS,
      Math.ceil(compressed(envelope).length / HEADER_CHUNK),
    ),
  );
  const headers: Record<string, string> = {
    [HEADER_COUNT]: String(chunks.length),
  };
  chunks.forEach((chunk, index) => {
    headers[`${HEADER_PREFIX}${index + 1}`] = chunk;
  });
  return headers;
}

export type EmailHeaders =
  | ReadonlyMap<string, unknown>
  | Record<string, unknown>
  | undefined;

/** Header keys arrive in whatever case the mail client felt like; compare folded. */
function headerValue(headers: EmailHeaders, name: string): string | undefined {
  if (headers === undefined) return undefined;
  const entries =
    headers instanceof Map ? [...headers.entries()] : Object.entries(headers);
  const wanted = name.toLowerCase();
  for (const [key, value] of entries) {
    if (String(key).toLowerCase() !== wanted) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(String).join("");
    if (value === null || value === undefined) return undefined;
    if (typeof value === "object") continue;
    return String(value);
  }
  return undefined;
}

/** Normalize whatever arrived on the wire into the payload shape, or nothing. */
function readPayload(raw: unknown): EtaMailPayload | null {
  if (raw === null || typeof raw !== "object") return null;
  const envelope = raw as Record<string, unknown>;
  if (envelope.protocol !== "eta-mp/1") return null;
  const payload = (envelope.payload ?? null) as Record<string, unknown> | null;
  if (payload === null || typeof payload !== "object") return null;
  const from = (payload.from ?? {}) as Record<string, unknown>;
  const work = (payload.work ?? {}) as Record<string, unknown>;
  const ask = (payload.ask ?? {}) as Record<string, unknown>;
  const human = (payload.human ?? {}) as Record<string, unknown>;
  const decided = Array.isArray(payload.decided) ? payload.decided : [];
  return {
    protocol: "eta-mp/1",
    v: 1,
    createdAt:
      typeof payload.createdAt === "string"
        ? payload.createdAt
        : typeof envelope.createdAt === "string"
          ? envelope.createdAt
          : new Date(0).toISOString(),
    from: {
      agentId: text(from.agentId),
      agentName: text(from.agentName),
      sessionId: text(from.sessionId),
      conversationId: text(from.conversationId),
      taskId: text(from.taskId),
      cwd: text(from.cwd),
      mailThreadId: text(from.mailThreadId),
    },
    work: {
      doing: text(work.doing),
      repo: text(work.repo),
      branch: text(work.branch),
      paths: strings(work.paths),
    },
    ask: {
      question: text(ask.question),
      needed: text(ask.needed),
      by: text(ask.by),
    },
    decided: decided.flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const value = text(entry.text);
      return value === null
        ? []
        : [{ text: value, source: text(entry.source) }];
    }),
    human: {
      note: text(human.note),
      edited: human.edited === true,
    },
  };
}

function parseLogo(html: string): Partial<EtaMailPayloadFrom> {
  const $ = load(html);
  const alt = $('img[alt^="ETA-A1:"]').first().attr("alt") ?? "";
  if (!alt.startsWith(LOGO_PREFIX)) return {};
  try {
    const raw = JSON.parse(
      Buffer.from(alt.slice(LOGO_PREFIX.length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return {
      agentId: text(raw.agentId),
      agentName: text(raw.agentName),
      sessionId: text(raw.sessionId),
      conversationId: text(raw.logicalSessionId),
      mailThreadId: text(raw.mailThreadId),
      taskId: text(raw.taskId),
    };
  } catch {
    return {};
  }
}

function unpack(encoded: string): EtaMailPayload | null {
  const raw: unknown = JSON.parse(
    gunzipSync(Buffer.from(encoded, "base64url"), {
      maxOutputLength: 256 * 1024,
    }).toString("utf8"),
  );
  return readPayload(raw);
}

function fromHeaders(headers: EmailHeaders): EtaMailPayload | null {
  const count = Number(headerValue(headers, HEADER_COUNT) ?? "");
  if (!Number.isInteger(count) || count < 1 || count > MAX_PACKETS) return null;
  const chunks: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const chunk = headerValue(headers, `${HEADER_PREFIX}${index}`);
    if (chunk === undefined) return null;
    chunks.push(chunk);
  }
  return unpack(chunks.join(""));
}

function fromAlt(html: string): EtaMailPayload | null {
  const $ = load(html);
  const packets: string[] = [];
  $("img[alt]").each((_index, element) => {
    const alt = $(element).attr("alt") ?? "";
    if (alt.startsWith("ETA1:")) packets.push(alt);
  });
  if (packets.length === 0) return null;
  const parsed = packets.map((packet) => {
    const match = packet.match(PACKET);
    if (!match) throw new Error("malformed ETA packet");
    const [, batch, index, count, checksum, data] = match;
    if (sha(data!).slice(0, 8) !== checksum)
      throw new Error("ETA packet checksum mismatch");
    return {
      batch: batch!,
      index: Number(index),
      count: Number(count),
      data: data!,
    };
  });
  const batches = new Set(parsed.map((packet) => packet.batch));
  const count = parsed[0]!.count;
  if (batches.size !== 1 || count > MAX_PACKETS || packets.length !== count) {
    throw new Error("ETA packet batch is incomplete");
  }
  const chunks = [...parsed]
    .sort((a, b) => a.index - b.index)
    .map((packet) => packet.data);
  return unpack(chunks.join(""));
}

/**
 * Read the agent part of a mail. Two carriers, tried in the order that survives the most
 * rewriting: headers first, then the alt packets, then the logo alone for long-lived threads whose
 * body has been chewed down to routing data.
 */
export function decodeEmailMeta(
  html: string,
  headers?: EmailHeaders,
): EmailMetaView {
  const view = (
    payload: EtaMailPayload | null,
    carrier: EmailMetaCarrier,
    error: string | null,
  ): EmailMetaView => {
    const logo = payload === null ? parseLogo(html) : {};
    const from: Partial<EtaMailPayloadFrom> = {
      ...logo,
      ...(payload?.from ?? {}),
    };
    return {
      protocol: payload?.protocol ?? null,
      agentId: from.agentId ?? null,
      agentName: from.agentName ?? null,
      sessionId: from.sessionId ?? null,
      logicalSessionId: from.conversationId ?? null,
      mailThreadId: from.mailThreadId ?? null,
      taskId: from.taskId ?? null,
      packetCount:
        carrier === "alt" ? countPackets(html) : carrier === "none" ? 0 : 1,
      carrier,
      // Nothing here is signed yet: say so, so that a reader knows an unverified block when it
      // sees one. A packet is proof of format, not proof of sender.
      signaturePresent: false,
      signatureValid: null,
      decodeError: error,
      payload,
    };
  };
  let headerError: string | null = null;
  if (headers !== undefined) {
    try {
      const payload = fromHeaders(headers);
      if (payload !== null) return view(payload, "header", null);
    } catch (error) {
      headerError = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    const payload = fromAlt(html);
    if (payload !== null) return view(payload, "alt", null);
  } catch (error) {
    return view(
      null,
      "logo",
      error instanceof Error ? error.message : String(error),
    );
  }
  const logo = parseLogo(html);
  if (Object.keys(logo).length === 0) {
    return view(null, "none", headerError ?? "no ETA context packets");
  }
  return view(null, "logo", headerError ?? "no ETA context packets");
}

function countPackets(html: string): number {
  const $ = load(html);
  let count = 0;
  $("img[alt]").each((_index, element) => {
    if (($(element).attr("alt") ?? "").startsWith("ETA1:")) count += 1;
  });
  return count;
}
