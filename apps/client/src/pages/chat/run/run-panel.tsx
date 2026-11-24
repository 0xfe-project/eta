import type { JSX } from "nsh";
import { windowSize } from "nsh";
import { Modal } from "../../../components";

/**
 * The frame a whole run is read in: a task run's log, a member's run, a reply's process. Its size
 * does not follow what is in it — 960 wide on a desktop, the window less 144 on a tablet, the
 * window's height less 100 (48 on a tablet) — so a log that grows while it is read does not move
 * the frame. On a phone it is the whole screen, over the tab bar. The body (`MemberRun`) draws its
 * own header and close button off a phone; a phone keeps the page header unless `hideHeader`.
 */
/** A run's panel on a desktop-wide window; narrower windows leave a margin around it. */
const runPanelWidth = 960;

export function RunPanel(props: {
  /** The dialog's name; shown only in a phone's page header. */
  title: string;
  phone: boolean;
  hideHeader?: boolean;
  children: JSX.Element;
  onClose: () => void;
}) {
  const desktop = () => windowSize().width >= 1200;
  return (
    <Modal
      title={props.title}
      width={desktop() ? runPanelWidth : Math.max(0, windowSize().width - 144)}
      height={
        props.phone
          ? "100%"
          : Math.max(0, windowSize().height - (desktop() ? 100 : 48))
      }
      phone={props.phone}
      phonePage={props.phone}
      hideHeader={props.hideHeader ?? !props.phone}
      modalFocus
      overPhoneNavigation
      onClose={props.onClose}
    >
      {props.children}
    </Modal>
  );
}
