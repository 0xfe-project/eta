"use client";

import type { ToasterProps } from "sonner";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { SpinnerIcon } from "@phosphor-icons/react/Spinner";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { Toaster as Sonner } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { t } = useTranslation();
  const { theme = "system", forcedTheme } = useTheme();

  return (
    <Sonner
      containerAriaLabel={t("通知")}
      theme={(forcedTheme ?? theme) as ToasterProps["theme"]}
      className="toaster group"
      offset={{
        bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))",
        right: "max(1rem, env(safe-area-inset-right, 0px))",
      }}
      mobileOffset={{
        bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))",
        right: "max(1rem, env(safe-area-inset-right, 0px))",
        left: "max(1rem, env(safe-area-inset-left, 0px))",
      }}
      icons={{
        success: <CheckCircleIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
        error: <XCircleIcon className="size-4" />,
        loading: <SpinnerIcon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: t("关闭通知"),
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
