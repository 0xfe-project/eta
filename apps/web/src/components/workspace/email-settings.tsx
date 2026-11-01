import type {
  EmailAccountInput,
  EmailAccountView,
} from "@eta/client-contracts";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  useEmail,
  useRemoveEmailAccount,
  useSaveEmailAccount,
  useVerifyEmailAccount,
} from "@/queries/email";
import { wireErrorMessage } from "@/queries/wire";
import { Select, SelectOption } from "./select-field";

const providers = {
  qq: {
    smtpHost: "smtp.qq.com",
    smtpPort: 465,
    imapHost: "imap.qq.com",
    imapPort: 993,
  },
  "163": {
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    imapHost: "imap.163.com",
    imapPort: 993,
  },
  gmail: {
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    imapHost: "imap.gmail.com",
    imapPort: 993,
  },
  outlook: {
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    imapHost: "outlook.office365.com",
    imapPort: 993,
  },
} as const;

type Provider = keyof typeof providers | "custom";

function providerOf(account: EmailAccountView | undefined): Provider {
  if (!account) return "qq";
  return (
    (Object.entries(providers).find(
      ([, preset]) =>
        preset.smtpHost === account.smtpHost &&
        preset.imapHost === account.imapHost,
    )?.[0] as Provider | undefined) ?? "custom"
  );
}

function formOf(account: EmailAccountView | undefined): EmailAccountInput {
  if (!account) return emptyForm();
  return {
    id: account.id,
    name: account.name,
    address: account.address,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapSecure: account.imapSecure,
    inboxFolder: account.inboxFolder,
    junkFolder: account.junkFolder,
    pollIntervalSeconds: account.pollIntervalSeconds,
    username: account.username === account.address ? "" : account.username,
    password: "",
  };
}

function emptyForm(provider: Provider = "qq"): EmailAccountInput {
  const preset = provider === "custom" ? undefined : providers[provider];
  return {
    name: "",
    address: "",
    smtpHost: preset?.smtpHost ?? "",
    smtpPort: preset?.smtpPort ?? 465,
    smtpSecure: (preset?.smtpPort ?? 465) === 465,
    imapHost: preset?.imapHost ?? "",
    imapPort: preset?.imapPort ?? 993,
    imapSecure: true,
    inboxFolder: "INBOX",
    junkFolder: null,
    pollIntervalSeconds: 60,
    username: "",
    password: "",
  };
}

export function EmailAccountForm({
  initial,
  onDone,
  onCancel,
  compact = false,
}: {
  initial?: EmailAccountView | undefined;
  onDone?: () => void;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation(["email", "common"] as const);
  const [provider, setProvider] = useState<Provider>(() => providerOf(initial));
  const [form, setForm] = useState<EmailAccountInput>(() => formOf(initial));
  const [error, setError] = useState<string>();
  const save = useSaveEmailAccount();
  const editing = initial !== undefined;
  const passwordPlaceholder = editing
    ? t("common:labels.configuredPlaceholder")
    : undefined;
  const set = <K extends keyof EmailAccountInput>(
    key: K,
    value: EmailAccountInput[K],
  ) => setForm((current) => ({ ...current, [key]: value }));
  const pickProvider = (next: Provider) => {
    setProvider(next);
    const base = emptyForm(next);
    setForm((current) => ({
      ...current,
      ...base,
      name: current.name,
      address: current.address,
      username: current.username,
      password: current.password,
    }));
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      const result = await save.mutateAsync({
        ...form,
        username: form.username.trim() || form.address.trim(),
      });
      if (result.account.status === "ready") {
        toast.success(t("connected", { address: result.account.address }));
        onDone?.();
      } else {
        setError(result.account.lastError || t("verifyFailed"));
      }
    } catch (cause) {
      setError(wireErrorMessage(cause));
    }
  };
  const field = (
    key: keyof EmailAccountInput,
    label: string,
    type = "text",
    required = false,
  ) => (
    <div className="grid gap-1">
      <Label htmlFor={`email-${key}`}>{label}</Label>
      <Input
        id={`email-${key}`}
        type={type}
        required={required}
        placeholder={
          key === "password"
            ? passwordPlaceholder
            : key === "username"
              ? t("common:labels.usernameSameAsAddress")
              : undefined
        }
        value={String(form[key] ?? "")}
        onChange={(event) => {
          if (type !== "number") {
            set(key, event.target.value as never);
            return;
          }
          const number = Number(event.target.value);
          setForm((current) => ({
            ...current,
            [key]: number,
            ...(key === "smtpPort" ? { smtpSecure: number === 465 } : {}),
            ...(key === "imapPort" ? { imapSecure: number === 993 } : {}),
          }));
        }}
      />
    </div>
  );
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <div className={compact ? "grid gap-3" : "grid gap-3 sm:grid-cols-2"}>
        <div className="grid gap-1">
          <Label htmlFor="email-provider">{t("provider")}</Label>
          <Select
            id="email-provider"
            className="w-full"
            value={provider}
            onValueChange={(value) => pickProvider(value as Provider)}
          >
            <SelectOption value="qq">{t("providers.qq")}</SelectOption>
            <SelectOption value="163">{t("providers.mail163")}</SelectOption>
            <SelectOption value="gmail">{t("providers.gmail")}</SelectOption>
            <SelectOption value="outlook">
              {t("providers.outlook")}
            </SelectOption>
            <SelectOption value="custom">{t("providers.custom")}</SelectOption>
          </Select>
        </div>
        {field("address", t("fields.address"), "email", true)}
        {field("name", t("fields.name"), "text", true)}
        {field("password", t("fields.password"), "password", !editing)}
      </div>
      <details className="border" open={provider === "custom"}>
        <summary className="cursor-pointer px-3 py-2 text-sm">
          {t("advanced")}
        </summary>
        <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
          {field("username", t("fields.username"))}
          {field("smtpHost", t("fields.smtpHost"), "text", true)}
          {field("smtpPort", t("fields.smtpPort"), "number", true)}
          {field("imapHost", t("fields.imapHost"), "text", true)}
          {field("imapPort", t("fields.imapPort"), "number", true)}
          {field("inboxFolder", t("fields.inboxFolder"))}
          <div className="grid gap-1">
            <Label htmlFor="email-junk">{t("fields.junkFolder")}</Label>
            <Input
              id="email-junk"
              placeholder={t("junkAuto")}
              value={form.junkFolder ?? ""}
              onChange={(event) =>
                set("junkFolder", event.target.value || null)
              }
            />
          </div>
        </div>
      </details>
      {error ? (
        <p
          role="alert"
          className="flex gap-2 bg-destructive/10 p-2 text-sm text-destructive"
        >
          <WarningIcon className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending
            ? t("verifying")
            : editing
              ? t("saveAndVerify")
              : t("connect")}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={onCancel}
          >
            {t("common:actions.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function EmailSettings() {
  const { t } = useTranslation(["email", "common"] as const);
  const { accounts } = useEmail();
  const verify = useVerifyEmailAccount();
  const remove = useRemoveEmailAccount();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EmailAccountView>();
  const [removing, setRemoving] = useState<EmailAccountView>();
  const [checking, setChecking] = useState<Set<string>>(() => new Set());
  const closeForm = () => {
    setAdding(false);
    setEditing(undefined);
  };
  const check = async (account: EmailAccountView) => {
    if (checking.has(account.id)) return;
    setChecking((current) => new Set(current).add(account.id));
    try {
      const result = await verify.mutateAsync({ accountId: account.id });
      if (result.account.status === "ready") {
        toast.success(t("checkPassed"));
      } else {
        toast.error(result.account.lastError || t("verifyFailed"));
      }
    } catch (error) {
      toast.error(wireErrorMessage(error));
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(account.id);
        return next;
      });
    }
  };
  const statusOf = (account: EmailAccountView) => {
    if (account.status === "ready") return t("accountStatus.ready");
    if (account.status === "error") {
      return `${t("accountStatus.error")} · ${account.lastError || t("unknownError")}`;
    }
    return t("accountStatus.unverified");
  };
  if (adding || editing) {
    return (
      <div>
        <div className="settings-back">
          <button type="button" onClick={closeForm}>
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            {t("common:actions.back")}
          </button>
        </div>
        <div className="settings-heading">
          <h2>{editing ? t("edit") : t("add")}</h2>
          <p>{t("description")}</p>
          <p>{t("verifyHint")}</p>
        </div>
        <EmailAccountForm
          key={editing?.id ?? "new"}
          initial={editing}
          onDone={closeForm}
        />
      </div>
    );
  }
  return (
    <div>
      <div className="mb-3 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {t("add")}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("description")}
        </p>
      </div>
      {accounts.length === 0 ? (
        <p className="border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="divide-y border">
          {accounts.map((account) => (
            <li key={account.id} className="flex items-start gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{account.name}</div>
                <div
                  className="truncate text-xs text-muted-foreground"
                  title={`${account.address} · ${account.imapHost}`}
                >
                  {account.address} · {account.imapHost}
                </div>
                <div
                  className={cn(
                    "text-xs break-words",
                    account.status === "error"
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {statusOf(account)}
                </div>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("accessibility.editAccount", {
                  address: account.address,
                })}
                onClick={() => {
                  setAdding(false);
                  setEditing(account);
                }}
              >
                <PencilSimpleIcon aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={checking.has(account.id)}
                aria-busy={checking.has(account.id)}
                onClick={() => void check(account)}
              >
                {checking.has(account.id) ? t("verifying") : t("verify")}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("accessibility.removeAccount", {
                  address: account.address,
                })}
                onClick={() => setRemoving(account)}
              >
                <TrashIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("removeConfirm.title", { name: removing?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeConfirm.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!removing) return;
                remove.mutate(
                  { accountId: removing.id },
                  {
                    onError: (error) => toast.error(wireErrorMessage(error)),
                  },
                );
              }}
            >
              {t("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
