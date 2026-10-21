import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAgentList } from "@/queries/agents";

/** Set once the wizard finishes; without it a deliberate zero-install would bounce. */
const onboardedStorageKey = "eta.onboarded.v1";

export function markOnboarded() {
  try {
    localStorage.setItem(onboardedStorageKey, "true");
  } catch {
    // A browser with no storage re-runs the wizard; nothing else breaks.
  }
}

/**
 * A machine with no agents sends its user to `/onboard`: the wizard is where
 * the first agents get made. Once the wizard finished — even with every card
 * unchecked — the person owns the empty state and `/` stays `/`.
 */
export function useOnboardRedirect() {
  const navigate = useNavigate();
  const { agents, loaded } = useAgentList();
  useEffect(() => {
    if (!loaded || agents.length > 0) return;
    let unseen = false;
    try {
      unseen = localStorage.getItem(onboardedStorageKey) === null;
    } catch {
      // No storage: the person has finished the wizard before or reruns it.
    }
    if (unseen) void navigate({ to: "/onboard", replace: true });
  }, [agents.length, loaded, navigate]);
}
