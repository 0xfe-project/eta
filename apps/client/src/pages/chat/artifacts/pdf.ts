interface RasterPage {
  width: number;
  height: number;
  bytes: Uint8Array;
}

const encoder = new TextEncoder();
// design-value: A4 in PDF points, not a length on screen
const paperWidth = 595.28;
// design-value: A4 in PDF points, not a length on screen
const paperHeight = 841.89;
const margin = 24;

export function decodePdfPage(value: unknown): RasterPage {
  const page = value as { width?: unknown; height?: unknown; jpeg?: unknown };
  if (
    !page ||
    page.width !== 1095 ||
    typeof page.height !== "number" ||
    !Number.isSafeInteger(page.height) ||
    page.height < 1 ||
    page.height > 1590 ||
    typeof page.jpeg !== "string" ||
    page.jpeg.length > 2_500_000
  )
    throw new Error("Invalid page image");
  const image = atob(page.jpeg);
  const bytes = Uint8Array.from(image, (character) => character.charCodeAt(0));
  if (
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    throw new Error("Invalid page image");
  return { width: page.width, height: page.height, bytes };
}

/** Each captured JPEG occupies the printable area of one A4 page. */
export function artifactPdf(pages: RasterPage[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets = [0];
  let size = 0;
  function append(value: Uint8Array | string) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    size += bytes.byteLength;
  }
  function object(id: number, value: string, stream?: Uint8Array) {
    offsets[id] = size;
    append(`${id} 0 obj\n${value}\n`);
    if (stream) {
      append("stream\n");
      append(stream);
      append("\nendstream\n");
    }
    append("endobj\n");
  }
  append("%PDF-1.4\n");
  append(Uint8Array.of(37, 226, 227, 207, 211, 10));
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const children = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  object(2, `<< /Type /Pages /Kids [${children}] /Count ${pages.length} >>`);
  pages.forEach(({ width, height, bytes }, index) => {
    const id = 3 + index * 3;
    const image = id + 1;
    const content = id + 2;
    const drawWidth = paperWidth - margin * 2;
    const drawHeight = Math.min(
      paperHeight - margin * 2,
      (height * drawWidth) / width,
    );
    const y = paperHeight - margin - drawHeight;
    const commands = encoder.encode(
      `q ${drawWidth} 0 0 ${drawHeight.toFixed(2)} ${margin} ${y.toFixed(2)} cm /P Do Q\n`,
    );
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${paperWidth} ${paperHeight}] /Resources << /XObject << /P ${image} 0 R >> >> /Contents ${content} 0 R >>`,
    );
    object(
      image,
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>`,
      bytes,
    );
    object(content, `<< /Length ${commands.length} >>`, commands);
  });
  const xref = size;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1))
    append(`${String(offset).padStart(10, "0")} 00000 n \n`);
  append(
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  const out = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.byteLength;
  }
  return out;
}
