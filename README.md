# Arribo Rush Desk — Haunted Hacks (team Trick or Trade)

Arribo is an AI buyer for things that are hard to get. Pick a rush order (Labubu blind boxes × 2,400 before Black Friday):
12 suppliers flood in over Agent Relay in 5 languages → Arribo parses every quote with an LLM → verification agents
catch ghost suppliers with live checks (FX, domain age, geocode, photo vision, duplicate photos, price floor, authorized list)
→ a live human plays a factory on Slack and Arribo interrogates them (photo → address → quantity/shipping) → air vs sea →
a human approves the order plan → POs go out exactly once → Black Friday settlement vs a gut-feel buyer.

Suppliers are simulated; every check Arribo runs is live. Money decisions are deterministic code; the LLM only reads and talks.

## Stack
- **Agent Relay (Relaycast)** – every agent (Arribo, 12 suppliers, 3PL, check agents, the Slack human) talks in one channel, one thread per supplier
- **Terse durable actors** – run state + idempotency keys; kill the orchestrator mid-run and it resumes with no duplicate messages or POs (`TERSE=1`)
- **OpenAI** – quote extraction, supplier personas, vision checks on Slack photos, Realtime voice (console)
- **Slack** – live human supplier (bot scopes: chat:write, channels:history, groups:history, files:read, users:read)
- **Bun** – orchestrator + web server (SSE)

## Run (from repo root)
    bun web/server.ts                                   # http://localhost:3000  (replay: /?mode=replay, old console: /console)
    cd app && bun install && cd ..
    bun --env-file=.env app/main.ts                     # add TERSE=1 to use Terse
    cd actor && npm install && npx terse actor dev      # only for TERSE=1

Keys: Space next beat · A approve · T under the hood · D detail console · R reset

.env: OPENAI_API_KEY, RELAYCAST_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID (optional: OPENAI_MODEL, VISION_MODEL, COUNTDOWN_MS, HUMAN_WAIT_MS)

## Layout
- `web/desk.html` – Rush Desk (relationship graph, decision card, thread panel, director beats)
- `web/index.html` – detail console (+ `web/voice.js` live voice call)
- `web/server.ts` – static + SSE + command queue
- `app/main.ts` – orchestrator (scenarios, beats, screening, allocation, settlement)
- `app/checks.ts` – live verification checks; `app/slack.ts` – Slack bridge; `app/durable.ts` – Terse / journal
- `actor/src/actor.ts` – Terse Run actor
- `scenarios/labubu.json`, `config.json` (costume) – scenario data
