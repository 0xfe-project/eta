import { zodResolver } from "@hookform/resolvers/zod";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const promptSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, "Enter a prompt.")
    .max(10_000, "Use 10,000 characters or fewer."),
});

export function PromptPreview() {
  const [preview, setPreview] = useState("");
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof promptSchema>>({
    resolver: zodResolver(promptSchema),
    defaultValues: { prompt: "" },
  });

  return (
    <section className="space-y-4" aria-labelledby="preview-heading">
      <h2 id="preview-heading" className="text-xl font-medium">
        Prompt preview
      </h2>
      <p className="text-muted-foreground">
        Preview Markdown locally. This does not run an agent.
      </p>
      <form
        noValidate
        className="space-y-3"
        onSubmit={handleSubmit(({ prompt }) => {
          setPreview(prompt);
          toast.success("Preview updated");
        })}
      >
        <Label htmlFor="prompt">Prompt</Label>
        <Textarea
          id="prompt"
          rows={5}
          className="min-h-32"
          aria-invalid={Boolean(errors.prompt)}
          aria-describedby={errors.prompt ? "prompt-error" : undefined}
          placeholder="Write a prompt with **Markdown**…"
          {...register("prompt")}
        />
        {errors.prompt ? (
          <p
            id="prompt-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {errors.prompt.message}
          </p>
        ) : null}
        <Button type="submit">
          <PaperPlaneTiltIcon aria-hidden="true" /> Preview prompt
        </Button>
      </form>
      {preview ? (
        <div aria-live="polite" className="border border-border p-4">
          <Markdown>{preview}</Markdown>
        </div>
      ) : null}
    </section>
  );
}
