import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { SettingsPage } from "../../pages/settings-page.tsx";
import { useAppI18n } from "../../i18n.ts";
import { closeSettings, settingsOpen } from "../../lib/settings.ts";
import "./settings.css";

export function SettingsHost() {
	return <Show when={settingsOpen()}><SettingsDialog onClose={closeSettings} /></Show>;
}

export function SettingsDialog(props: { onClose(): void }) {
	return <Portal><SettingsDialogContent onClose={props.onClose} /></Portal>;
}

function SettingsDialogContent(props: { onClose(): void }) {
	const i18n = useAppI18n();
	const [dirty, setDirty] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const [discard, setDiscard] = createSignal(false);
	let dialog!: HTMLDialogElement;
	let previousFocus: HTMLElement | null = null;
	const requestClose = () => {
		if (busy()) return;
		if (dirty()) setDiscard(true);
		else props.onClose();
	};
	onMount(() => {
		previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		dialog.showModal();
		onCleanup(() => {
			dialog.close();
			document.body.style.overflow = overflow;
			if (previousFocus?.isConnected) previousFocus.focus();
		});
	});
	return <dialog ref={dialog} class="settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); requestClose(); }}
			onKeyDown={event => {
				event.stopPropagation();
				if (event.key !== "Tab") return;
				const elements = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')].filter(element => element.getClientRects().length > 0);
				const first = elements[0]; const last = elements.at(-1);
				if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
				else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
			}}
			onClick={event => {
				if (event.target !== dialog) return;
				const rect = dialog.getBoundingClientRect();
				if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose();
			}}>
			<header class="settings-header"><div><span class="mono">SETTINGS</span><h1 id="settings-title">{i18n.t("settings.title")}</h1></div><button data-testid="settings-close" disabled={busy()} aria-label={i18n.t("settings.close")} onClick={requestClose}>✕</button></header>
			<SettingsPage onDirtyChange={setDirty} onBusyChange={setBusy} />
			<Show when={discard()}><div class="settings-discard" data-testid="settings-discard" role="alert"><span>{i18n.t("settings.unsaved")}</span><button onClick={() => setDiscard(false)}>{i18n.t("settings.keepEditing")}</button><button data-testid="settings-discard-confirm" onClick={props.onClose}>{i18n.t("settings.discard")}</button></div></Show>
		</dialog>;
}
