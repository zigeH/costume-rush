// One-time: create a Relaycast workspace and write RELAYCAST_API_KEY into ../.env
// Run from repo root:  bun app/relay-setup.ts
import { RelayCast } from "@relaycast/sdk";
import { join } from "path";
const ENV = join(import.meta.dir, "..", ".env");
const name = "trick-or-trade-" + Date.now().toString(36);
const w: any = await (RelayCast as any).createWorkspace(name);
const key = w.api_key ?? w.apiKey;
if (!key) { console.error("No api key in response:", Object.keys(w)); process.exit(1); }
const lines = (await Bun.file(ENV).text()).split("\n").filter((l) => l && !l.startsWith("RELAYCAST_API_KEY="));
lines.push("RELAYCAST_API_KEY=" + key);
await Bun.write(ENV, lines.join("\n") + "\n");
console.log("Workspace", name, "created; RELAYCAST_API_KEY written to .env (" + key.slice(0, 8) + "…)");
