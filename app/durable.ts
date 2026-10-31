// Durable layer: exactly-once side effects + resumable run state across kill -9 + restart.
//   TERSE=1  -> Terse durable actor  actors.Run.get(TERSE_RUN_ID ?? "halloween")  (see actor/src/actor.ts)
//   default  -> local journal file app/.journal.json
// If TERSE=1 but the generated client / `terse actor dev` isn't reachable, falls back to the journal.
// Client path: TERSE_CLIENT (default app/generated/index.js, produced by `cd app && terse actor generate`).
import { join, resolve } from "path";

type Store = {
  kind: string;
  isDone(key: string): Promise<boolean>;
  markDone(key: string): Promise<void>;
  save(state: any): Promise<void>;
  load(): Promise<any>;
  reset(): Promise<void>;
};

async function journalStore(): Promise<Store> {
  const FILE = join(import.meta.dir, ".journal.json");
  let J: { done: Record<string, number>; run: any } = { done: {}, run: null };
  try { J = await Bun.file(FILE).json(); } catch {}
  let writing = Promise.resolve();
  const flush = () => (writing = writing.then(() => Bun.write(FILE, JSON.stringify(J)).then(() => {})));
  return {
    kind: "journal",
    async isDone(k) { return !!J.done[k]; },
    async markDone(k) { J.done[k] = Date.now(); await flush(); },
    async save(s) { J.run = s; await flush(); },
    async load() { return J.run; },
    async reset() { J = { done: {}, run: null }; await flush(); },
  };
}

async function terseStore(): Promise<Store> {
  const path = resolve(process.env.TERSE_CLIENT ?? join(import.meta.dir, "generated", "index.js"));
  const { actors } = await import(path);
  const run = actors.Run.get(process.env.TERSE_RUN_ID ?? "halloween");
  await run.isDone("__ping__"); // fail fast if `terse actor dev` isn't running
  let chain: Promise<any> = Promise.resolve();
  const q = <T>(f: () => Promise<T>): Promise<T> => { const p = chain.then(f, f); chain = p.catch(() => {}); return p; }; // keep call order
  return {
    kind: "terse",
    isDone: (k) => q(() => run.isDone(k)),
    markDone: (k) => q(() => run.markDone(k)).then(() => {}),
    save: (s) => q(() => run.saveState(JSON.stringify(s ?? null))),
    load: () => q(async () => { const j = await run.getState(); return j ? JSON.parse(j) : null; }),
    reset: () => q(() => run.reset()),
  };
}

let store: Store;
if (process.env.TERSE === "1") {
  try { store = await terseStore(); console.log("[durable] Terse actor Run backing store"); }
  catch (e: any) { console.warn("[durable] Terse unavailable, using local journal:", e?.message ?? e); store = await journalStore(); }
} else store = await journalStore();

export const durable = {
  kind: store.kind,
  async once(key: string, fn: () => any) {
    if (await store.isDone(key)) return;   // already happened before a crash → skip
    await fn();
    await store.markDone(key);
  },
  saveRun: (state: any) => store.save(state),
  loadRun: () => store.load(),
  reset: () => store.reset(),
};
