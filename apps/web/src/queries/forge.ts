import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { forgeApi } from "@/lib/api";

// The control plane's code hosting API (/api/forge/v1): connecting the
// GitHub App that agents act as. See apps/control-plane/internal/forge.

const installationSchema = z.object({
  id: z.number(),
  account: z.string(),
  account_type: z.string(),
  repository_selection: z.enum(["all", "selected"]),
  repositories: z.array(z.string()),
  total_repositories: z.number(),
  manage_url: z.string().nullable().optional(),
});

const statusSchema = z.object({
  state: z.enum(["not_connected", "not_installed", "ready", "error"]),
  app: z
    .object({
      name: z.string(),
      slug: z.string(),
      owner: z.string(),
      owner_type: z.string(),
      html_url: z.string(),
      settings_url: z.string(),
      install_url: z.string(),
    })
    .nullable(),
  installations: z.array(installationSchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  // Who authorized the App to open pull requests on their behalf, and
  // whether the service can ask (it has the App's client secret).
  user: z.object({ login: z.string(), html_url: z.string() }).nullish(),
  oauth: z.boolean().optional(),
});

const manifestSchema = z.object({ action: z.string(), manifest: z.string() });

export type GitHubStatus = z.infer<typeof statusSchema>;
export type Installation = z.infer<typeof installationSchema>;

const key = ["forge", "github"] as const;

/**
 * The GitHub App's state. Installing happens on GitHub, so while the App
 * waits for its first installation the status is polled; `fresh` skips the
 * service's short cache of installations.
 */
export function useGitHubStatus() {
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      statusSchema.parse(await forgeApi.get("/github?fresh=1", signal)),
    refetchInterval: (query) =>
      query.state.data?.state === "not_installed" ? 5000 : false,
    refetchOnWindowFocus: true,
  });
}

/**
 * Creating the App: GitHub only takes the manifest as a form the browser
 * posts, after which it sends the browser back here.
 */
export function useCreateGitHubApp() {
  return useMutation({
    mutationFn: async (input: { name: string; organization?: string }) => {
      const form = manifestSchema.parse(
        await forgeApi.post("/github/manifest", {
          ...input,
          origin: window.location.origin,
        }),
      );
      const element = document.createElement("form");
      element.method = "post";
      element.action = form.action;
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "manifest";
      field.value = form.manifest;
      element.append(field);
      document.body.append(element);
      element.submit();
    },
  });
}

/** Where GitHub sends the browser back after the user authorized the App. */
export const authorizationCallbackPath =
  "/api/forge/v1/github/authorization/callback";

/** The user authorizing the App to act on their behalf, on GitHub. */
export function useAuthorizeGitHub() {
  return useMutation({
    mutationFn: async () => {
      const { url } = z.object({ url: z.string() }).parse(
        await forgeApi.post("/github/authorization", {
          origin: window.location.origin,
        }),
      );
      window.location.assign(url);
    },
  });
}

export function useUnauthorizeGitHub() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => forgeApi.delete("/github/authorization"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

/** The client ID and secret of an App created before eta kept them. */
export function useSetGitHubOAuthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { client_id: string; client_secret: string }) =>
      forgeApi.post("/github/oauth-client", input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useDisconnectGitHub() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => forgeApi.delete("/github"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useRefreshGitHub() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: key });
}
