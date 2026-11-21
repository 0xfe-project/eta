import { blobatar } from "blobatar";
import { computed, Image, View } from "nsh";
import { Host } from "../services/host";

/**
 * The agent's face, drawn from its avatar seed, or from its id when it never drew one, so a rename
 * keeps it; the web and the phone app draw the same seed. `seed` draws that face instead: the
 * editor's, while a draw passes over faces or a new one is being saved.
 */
export function AgentFace(props: {
  id?: string | null;
  seed?: string;
  size?: number;
}) {
  const host = Host();
  const size = () => props.size ?? 20;
  const seed = () =>
    props.seed ?? host?.agent(props.id)?.avatarSeed ?? props.id ?? "agent";
  // Blobatar draws inside the middle of a 100x100 box; crop to the blob so the
  // face fills the avatar like the design's solid circle.
  const src = computed(
    () =>
      `data:image/svg+xml;utf8,${encodeURIComponent(
        blobatar(seed()).replace(
          'viewBox="0 0 100 100"',
          'viewBox="16 16 68 68"',
        ),
      )}`,
  );
  return (
    <Image
      src={src()}
      fadeDuration={0}
      style={{ width: size(), height: size(), flexShrink: 0 }}
    />
  );
}

/**
 * The user's own face ("Me"): the design's grey disc with two dark eyes, the
 * same in both themes. The routine report's feedback thread draws it.
 * @public
 */
export function UserFace(props: { size?: number }) {
  const size = () => props.size ?? 20;
  const eye = (left: number) => ({
    position: "absolute" as const,
    left: size() * left,
    top: size() * 0.4,
    width: Math.max(1, Math.round(size() * 0.12)),
    height: Math.max(1, Math.round(size() * 0.2)),
    backgroundColor: "#2b2b2b",
  });
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: size(),
        height: size(),
        borderRadius: size() / 2,
        backgroundColor: "#b8b8b8",
        flexShrink: 0,
      }}
    >
      <View style={eye(0.3)} />
      <View style={eye(0.58)} />
    </View>
  );
}
