/**
 * Load the demo workspace from the command line.
 * Refuses production before any database or auth code is imported.
 *
 *   DEMO_SEED=yes DEMO_PASSWORD='a-long-demo-password' pnpm tsx scripts/seed-demo.mts
 */
import { demoSeedConfig } from "../src/lib/demo-seed-config";

const { password } = demoSeedConfig();
const { loadDemoWorkspace } = await import("../src/lib/demo-workspace");

const result = await loadDemoWorkspace({ actor: { id: "cli", role: "admin" }, password });
console.log(`Demo workspace loaded (${result.applications} applications). The password is DEMO_PASSWORD and is not printed here.`);
