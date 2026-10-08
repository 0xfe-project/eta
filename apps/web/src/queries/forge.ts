import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { forgeApi } from "@/lib/api";

// The forge service's public API (/api/forge/v1): connecting the GitHub App
// that agents act as. See apps/forge-service.

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
