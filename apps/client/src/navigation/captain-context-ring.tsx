import type { CaptainIdentitySection } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { ContextRing, useContextUsage } from "../components/context-ring";
import { useHost } from "../services/host";

/** The Captain's face in the rail, ringed by how full its context is (the shared rule). */
export function CaptainContextRing(props: { children: JSX.Element }) {
  const host = useHost();
  const session = () => {
    const captain = host.section<CaptainIdentitySection>("captain", "identity");
    return (
      captain?.conversation?.participants.find(
        (member) => member.agentId === captain.agentId,
      )?.sessionId ?? undefined
    );
  };
  const usage = useContextUsage(session);
  return (
    // design-value: the ring drawn round the rail's 36px Captain face (box 44, radius 20.5)
    <ContextRing usage={usage} size={44} box={44} radius={20.5} label={false}>
      {props.children}
    </ContextRing>
  );
}
