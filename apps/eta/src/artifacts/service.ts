import type { ArtifactVersionView, ArtifactView } from "@eta/client-contracts";
import type { Buffer } from "node:buffer";
import type { SiteFile, SiteLimits } from "./files";
import type { ArtifactKinds } from "./kinds";
import type { ArtifactKind } from "./kinds/kind";
/**
 * Artifacts: publishing one, its versions, who may see it.
 *
 * What an artifact is: a title, the agent that publishes it, and versions, each one of a kind
 * (`kinds/`) and judged by it before a byte was stored. What a share is: a token bound to one version, taken back
 * for good by unsharing. What a preview is: an address with an hour's capability in it, because a
 * sandboxed iframe sends no cookie (`capability.ts`).
 *
 * The bytes are files, `<root>/<artifact>/<version>/`, with the ZIP (`archive.zip`) and the site
 * extracted under `files/`. They are written first, and the rows after: a row always has its files,
 * and a directory with no row is a crash's leftover that publishing that number again replaces.
 */
import type { ArtifactRecord, ArtifactStore, VersionRecord } from "./store";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { CAPABILITY_TTL_MS, sign, verify } from "./capability";
import { ArtifactError, checkFiles, packSite } from "./files";
import { DEFAULT_KIND } from "./kinds";

export interface ArtifactServiceDeps {
  store: ArtifactStore;
  /** Where the bytes go: `<dataDir>/artifacts`. */
  root: string;
  limits: SiteLimits;
  /** What a version can be. */
  kinds: ArtifactKinds;
  /** The key capabilities are signed with. */
  key: Buffer;
  /** The list of artifacts moved. */
  changed: () => void;
}

export interface PublishInput {
  title: string;
  files: readonly SiteFile[];
  /** What this version is; a site when absent. */
  kind?: string | undefined;
  /** What the kind is asked for, which it judges and turns into the manifest. */
  options?: unknown;
  /** The artifact to add a version to; absent makes a new one. */
  artifactId?: string | undefined;
  taskId?: string | undefined;
  conversationId?: string | undefined;
  /** Who publishes. Only the agent that made an artifact may add to it. */
  publisherAgentId: string;
}

/** Where a version's public page is. */
const shareUrl = (token: string): string => `/share/${token}/`;
/** What is under a capability or a share is the version, from here on. */
const FILES = "files/";
/** The app's own download of a version's ZIP. */
const archiveUrl = (artifactId: string, version: number): string =>
  `/artifacts/${artifactId}/${version}/archive.zip`;

export class ArtifactService {
  readonly #deps: ArtifactServiceDeps;
  /** Publishing one at a time: two versions of one artifact must not be given the same number. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ArtifactServiceDeps) {
    this.#deps = deps;
  }

  /* ---------------------------------------------------------------- reads */

  list(): ArtifactView[] {
    const { store } = this.#deps;
    const shares = new Map(store.liveShares().map((s) => [s.versionId, s]));
    const versions = new Map<string, VersionRecord[]>();
    for (const version of store.versions())
      versions.set(version.artifactId, [
        ...(versions.get(version.artifactId) ?? []),
        version,
      ]);
    return store
      .list()
      .map((artifact) =>
        this.#viewOf(artifact, versions.get(artifact.id) ?? [], shares),
      );
  }

  view(id: string): ArtifactView | undefined {
    const { store } = this.#deps;
    const artifact = store.get(id);
    if (artifact === undefined) return undefined;
    const shares = new Map(store.liveShares().map((s) => [s.versionId, s]));
    return this.#viewOf(artifact, store.versionsOf(id), shares);
  }

  /** The version a capability opens, if it is genuine, current and for a version that exists. */
  byCapability(
    capability: string,
    now: number = Date.now(),
  ): { artifact: ArtifactRecord; version: VersionRecord } | undefined {
    const versionId = verify(this.#deps.key, capability, now);
    return versionId === undefined ? undefined : this.#opened(versionId);
  }

  /** A published version by artifact and number, for the app's own download. */
  versionOf(
    artifactId: string,
    number: number,
  ): { artifact: ArtifactRecord; version: VersionRecord } | undefined {
    const version = this.#deps.store.version(artifactId, number);
    return version === undefined ? undefined : this.#opened(version.id);
  }

  /** The version a share token opens, until it is unshared. */
  byShare(
    token: string,
  ): { artifact: ArtifactRecord; version: VersionRecord } | undefined {
    const share = this.#deps.store.liveShare(token);
    return share === undefined ? undefined : this.#opened(share.versionId);
  }

  /** The code that answers for a version. A host that lacks it can only offer the ZIP. */
  kindOf(version: VersionRecord): ArtifactKind | undefined {
    return this.#deps.kinds.get(version.kind);
  }

  /** How a version's public page starts. */
  shareEntry(token: string, version: VersionRecord): string {
    return `${shareUrl(token)}${this.#entry(version)}`;
  }

  /**
   * A file of a version, as a path on disk, or nothing for a name that leaves the site. The names
   * were checked on the way in; this is the second lock on the same door, because a name from a
   * request reaches the filesystem here.
   */
  fileOf(version: VersionRecord, name: string): string | undefined {
    const base = join(this.#versionDir(version), "files");
    const target = resolve(base, name);
    return target.startsWith(base + sep) ? target : undefined;
  }

  archiveOf(version: VersionRecord): string {
    return join(this.#versionDir(version), "archive.zip");
  }

  /** An address the app's iframe loads a version from, good for an hour. */
  preview(
    artifactId: string,
    number: number,
    now: number = Date.now(),
  ): { url: string; expiresAt: number } {
    const version = this.#version(artifactId, number);
    const expiresAt = now + CAPABILITY_TTL_MS;
    const capability = sign(this.#deps.key, version.id, expiresAt);
    return {
      url: `/preview/${capability}/${this.#entry(version)}`,
      expiresAt,
    };
  }

  /* ---------------------------------------------------------------- changes */

  /**
   * Publish a new artifact, or a new version of one. It is judged whole first, so a bad one costs
   * nothing and leaves nothing.
   */
  publish(
    input: PublishInput,
  ): Promise<{ artifact: ArtifactRecord; version: VersionRecord }> {
    const run = this.#queue.then(() => this.#publish(input));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Make a version public, or return the page it already has. */
  share(artifactId: string, number: number): ArtifactView {
    const { store } = this.#deps;
    const version = this.#version(artifactId, number);
    if (store.liveShareOf(version.id) === undefined)
      store.addShare(randomBytes(32).toString("base64url"), version.id);
    this.#deps.changed();
    return this.view(artifactId)!;
  }

  /** Take a version's public page away for good. Sharing it again makes a new address. */
  unshare(artifactId: string, number: number): ArtifactView {
    const version = this.#version(artifactId, number);
    this.#deps.store.revokeShares(version.id);
    this.#deps.changed();
    return this.view(artifactId)!;
  }

  /** Delete an artifact and its files. Returns the task it was for, whose cards list it. */
  async remove(id: string): Promise<string | null> {
    const { store, root } = this.#deps;
    const artifact = store.get(id);
    if (artifact === undefined)
      throw new ArtifactError(`no such artifact: ${id}`);
    store.remove(id);
    await rm(join(root, id), { recursive: true, force: true });
    this.#deps.changed();
    return artifact.taskId;
  }

  /* ---------------------------------------------------------------- inside */

  async #publish(
    input: PublishInput,
  ): Promise<{ artifact: ArtifactRecord; version: VersionRecord }> {
    const { store, root } = this.#deps;
    const title = input.title.trim();
    if (title === "") throw new ArtifactError("an artifact needs a title");
    const kindId = input.kind ?? DEFAULT_KIND;
    const kind = this.#deps.kinds.get(kindId);
    if (kind === undefined)
      throw new ArtifactError(`no such kind of artifact: ${kindId}`);
    const total = checkFiles(input.files, this.#deps.limits);
    const manifest = kind.prepare(input.files, input.options);
    const existing =
      input.artifactId === undefined ? undefined : store.get(input.artifactId);
    if (input.artifactId !== undefined && existing === undefined)
      throw new ArtifactError(`no such artifact: ${input.artifactId}`);
    if (
      existing !== undefined &&
      existing.publisherAgentId !== input.publisherAgentId
    ) {
      throw new ArtifactError(
        "only the agent that published this artifact can add a version to it",
      );
    }

    const archive = packSite(input.files);
    const id = existing?.id ?? crypto.randomUUID();
    const version: Omit<VersionRecord, "createdAt"> = {
      id: crypto.randomUUID(),
      artifactId: id,
      number: store.nextNumber(id),
      kind: kind.id,
      manifest: JSON.stringify(manifest),
      files: input.files.length,
      bytes: total,
      size: archive.byteLength,
    };
    const dir = this.#versionDir(version);
    // Whatever a crash left under this number is nobody's.
    await rm(dir, { recursive: true, force: true });
    try {
      for (const file of input.files) {
        const target = join(dir, "files", file.name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.bytes);
      }
      await writeFile(join(dir, "archive.zip"), archive);
      store.addVersion({
        artifact: {
          id,
          title,
          publisherAgentId: input.publisherAgentId,
          // A version published for a task links the artifact to it; one without keeps the link.
          taskId: input.taskId ?? existing?.taskId ?? null,
          conversationId:
            existing?.conversationId ?? input.conversationId ?? null,
        },
        isNew: existing === undefined,
        version,
      });
    } catch (error) {
      await rm(existing === undefined ? join(root, id) : dir, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      throw error;
    }
    this.#deps.changed();
    return {
      artifact: store.get(id)!,
      version: store.version(id, version.number)!,
    };
  }

  #versionDir(version: { artifactId: string; number: number }): string {
    return join(this.#deps.root, version.artifactId, String(version.number));
  }

  /** Where a version opens, under its capability or share: said here and nowhere else. */
  #entry(version: VersionRecord): string {
    const entry = this.kindOf(version)?.entry(JSON.parse(version.manifest));
    return `${FILES}${entry ?? "index.html"}`;
  }

  #version(artifactId: string, number: number): VersionRecord {
    const version = this.#deps.store.version(artifactId, number);
    if (version === undefined)
      throw new ArtifactError(`no such version: ${artifactId} #${number}`);
    return version;
  }

  #opened(
    versionId: string,
  ): { artifact: ArtifactRecord; version: VersionRecord } | undefined {
    const version = this.#deps.store.versionById(versionId);
    const artifact =
      version === undefined
        ? undefined
        : this.#deps.store.get(version.artifactId);
    return version === undefined || artifact === undefined
      ? undefined
      : { artifact, version };
  }

  #viewOf(
    artifact: ArtifactRecord,
    versions: readonly VersionRecord[],
    shares: ReadonlyMap<string, { token: string; createdAt: number }>,
  ): ArtifactView {
    return {
      id: artifact.id,
      title: artifact.title,
      publisherAgentId: artifact.publisherAgentId,
      taskId: artifact.taskId,
      conversationId: artifact.conversationId,
      versions: versions.map((version): ArtifactVersionView => {
        const share = shares.get(version.id);
        return {
          number: version.number,
          kind: version.kind,
          viewer: this.kindOf(version)?.viewer ?? "download",
          files: version.files,
          bytes: version.bytes,
          size: version.size,
          createdAt: version.createdAt,
          archiveUrl: archiveUrl(artifact.id, version.number),
          shareUrl: share === undefined ? null : shareUrl(share.token),
          sharedAt: share?.createdAt ?? null,
        };
      }),
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    };
  }
}
