# Terse actor: Run("halloween")

Durable store for `app/durable.ts` when `TERSE=1`: `done` idempotency keys (exactly-once RFQs/messages/POs) + the whole run state (JSON string), with `phase`/`day` emitted for the dashboard.
Methods: `isDone(key)`, `markDone(key)`, `saveState(json)`, `getState()`, `reset()`.
Layout matches `terse init` output (package.json, tsconfig.json, src/actor.ts, .gitignore). Tested with terse-cli/terse-sdk 0.14.9.

## On your Mac (from repo root)

Option A: use this folder as-is
    cd actor && npm install          # installs terse-sdk + terse-cli locally
    npx terse actor dev              # keep running: http://127.0.0.1:7100, state in actor/.durable-actors/

Option B: scaffold fresh, then paste
    terse init actor                 # creates ./actor
    cp <this repo>/actor/src/actor.ts actor/src/actor.ts   # replace the Counter sample
    cd actor && terse actor dev

Then in a second terminal:
    cd app && npx --prefix ../actor terse actor generate   # (or just `terse actor generate`) → app/generated/
    cd .. && TERSE=1 bun --env-file=.env app/main.ts

Re-run `terse actor generate` only when actor method signatures change.
Env: `TERSE_CLIENT` = path to generated index.js (default app/generated/index.js), `TERSE_RUN_ID` (default "halloween").
If the dev server is down, the app prints `[durable] Terse unavailable` and uses app/.journal.json.
Reset actor state: click Reset in the console, or `rm -rf actor/.durable-actors` with dev stopped.
