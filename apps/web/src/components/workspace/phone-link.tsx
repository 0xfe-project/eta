import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePhoneLink } from "@/queries/machines";
import { wireErrorMessage } from "@/queries/wire";
import { isLoopback } from "./phone-address";

// Settings → 机器 → 连接手机: the code the phone app scans once. The address is what this page was
// opened at; the token comes from the host, to a client it already let in.

export function PhoneLinkButton() {
  const { t: translateText } = useTranslation(["machines", "common"] as const);
  const phoneLink = usePhoneLink();
  const [link, setLink] = useState<string>();
  const svg = useMemo(
    () => (link === undefined ? undefined : renderSVG(link)),
    [link],
  );
  const open = () => {
    phoneLink.mutate(
      { url: window.location.origin },
      {
        onSuccess: (result) => setLink(result.link),
        onError: (error) => toast.error(wireErrorMessage(error)),
      },
    );
  };
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={phoneLink.isPending}
        onClick={open}
      >
        {translateText("phone.open")}
      </Button>
      <Dialog
        open={link !== undefined}
        onOpenChange={(next) => !next && setLink(undefined)}
      >
        <DialogContent className="max-w-[calc(100%-2rem)] gap-4 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{translateText("phone.title")}</DialogTitle>
            <DialogDescription>
              {isLoopback(window.location.hostname)
                ? translateText("phone.unreachable")
                : translateText("phone.hint")}
            </DialogDescription>
          </DialogHeader>
          {svg === undefined ? null : (
            <img
              alt={translateText("phone.title")}
              className="mx-auto size-56 bg-white p-2"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
