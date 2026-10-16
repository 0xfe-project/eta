/**
 * Write the product API's document to a file (REFACTOR.md §9, P2.5).
 *
 * `bun run openapi` — the file the web's `generate` reads. Printing it is the point: redocly (and
 * `openapi-typescript` under it) reads documents from disk, and a document that only exists behind
 * a URL is one CI cannot generate from without a running host.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { productDocument } from "./compat/openapi";

const argOf = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

async function main(): Promise<void> {
  const out = resolve(argOf("--out") ?? "out/openapi.json");
  const url = argOf("--url");
  const document = productDocument(url === undefined ? {} : { url });
  await mkdir(dirname(out), { recursive: true });
  await Bun.write(out, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`[eta] wrote ${out}\n`);
}

main().catch((error: unknown) => {
  console.error(`[eta] ${String(error)}`);
  process.exit(1);
});
