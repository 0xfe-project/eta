/**
 * @eta/harness/testing — what a package needs to smoke-test itself against a
 * real provider through the assembled session, without copying the script.
 */

export { SESSION_CONFIG, TASKS_STATE } from "../journaling";
export { type JournaledKernel, journaledKernel } from "./journaling";
export {
  runSmokeScenario,
  type SmokeOptions,
  type SmokeReport,
} from "./smoke-scenario";
