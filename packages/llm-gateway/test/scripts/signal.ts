/**
 * A loaded gateway must not take the process's signals. Go's runtime, loaded as a shared
 * library, installs handlers for the signals it needs (SIGSEGV, SIGPIPE, SIGURG...) and hands the
 * rest on; nothing in CPA's SDK listens for SIGTERM. So the handler registered here has to run
 * when the process is sent one, and so must the one for SIGINT.
 */
import process from "node:process";
import { fakeUpstream, gatewayOn } from "../fake-upstream";

const upstream = fakeUpstream();
const gateway = await gatewayOn(upstream);

const signal = (process.argv[2] ?? "SIGTERM") as NodeJS.Signals;
process.on(signal, () => {
  console.log(`bun ${signal} handler ran`);
  gateway.stop();
  upstream.stop();
  process.exit(0);
});
setTimeout(() => process.kill(process.pid, signal), 200);
setTimeout(() => {
  console.log(`${signal} handler did NOT run`);
  process.exit(2);
}, 5000);
