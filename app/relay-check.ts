// Print the latest messages in #costume-rush straight from Relaycast (proves traffic goes over Relay)
// Run from repo root:  bun --env-file=.env app/relay-check.ts
import { RelayCast } from "@relaycast/sdk";
const rc: any = new RelayCast({ apiKey: process.env.RELAYCAST_API_KEY! });
const me = await (rc.agents.registerOrGet ?? rc.agents.register)({ name: "observer", type: "human" });
const a = rc.as(me.token);
try { await a.channels.join("costume-rush"); } catch {}
const msgs: any[] = await a.messages("costume-rush", { limit: 30 });
for (const m of msgs) console.log(`${m.agent_name ?? m.agentName ?? m.from ?? "?"}: ${String(m.text).slice(0, 120)}`);
console.log(`\n${msgs.length} messages from Relaycast #costume-rush`);
