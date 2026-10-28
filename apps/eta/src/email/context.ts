import type { EmailMetaView } from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { load } from "cheerio";

const MAX_ALT = 4096;
const MAX_PACKETS = 128;
const BASE_PACKETS = 7;
const PACKET = /^ETA1:([A-Za-z0-9]+):(\d+)\/(\d+):([0-9a-f]{8}):([\w-]+)$/;

export interface EtaMailEnvelope {
  v: 1;
  protocol: "eta-mp/1";
  agentId: string | null;
  agentName: string | null;
  sessionId: string | null;
  logicalSessionId: string | null;
  mailThreadId: string | null;
  taskId: string | null;
  createdAt: string;
  context: unknown;
}

const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function encodeLogoAlt(envelope: EtaMailEnvelope): string {
  return `ETA-A1:${Buffer.from(
    JSON.stringify({
      v: envelope.v,
      agentId: envelope.agentId,
      agentName: envelope.agentName,
      sessionId: envelope.sessionId,
      logicalSessionId: envelope.logicalSessionId,
      mailThreadId: envelope.mailThreadId,
      taskId: envelope.taskId,
    }),
  ).toString("base64url")}`;
}

export function encodeContextPackets(envelope: EtaMailEnvelope): string[] {
  const compressed = gzipSync(Buffer.from(JSON.stringify(envelope)), {
    level: 9,
  });
  const encoded = compressed.toString("base64url");
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
  const size = Math.ceil(encoded.length / count);
  const chunks = Array.from({ length: count }, (_, index) =>
    encoded.slice(index * size, (index + 1) * size),
  ).filter((chunk) => chunk.length > 0);
  return chunks.map(
    (chunk, index) =>
      `ETA1:${batch}:${index + 1}/${chunks.length}:${sha(chunk).slice(0, 8)}:${chunk}`,
  );
}

function parseLogo(html: string): Partial<EmailMetaView> {
  const $ = load(html);
  const alt = $('img[alt^="ETA-A1:"]').first().attr("alt") ?? "";
  if (!alt.startsWith("ETA-A1:")) return {};
  try {
    const raw = JSON.parse(
      Buffer.from(alt.slice("ETA-A1:".length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return {
      agentId: typeof raw.agentId === "string" ? raw.agentId : null,
      agentName: typeof raw.agentName === "string" ? raw.agentName : null,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
      logicalSessionId:
        typeof raw.logicalSessionId === "string" ? raw.logicalSessionId : null,
      mailThreadId:
        typeof raw.mailThreadId === "string" ? raw.mailThreadId : null,
      taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    };
  } catch {
    return {};
  }
}

export function decodeEmailMeta(html: string): EmailMetaView {
  const fallback = (error: string): EmailMetaView => ({
    protocol: null,
    agentId: null,
    agentName: null,
    sessionId: null,
    logicalSessionId: null,
    mailThreadId: null,
    taskId: null,
    packetCount: 0,
    signaturePresent: false,
    signatureValid: null,
    decodeError: error,
    context: null,
  });
  const $ = load(html);
  const packets: string[] = [];
  $("img[alt]").each((_index, element) => {
    const alt = $(element).attr("alt") ?? "";
    if (alt.startsWith("ETA1:")) packets.push(alt);
  });
  if (packets.length === 0) {
    return {
      ...fallback("no ETA context packets"),
      ...parseLogo(html),
    } as EmailMetaView;
  }
  try {
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
    const envelope = JSON.parse(
      gunzipSync(Buffer.from(chunks.join(""), "base64url"), {
        maxOutputLength: 256 * 1024,
      }).toString("utf8"),
    ) as Partial<EtaMailEnvelope>;
    const logo = parseLogo(html);
    return {
      protocol:
        typeof envelope.protocol === "string" ? envelope.protocol : null,
      agentId: logo.agentId ?? envelope.agentId ?? null,
      agentName: logo.agentName ?? envelope.agentName ?? null,
      sessionId: logo.sessionId ?? envelope.sessionId ?? null,
      logicalSessionId:
        logo.logicalSessionId ?? envelope.logicalSessionId ?? null,
      mailThreadId: logo.mailThreadId ?? envelope.mailThreadId ?? null,
      taskId: logo.taskId ?? envelope.taskId ?? null,
      packetCount: count,
      signaturePresent: false,
      signatureValid: null,
      decodeError: null,
      context: envelope.context ?? null,
    };
  } catch (error) {
    return {
      ...fallback(error instanceof Error ? error.message : String(error)),
      ...parseLogo(html),
    } as EmailMetaView;
  }
}
