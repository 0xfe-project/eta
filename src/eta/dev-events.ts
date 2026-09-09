/**
 * Battery emissions go straight onto the main HarnessEvent bus as `eta`
 * events (see harness/eta-events.ts); these aliases keep the battery-side
 * vocabulary short.
 */

export type { EtaEventCategory as DevCategory, EtaEventData as DevEventData, EtaEmit as DevEmit } from "../harness/eta-events.ts";
export { ETA_EVENT_CATEGORIES as DEV_CATEGORIES } from "../harness/eta-events.ts";
