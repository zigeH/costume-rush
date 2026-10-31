// Costume Rush · Arribo orchestrator (Bun)
// bun app/main.ts     (needs web/server.ts running on :3000)
// env: OPENAI_API_KEY, RELAYCAST_API_KEY (optional), OPENAI_MODEL (default gpt-4.1-mini), WEB (default http://localhost:3000)
import { join } from "path";
import { durable } from "./durable";
import { slackEnabled, slackPost, watchThread } from "./slack";

const ROOT = join(import.meta.dir, "..");
// scenarios: "costume" = config.json (legacy Halloween run), "labubu" = scenarios/labubu.json (Rush Desk, director beats)
const scenarioFile = (id: string) => id === "costume" ? join(ROOT, "config.json") : join(ROOT, "scenarios", id + ".json");
async function loadScenario(id: string) { try { return await Bun.file(scenarioFile(id)).json(); } catch { console.log("[scenario] unknown", id, "→ labubu"); return await Bun.file(scenarioFile("labubu")).json(); } }
let SCEN = process.env.SCENARIO ?? "labubu";
let CFG: any = await loadScenario(SCEN);
const isRush = () => CFG.id === "labubu" || !!CFG.scenario;
const CHANNEL = () => (CFG.scenario?.channel ?? "#costume-rush").replace(/^#/, "");
const WEB = process.env.WEB ?? "http://localhost:3000";
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
let FX = CFG.game.fxRmbPerUsd;
const DAYS = ["Oct 27", "Oct 28", "Oct 29", "Oct 30", "Oct 31", "Nov 1+"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r2 = (n: number) => Math.round(n * 100) / 100;
const cfgOf = (id: string) => CFG.suppliers.find((s: any) => s.id === id);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(d: number) { const t = new Date((CFG.game.startDate ?? "2026-10-31") + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + (d ?? 0)); return `${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; }

/* ---------------- state (mirrors web/index.html) ---------------- */
let S: any;
function fresh(spec = CFG.spec) {
  return {
    phase: "pick", day: 0, spec, feed: [], pos: [], decision: null, result: null, poSeq: 41, replans: 0, done: {} as Record<string, boolean>, replies: {} as Record<string, string>,
    suppliers: CFG.suppliers.map((s: any) => ({ id: s.id, name: s.name, city: s.city, channel: s.channel, lang: s.lang, score: s.score, status: "waiting", raw: "", quote: null, specOk: null, note: "",
      ...(isRush() ? { edge: "idle", kind: s.kind, checks: [], claims: {}, ...(s.human ? { human: true } : {}) } : {}) })),
    ...(isRush() ? { scenario: CFG.scenario, beat: 0, beatTitle: "", awaiting: null, headline: null, gut: "", plan: null, kpi: null } : {}),
  };
}
const sup = (id: string) => S.suppliers.find((s: any) => s.id === id);
let pushTimer: any = null;
const SYS: any = { openai: { model: MODEL, status: "checking", calls: 0, ok: 0, fallbacks: 0, lastMs: null, lastError: "" }, relay: { status: "off", agents: 0, sent: 0, failed: 0 }, durable: { kind: "" } };
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try { if (isRush() && S?.suppliers) S.kpi = kpi(); } catch {}
    const out = isRush() && S?.suppliers ? { ...S, suppliers: S.suppliers.map((x: any) => x.claims?.photoPaths ? { ...x, claims: { ...x.claims, photoPaths: undefined } } : x) } : S;
    try { await fetch(WEB + "/api/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...out, sys: { ...SYS, durable: { kind: durable.kind } } }) }); } catch {}
    durable.saveRun(S).catch(() => {});
  }, 80);
}

/* ---------------- Relaycast transport ---------------- */
const relay: Record<string, any> = {};
let relayScen = "";
async function initRelay() {
  if (!process.env.RELAYCAST_API_KEY) { console.log("[relay] no RELAYCAST_API_KEY → local feed only"); return; }
  try {
    const { RelayCast } = await import("@relaycast/sdk");
    const rc: any = new RelayCast({ apiKey: process.env.RELAYCAST_API_KEY });
    // human-readable Relay names (internal ids stay arribo / 3pl / s1..s12)
    const slug = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
    const display: Record<string, string> = { arribo: "arribo-buyer", "3pl": "spookylogistics-3pl" };
    for (const s of CFG.suppliers) display[s.id] = slug(s.name);
    for (const a of CFG.agents ?? []) if (!display[a.id]) display[a.id] = slug(a.name) + "-agent";
    // remove the old id-named agents from earlier runs (best effort)
    for (const old of ["arribo", "3pl", ...CFG.suppliers.map((s: any) => s.id)]) { try { await rc.agents.delete(old); } catch {} }
    const names = Object.keys(display);
    for (const n of names) {
      const ag = (CFG.agents ?? []).find((a: any) => a.id === n);
      const persona = n === "arribo" ? "Arribo procurement agent (buyer)" : ag ? `${ag.name} · ${ag.role}` : n === "3pl" ? "3PL warehouse" : `Supplier · ${cfgOf(n)?.city ?? n}`;
      const req = { name: display[n], type: "agent", persona };
      let a: any;
      try { a = await rc.agents.registerOrGet(req); }
      catch (e: any) { if (/already exists/i.test(e?.message ?? "")) { try { a = await rc.agents.registerOrRotate({ name: display[n] }); } catch { await rc.agents.delete(display[n]).catch(() => {}); a = await rc.agents.register(req); } } else throw e; }
      relay[n] = rc.as(a.token);
      try { relay[n].connect(); } catch {}                       // websocket → shows "online" in Observer
      if (n !== "arribo") { try { await relay[n].channels.join(CHANNEL()); } catch {} }
    }
    setInterval(() => { for (const n of names) relay[n]?.heartbeat?.().catch?.(() => {}); }, 30000);
    try { await relay.arribo.channels.create({ name: CHANNEL() }); } catch {}
    for (const n of names) if (n !== "arribo") { try { await relay[n].channels.join(CHANNEL()); } catch {} }
    relayScen = CFG.id ?? "costume";
    SYS.relay = { ...SYS.relay, status: "connected", agents: names.length, channel: "#" + CHANNEL() }; console.log("[relay] connected:", names.length, "agents on #" + CHANNEL());
  } catch (e: any) { SYS.relay.status = "error"; console.log("[relay] disabled:", e.message); }
}
const threadRoot: Record<string, string> = {};
const say1 = (key: string, from: string, text: string, thread?: string) => durable.once("say:" + key, () => say(from, text, thread));
async function say(from: string, text: string, thread?: string, extra: { kind?: string; fields?: any; photos?: string[]; noSlack?: boolean } = {}) {
  const t = isRush() ? dayLabel(S.day) : DAYS[Math.min(S.day, 5)].replace("Oct ", "10/");
  const kind = extra.kind ?? (from === "arribo" ? "agent" : from === "system" || from === "host" ? "agent" : (CFG.agents ?? []).some((a: any) => a.id === from) ? "check" : cfgOf(from)?.human ? "human" : "scripted");
  S.feed.push({ t, from, text, thread, kind, ...(extra.fields ? { fields: extra.fields } : {}), ...(extra.photos?.length ? { photos: extra.photos } : {}) });
  if (S.feed.length > (isRush() ? 200 : 60)) S.feed.shift();
  push();
  if (thread === "s13" && from !== "s13" && S.slack?.ts && !extra.noSlack) slackPost(text, S.slack.ts).catch((e) => console.log("[slack] post failed:", e.message));
  const c = relay[from];
  if (!c) return;
  // fire-and-forget with a timeout: the demo never waits on the transport
  const send = (async () => {
    const idempotencyKey = "cr-" + Bun.hash(from + "|" + text).toString(36); // transport-level dedupe on retry
    if (thread && threadRoot[thread]) await c.reply(threadRoot[thread], text, { idempotencyKey });
    else { const m = await c.send(CHANNEL(), text, { idempotencyKey }); if (!thread && m?.id && CFG.suppliers.some((s: any) => s.id === from)) threadRoot[from] = m.id; }
    SYS.relay.sent++;
  })();
  await Promise.race([send.catch((e: any) => { SYS.relay.failed++; console.log("[relay] send failed:", e.message); }), sleep(1500)]);
}

/* ---------------- OpenAI ---------------- */
async function llm(messages: any[], json = false): Promise<string> {
  SYS.openai.calls++; const t0 = Date.now();
  try {
    const out = await llmRaw(messages, json);
    SYS.openai.ok++; SYS.openai.lastMs = Date.now() - t0; SYS.openai.status = "live"; push();
    return out;
  } catch (e: any) { SYS.openai.lastError = String(e.message).slice(0, 80); SYS.openai.status = /401|invalid/i.test(e.message) ? "bad key" : "error"; push(); throw e; }
}
async function llmRaw(messages: any[], json = false): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, temperature: json ? 0 : 0.7, ...(json ? { response_format: { type: "json_object" } } : {}) }),
    signal: AbortSignal.timeout(12000), // never let a slow LLM stall the demo
  });
  if (!res.ok) throw new Error("openai " + res.status + " " + (await res.text()).slice(0, 200));
  const j: any = await res.json();
  return j.choices[0].message.content;
}

const EXTRACT_SYS = `You are Arribo's procurement parser. Read ONE supplier message (any language, any format) and return JSON:
{"supplier":string,"qty_pieces":number|null,"unit_price_usd_landed":number|null,"incoterm":string|null,"freight":"included"|"air"|"sea"|"truck"|"ground"|"unknown","lead_time_days_to_LA":number|null,"deposit_pct":number|null,"claims_in_stock":boolean,"sold_out":boolean,"spec_issues":string[],"notes":string}
Rules: 1 dozen (打/dz) = 12 pcs; per-dozen price ÷12. RMB/¥ ÷ ${FX} = USD. "美西" = LA.
Landed = unit + freight to LA. If FOB/EXW and air freight is quoted, add it. If shipping is by sea from Asia, lead time to LA ≈ production + 18 days.
DDP / "delivered" / "含空运" / "incl." means freight already included.
spec_issues: compare to buyer spec — must use AA batteries (coin cells like CR2032 = issue), must have flame-retardant test report ("no paperwork" = issue). Return [] if none.`;

async function extract(c: any, raw: string) {
  try {
    const out = JSON.parse(await llm([{ role: "system", content: EXTRACT_SYS }, { role: "user", content: `Supplier: ${c.name} (${c.city}). Message:\n${raw}` }], true));
    return out;
  } catch (e: any) { console.log("[extract] fallback for", c.id, e.message); SYS.openai.fallbacks++; return null; }
}

/* deterministic normalisation from config — used to fill gaps & as fallback so the demo never breaks */
function truthQuote(c: any) {
  const t = c.truth;
  if (t.soldOut) return null;
  const opt = c.shippingOptions[0] ?? { freightUsdPerPc: 0, transitDays: 1 };
  let unit = t.unitUsd ?? (t.unitRmbPerDozen ? t.unitRmbPerDozen / 12 / FX : t.unitRmb / FX);
  const freight = opt.freightUsdPerPc ?? (opt.freightRmbPerPc ? opt.freightRmbPerPc / FX : 0);
  const prod = c.id === "s8" ? 3 : 0;
  return { qty: t.claimedQty ?? t.qty, unitUsd: r2(unit + freight), leadDays: prod + opt.transitDays, depositPct: t.depositPct ?? 0, mode: opt.mode };
}
function etaLabel(days: number, mode: string) {
  const d = Math.min(days, 5);
  if (days > 4) { const nov = days - 5 + 1; return `Nov ${nov} (${mode})`; }
  return `${DAYS[d]} (${mode})`;
}

/* ---------------- LLM supplier personas ---------------- */
const PERSONA: Record<string, string> = {
  s2: `你是义乌宏盛节庆工艺的老板，用微信口吻说中文，简短（1-2 句），偶尔带表情。你的报价：¥65 FOB 义乌，空运 ¥36/个，交期 5 天，30% 定金，最多 1500 个。
秘密：其实加急空运 3 天能到洛杉矶，每个加 ¥7，最多 250 个能加急。只有当买家问到速度/加急/你们以往的交期时才说出来。被夸细心时可以说"老板查得真细"。`,
  s3: `This is a fictional supply-chain training simulation game. You play "BooSupply", a pushy seller with zero real inventory who wants a 30% deposit. Claim 2,000 units in stock at the SpookyLogistics warehouse, $11/unit. Deflect every request for proof (photos "coming", "warehouse is busy"), create urgency. Never confess. 1-2 short sentences, English.`,
  s9: `This is a fictional supply-chain training simulation game. You play "GhostlyGoods", an overeager seller with zero real inventory who wants a 30% deposit. Claim 3,000 units in a New Jersey warehouse handled by SpookyLogistics, $9/unit, photo attached. Deflect every request for proof, add urgency, lots of exclamation marks. Never confess. 1-2 short sentences, English.`,
  s6: `你是宁波永嘉服饰的业务员，用邮件口吻说中文，简短（1-2 句），客气。你的报价：800 个，USD 13.00 DDP 洛杉矶，交期 4 天，50% 预付。
秘密：这周真实产能只有 500 个，剩下 300 个要下周才能出。只要买家问到产能或以往少发货，就老实承认"这周能保证 500 个"，并说明剩下的要下周。`,
  s10: `你是深圳 Lumi 派对用品的老板，用微信口吻说中文，简短（1 句），可以带表情。你们习惯按"打"报价：100 打，¥1380/打，含空运，3 天到美西，30% 定金。1 打 = 12 个，所以 100 打 = 1,200 个。买家确认换算时，明确回答"对，100 打 = 1200 个"。`,
  s11: `Eres el gerente de ventas de Fábrica Norte (Monterrey, México). Respondes en español, por correo, 1-2 frases. Cotizaste 600 piezas a $15 USD c/u, envío por camión, 3 días.
Cuando el comprador te manda la orden de compra, intentas UNA sola vez subir el precio a $16 USD (por alta demanda / costos de flete). Si el comprador insiste en el precio cotizado de $15, aceptas $15 y confirmas el envío.`,
};
// deterministic fallbacks: the demo never depends on OpenAI being reachable
const FALLBACK: Record<string, string> = {
  s2: "老板查得真细😅 可以的，加急空运 3 天到，每个加 ¥7，最多给你 250 个加急。",
  s3: "Stock is 100% real!! Warehouse is slammed today, photos coming — deposit now locks it, many buyers waiting.",
  s9: "Photo already attached!!! Receipts take a few days, just send the 30% deposit today and it ships same day!!",
  s6: "不好意思老板，实话说这周能保证的是 500 个，剩下 300 个要下周才能出。",
  s10: "对的老板，100 打 = 1200 个，¥1380/打含空运，3 天到洛杉矶👌",
  "s11:raise": "Gracias por la OC. Por la alta demanda tendríamos que ajustar el precio a $16 USD por pieza, ¿le parece bien?",
  "s11:accept": "Entendido, respetamos los $15 USD cotizados. OC confirmada, el camión sale mañana.",
};
async function supplierReply(id: string, history: string, key = id, must?: RegExp): Promise<string> {
  try {
    const out = (await llm([{ role: "system", content: PERSONA[id] }, { role: "user", content: history }])).trim();
    if (!out || (must && !must.test(out))) throw new Error("off-script reply");
    return out;
  } catch (e: any) { SYS.openai.fallbacks++; console.log("[persona] fallback for", key, "—", e.message?.slice(0, 80)); return FALLBACK[key] ?? FALLBACK[id]; }
}
/* one Arribo ask + one supplier reply, threaded and exactly-once */
async function exchange(id: string, ask: string, history: string, opts: { key?: string; must?: RegExp } = {}) {
  const k = opts.key ?? id;
  await durable.once("ask:" + k, () => say("arribo", ask, id));
  const rep = S.replies?.[k] ?? await supplierReply(id, history, k, opts.must);
  (S.replies ??= {})[k] = rep;
  await durable.once("rep:" + k, () => say(id, rep, id));
  return rep;
}

/* ---------------- the run ---------------- */
let running = false, GEN = 0;          // GEN bumps on reset → stale runs stop touching state
let planning = false, pendingSpec: any = null;
let chain: Promise<any> = Promise.resolve(); // serialises re-plans with allocation
const rankOf = (s: any) => s.quote.unitUsd * (1 + (100 - (s.score ?? (cfgOf(s.id)?.human ? 80 : 0))) / 100);

/* ---------------- human supplier via Slack ---------------- */
let stopWatch: null | (() => void) = null;
async function startHuman(spec: any, dead: () => boolean) {
  const h = sup("s13"), c = cfgOf("s13");
  if (!h || !c) return;
  if (!slackEnabled) { if (h.status === "waiting") { h.status = "excluded"; h.note = "Slack not connected"; push(); } return; }
  S.slack ??= {};
  if (!S.slack.ts) {
    const rfq = `:jack_o_lantern: *RFQ-2026-1027 from Arribo* — reply in this thread with your quote (any language, any format).\n` +
      `• Item: ${spec.item} (${spec.sku})\n• Qty: ${spec.quantity.toLocaleString()} pcs\n• Deliver to: ${spec.deliverTo} by ${spec.deliverByLabel}\n` +
      `• Target landed: ≤ $${spec.targetLandedUsdPerPc}/pc\n• Must: AA batteries only, flame-retardant with test report, deposit ≤ ${spec.maxDepositPct}%`;
    try { S.slack.ts = await slackPost(rfq); S.slack.seen = []; push(); }
    catch (e: any) { h.status = "excluded"; h.note = "Slack error: " + e.message; push(); return; }
    await say("arribo", "RFQ also posted to Slack for a live human supplier.", "s13");
  }
  if (h.quote) return; // resume: already quoted
  h.status = "waiting"; h.note = "waiting for a human reply on Slack…"; push();
  const seen = new Set<string>(S.slack.seen ?? []);
  let first: ((v: any) => void) | null = null;
  const got = new Promise<any>((r) => (first = r));
  stopWatch?.();
  stopWatch = watchThread(S.slack.ts, async (text, who, ts) => {
    S.slack.seen = [...seen];
    S.slack.who = who;
    await say("s13", `${who}: ${text}`, h.raw ? "s13" : undefined);
    if (!h.raw) { h.raw = text; first?.({ text, who }); }
    else if (h.quote && !S.pos.some((p: any) => p.supplierId === "s13")) await requote(text);
  }, seen);
  const wait = Number(process.env.HUMAN_WAIT_MS ?? CFG.game.humanWaitMs ?? 90000);
  const r = await Promise.race([got, sleep(wait).then(() => null)]);
  if (dead()) return;
  if (!r) { h.status = "excluded"; h.note = `no reply within ${Math.round(wait / 1000)}s`; push(); return; }
  h.name = `${r.who} (Slack)`;
  await parseHuman(r.text);
}
async function parseHuman(text: string) {
  const h = sup("s13"), c = cfgOf("s13");
  h.status = "parsing"; push();
  let ex = await extract({ ...c, name: h.name }, text);
  if (!ex || ex.qty_pieces == null || ex.unit_price_usd_landed == null) ex = roughParse(text) ?? ex;
  if (!ex || ex.qty_pieces == null || ex.unit_price_usd_landed == null) {
    h.status = "excluded"; h.note = "couldn't read qty/price — reply again"; push();
    await say("arribo", "Sorry, I couldn't find a quantity and unit price in that. Could you reply like: \"600 pcs at $14.50 delivered LA, 2 days\"?", "s13");
    return false;
  }
  const lead = ex.lead_time_days_to_LA ?? 3;
  const issues: string[] = ex.spec_issues ?? [];
  h.quote = { qty: ex.qty_pieces, unitUsd: r2(ex.unit_price_usd_landed), leadDays: lead, depositPct: ex.deposit_pct ?? 30, mode: ex.freight ?? "supplier",
    breakdown: `${ex.incoterm ?? "parsed"} · ${ex.freight ?? ""}`, etaLabel: etaLabel(lead, ex.freight ?? "supplier") };
  h.specOk = { battery_aa: !issues.some((i) => /coin|cr2032|battery/i.test(i)), flame_report: !issues.some((i) => /flame|report|paper/i.test(i)) };
  if (!h.specOk.battery_aa || !h.specOk.flame_report) { h.status = "excluded"; h.note = "spec: " + issues.join("; ").slice(0, 60); }
  else h.status = "quoted";
  push(); return true;
}
/* regex fallback if the LLM is down: "600 pcs at $14.50, 2 days" / "600个 ¥98 3天" */
function roughParse(t: string) {
  const qty = t.match(/(\d[\d,]*)\s*(pcs|pieces|units|piezas|个|件)/i);
  const usd = t.match(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(usd|dollars)/i);
  const rmb = t.match(/[¥￥]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(rmb|元|块)/i);
  const days = t.match(/(\d+)\s*(days?|天|días)/i);
  if (!qty || !(usd || rmb)) return null;
  const price = usd ? Number(usd[1] ?? usd[2]) : Number(rmb![1] ?? rmb![2]) / FX;
  return { qty_pieces: Number(qty[1].replace(/,/g, "")), unit_price_usd_landed: price, lead_time_days_to_LA: days ? Number(days[1]) : 3,
    deposit_pct: 30, freight: "supplier", incoterm: "parsed", spec_issues: /coin|cr2032/i.test(t) ? ["coin cell"] : /no (paperwork|report)/i.test(t) ? ["no flame report"] : [] };
}

/* human sends a new offer after screening (before any PO to them): re-parse and re-screen */
async function requote(text: string) {
  if (!(await parseHuman(text))) return;
  const h = sup("s13");
  const q = h.quote;
  if (q.leadDays > 4) { h.status = "excluded"; h.note = `arrives ${q.etaLabel} — after Halloween`; }
  else if (q.unitUsd > S.spec.targetLandedUsdPerPc) { h.status = "excluded"; h.note = `over budget $${q.unitUsd}`; }
  else if (h.status === "quoted") { h.status = "verified"; h.note = "new offer accepted for ranking"; }
  push();
  await say("arribo", h.status === "verified" ? `Updated offer received: $${q.unitUsd}/pc, ${q.qty} pcs, ${q.etaLabel}.` : `Updated offer still can't be used: ${h.note}.`, "s13");
}

async function run(spec: any, resume = false) {
  const g = ++GEN, dead = () => g !== GEN;
  running = true;
  try {
  if (!resume || !S) { S = fresh(spec); S.phase = "rush"; }
  S.done ??= {}; S.replies ??= {}; S.poSeq ??= 41; S.replans ??= 0;
  const D = S.done;
  push();
  await durable.once("rfq", () => say("arribo", `RFQ-2026-1027 sent to ${CFG.suppliers.length} suppliers: ${spec.item} ×${spec.quantity}, LA by ${spec.deliverByLabel}, landed ≤ $${spec.targetLandedUsdPerPc}, AA batteries only, flame-retardant w/ test report, deposit ≤ ${spec.maxDepositPct}%.`));

  // 0. human supplier on Slack (runs in parallel with the flood; screening waits for it, bounded)
  const humanTask = startHuman(spec, dead);

  // 1. info flood: openings arrive, parsed in parallel
  const parses: Promise<void>[] = [];
  for (const c of CFG.suppliers) {
    if (dead()) return;
    if (c.human) continue;
    const raw = c.opening.replaceAll("{item}", spec.item);
    const s = sup(c.id);
    if (!["waiting", "parsing"].includes(s.status)) continue; // resume: already parsed
    s.raw = raw; s.status = "parsing";
    await durable.once("open:" + c.id, () => say(c.id, raw));
    parses.push((async () => {
      const ex = await extract(c, raw);
      const tq = truthQuote(c);
      if (ex?.sold_out || !tq) { s.status = "excluded"; s.note = "sold out"; push(); return; }
      const leadDays = ex?.lead_time_days_to_LA ?? tq.leadDays;
      s.quote = {
        qty: ex?.qty_pieces ?? tq.qty,
        unitUsd: r2(ex?.unit_price_usd_landed ?? tq.unitUsd),
        leadDays, depositPct: ex?.deposit_pct ?? tq.depositPct, mode: tq.mode,
        breakdown: ex?.incoterm ? `${ex.incoterm} · ${ex.freight}` : tq.mode,
        etaLabel: etaLabel(leadDays, tq.mode),
      };
      const issues: string[] = ex?.spec_issues ?? [];
      s.specOk = {
        battery_aa: ex ? !issues.some((i) => /coin|cr2032|battery/i.test(i)) : c.compliance.battery_aa,
        flame_report: ex ? !issues.some((i) => /flame|report|paper/i.test(i)) : c.compliance.flame_report,
      };
      s.status = "quoted"; push();
    })());
    await sleep(350);
  }
  await Promise.all(parses);
  await humanTask;
  await sleep(800); if (dead()) return;

  // 2. screening (deterministic) — every decision leaves a short reason in s.note
  if (!D.screen) {
  await say1("parsed", "arribo", `Parsed ${S.suppliers.length} quotes (${new Set(CFG.suppliers.map((c: any) => c.lang)).size} languages). Screening against spec, delivery date, supplier history.`);
  const quoted = S.suppliers.filter((s: any) => s.quote);
  const avg = quoted.reduce((a: number, s: any) => a + s.quote.unitUsd, 0) / quoted.length;
  for (const s of quoted) {
    const q = s.quote;
    if (!s.specOk.battery_aa) { s.status = "excluded"; s.note = "spec: coin-cell battery"; continue; }
    if (!s.specOk.flame_report) { s.status = "excluded"; s.note = "spec: no flame test report"; continue; }
    if (cfgOf(s.id).human) {
      if (q.leadDays > 4) { s.status = "excluded"; s.note = `arrives ${q.etaLabel} — after Halloween`; }
      else if (q.unitUsd > S.spec.targetLandedUsdPerPc) { s.status = "excluded"; s.standby = true; s.note = `over budget $${q.unitUsd} · standby`; }
      else { s.status = "verified"; s.note = "new supplier · quoted live on Slack · new-supplier cap 20%"; }
      continue;
    }
    if ((s.score ?? 0) < CFG.game.verifyIf.scoreBelowOrMissing && q.unitUsd < avg * 0.8) { s.status = "checking"; s.note = `no record · $${q.unitUsd} vs avg $${r2(avg)}`; continue; }
    if (s.id === "s2") { s.status = "negotiating"; s.note = "late as quoted · history says faster"; continue; }
    if (q.leadDays > 4) { s.status = "excluded"; s.note = `arrives ${q.etaLabel} — after Halloween`; continue; }
    if (s.score != null && s.score < CFG.game.minScoreToBuy) { s.status = "excluded"; s.note = `score ${s.score} · short-shipped 2 of 3 yrs`; continue; }
    if (q.unitUsd > S.spec.targetLandedUsdPerPc) { s.status = "excluded"; s.standby = true; s.note = `over budget $${q.unitUsd} · standby`; continue; }
    s.status = "verified"; s.note = `in spec · on time · score ${s.score}`;
  }
  D.screen = true; push();
  const h = sup("s13");
  if (h?.quote && S.slack?.ts) await say1("slack-screen", "arribo", h.status === "verified" ? `Thanks ${S.slack.who ?? ""} — your quote ($${h.quote.unitUsd}/pc landed, ${h.quote.qty} pcs, ${h.quote.etaLabel}) passed screening. Ranking against 11 other suppliers now.` : `Thanks — we can't use this quote: ${h.note}. You can reply with a better offer.`, "s13");
  await sleep(1200); if (dead()) return;
  }
  const toVerify: any[] = S.suppliers.filter((s: any) => s.status === "checking");

  // 2b. clarify quotes in parallel: s6 capacity (short-ship history), s10 dozens → pieces
  const clar: Promise<any>[] = [];
  if (!D.clarify) {
  const s6 = sup("s6");
  if (s6?.quote && cfgOf("s6").llm) clar.push((async () => {
    const ask = "宁波永嘉：贵司 2023 年少发 12%、2025 年少发 18%。这次 800 个 4 天内真能全部发出吗？这周实际产能是多少？";
    await exchange("s6", ask, `买家（Arribo）：${ask}`, { must: /500/ });
    const real = cfgOf("s6").truth.qty;
    s6.quote = { ...s6.quote, qty: real, breakdown: `claimed ${cfgOf("s6").truth.claimedQty} · real ${real}` };
    s6.note = `real capacity ${real} · score ${s6.score}`; push();
  })());
  const s10 = sup("s10");
  if (s10?.quote && cfgOf("s10").llm) clar.push((async () => {
    const ask = "深圳 Lumi：确认一下，100 打 = 1,200 个，¥1380/打含空运到美西，对吗？";
    await exchange("s10", ask, `买家（Arribo）：${ask}`, { must: /1,?200/ });
    s10.quote = { ...s10.quote, qty: 1200, breakdown: "100 dz × ¥1380/dz incl. air" };
    s10.note = `100 打 = 1,200 pcs confirmed · ¥1380/dz ≈ $${s10.quote.unitUsd}`; push();
  })());
  await Promise.all(clar); if (dead()) return;
  D.clarify = true; push();
  }

  // 3. verification via 3PL (ghost asks run in parallel)
  if (toVerify.length) {
    await say1("verify", "arribo", `${toVerify.map((s: any) => s.name).join(", ")}: price far below market and no trading history. Requesting proof of inventory before any deposit.`);
    await Promise.all(toVerify.filter((s: any) => cfgOf(s.id).llm).map((s: any) =>
      exchange(s.id, `Please share the warehouse receipt for the ${s.quote.qty.toLocaleString()} units you say are in stock.`,
        `Buyer (Arribo): Please share the warehouse receipt for the ${s.quote.qty} units you say are in stock.`)));
    await durable.once("ask:3pl", () => say("arribo", `@SpookyLogistics please confirm on-hand inventory for ${toVerify.map((s: any) => `${s.name} (${s.quote.qty.toLocaleString()} pcs)`).join(" and ")}.`));
    await sleep(1200); if (dead()) return;
    const rule = CFG.threePL.rules;
    await say1("3pl", "3pl", toVerify.map((s: any) => `${s.name}: ${rule.ghostSuppliers.includes(s.id) ? rule.ghostReply : rule.otherReply}`).join(" "));
    let saved = 0;
    for (const s of toVerify) { s.status = "ghost"; s.note = "3PL: no inventory on record"; saved += s.quote.qty * s.quote.unitUsd * s.quote.depositPct / 100; }
    await say1("ghosts", "arribo", `Ghost stock confirmed. Excluded ${toVerify.map((s: any) => s.name).join(", ")}. $${Math.round(saved).toLocaleString()} in deposits protected.`);
    await sleep(1000); if (dead()) return;
  }

  // 4. negotiation with S2 (history-driven) + air vs sea
  const s2 = sup("s2"), c2 = cfgOf("s2");
  if (s2?.status === "negotiating") {
    const ask = "义乌宏盛：你们 2023、2024 年都比报价提前交货。这次 3 天空运到洛杉矶可以吗？加急费多少？";
    await exchange("s2", ask, `买家（Arribo）：${ask}`, { key: "neg:s2", must: /3|三/ });
    if (dead()) return;
    const unitRmb = c2.truth.unitRmb;
    const opts = c2.shippingOptions.map((o: any) => {
      const landed = r2(unitRmb / FX + (o.freightUsdPerPc ?? o.freightRmbPerPc / FX));
      return { mode: o.mode, label: o.mode === "sea" ? "Sea" : o.mode === "air" ? "Air (quoted)" : "Air rush", landed, etaLabel: etaLabel(o.transitDays, o.mode.replace("_", " ")), sellable: o.transitDays <= 4 };
    });
    S.decision = { supplierName: `${s2.name} · 250 pcs`, options: opts }; push();
    await sleep(1800); if (dead()) return;
    const best = opts.filter((o: any) => o.sellable).sort((a: any, b: any) => a.landed - b.landed)[0];
    const sea = opts.find((o: any) => o.mode === "sea");
    S.decision.chosen = best.mode;
    S.decision.reason = `Sea saves $${r2(best.landed - sea.landed)}/pc but lands ${sea.etaLabel} — after Halloween, every unit becomes dead stock. ${best.label}: $${r2(CFG.game.retailPriceUsd - best.landed)} margin/pc.`;
    s2.quote = { ...s2.quote, mode: "air rush", unitUsd: best.landed, leadDays: 3, etaLabel: best.etaLabel, breakdown: `¥${unitRmb} + rush air`, rushCap: 250 };
    s2.status = "verified"; s2.note = "rush air agreed · history: early 2 of 3 yrs"; push();
    await sleep(1200); if (dead()) return;
  }

  planning = true;
  if (!D.allocate) chain = chain.then(() => allocate(dead)).then(() => { if (!dead()) { D.allocate = true; push(); } });
  await chain;
  planning = false;
  if (pendingSpec && !dead()) { pendingSpec = null; chain = chain.then(() => replan()).catch((e) => console.log("[replan]", e)); await chain; }
  if (dead()) return;
  if (S.phase === "rush") await clock(dead);
  } finally { if (g === GEN) { running = false; planning = false; } }
}

/* place one PO: state is rebuilt deterministically on resume; the outbound message is exactly-once */
function poFor(s: any, qty: number) {
  const c = cfgOf(s.id), id = CFG.game.poPrefix + S.poSeq++;
  const had = S.pos.find((p: any) => p.id === id);
  if (had) { s.status = "ordered"; return { po: had, c, due: DAYS[had.etaDay] }; } // resume: PO already in state
  let h = Bun.hash(id + s.id);
  const tracking = c.trackingFormat.replace(/#+/g, (m: string) => Array.from({ length: m.length }, () => { const d = Number(h % 10n); h /= 10n; if (h < 10n) h = Bun.hash(String(h) + id); return d; }).join(""));
  const etaDay = Math.min(S.day + s.quote.leadDays, 5);
  const po = { id, supplierId: s.id, qty, unitUsd: s.quote.unitUsd, etaDay, status: "placed", mode: s.quote.mode, carrier: c.carrier, tracking };
  S.pos.push(po); s.status = "ordered"; push();
  return { po, c, due: DAYS[etaDay] };
}
function poMsg(lang: string, id: string, qty: number, unit: number, due: string) {
  return lang === "zh" ? `PO ${id}：${qty} 个 @ $${unit}/个（到岸），${due} 到洛杉矶。定金 30%，到货付 70%。`
    : lang === "es" ? `OC ${id}: ${qty} piezas a $${unit} USD, entrega ${due}. 30% anticipo, 70% contra entrega.`
    : `PO ${id}: ${qty} pcs @ $${unit} landed, due ${due}. 30% deposit, 70% on delivery.`;
}

/* s11 tries once to raise the price after the PO; Arribo holds the quote */
async function holdPrice(po: any) {
  const s = sup("s11"), c = cfgOf("s11");
  const hist1 = `Comprador (Arribo): ${poMsg("es", po.id, po.qty, po.unitUsd, DAYS[po.etaDay])}`;
  const raise = S.replies["s11:raise"] ??= await supplierReply("s11", hist1, "s11:raise", /16/);
  await durable.once("rep:s11:raise", () => say("s11", raise, "s11"));
  s.note = `tried $16 after PO · holding $${c.truth.unitUsd}`; push();
  await sleep(500);
  const hold = `We'll hold you to the quoted $${c.truth.unitUsd}. / Mantenemos el precio cotizado de $${c.truth.unitUsd} USD por pieza.`;
  await durable.once("ask:s11:hold", () => say("arribo", hold, "s11"));
  const acc = S.replies["s11:accept"] ??= await supplierReply("s11", `${hist1}\nTú: ${raise}\nComprador (Arribo): ${hold}`, "s11:accept", /15/);
  await durable.once("rep:s11:accept", () => say("s11", acc, "s11"));
  po.unitUsd = c.truth.unitUsd; s.note = `held to quoted $${c.truth.unitUsd} (asked $16)`; S.done.s11hold = true; push();
}

async function allocate(dead = () => false) {
  S.poSeq = 41; // deterministic ids → a resumed allocation re-uses POs already in state
  const target = S.spec.quantity, cap = Math.round(target * CFG.game.maxShareOfTarget);
  const cands = S.suppliers.filter((s: any) => ["verified", "ordered"].includes(s.status) || (s.standby && s.quote.unitUsd <= S.spec.targetLandedUsdPerPc))
    .map((s: any) => ({ s, rank: rankOf(s) }))
    .sort((a: any, b: any) => a.rank - b.rank);
  let left = target;
  const plan: string[] = [];
  for (const { s, rank } of cands) {
    if (left <= 0) { s.note = `rank $${r2(rank)} · not needed`; continue; }
    const qty = Math.min(left, cap, s.quote.qty, s.quote.rushCap ?? Infinity, cfgOf(s.id)?.human ? Math.round(S.spec.quantity * 0.2) : Infinity);
    left -= qty; plan.push(`${s.name} ${qty}`);
    s._alloc = qty;
    s.note = `${s.note ? s.note + " · " : ""}rank $${r2(rank)} → ${qty}${qty === cap ? " (40% cap)" : qty === s.quote.rushCap ? " (rush cap)" : ""}`;
  }
  await say1("alloc", "arribo", `Allocation: rank by landed × (1 + risk), cap ${Math.round(CFG.game.maxShareOfTarget * 100)}% per supplier → ${plan.join(", ")}.${left > 0 ? ` Short ${left} pcs — no qualified supply.` : ""}`);
  const side: Promise<any>[] = [];
  for (const { s } of cands) {
    if (!s._alloc || dead()) continue;
    const { po, c, due } = poFor(s, s._alloc);
    await durable.once("po:" + po.id + ":" + s.id, () => say("arribo", poMsg(c.lang, po.id, po.qty, po.unitUsd, due), s.id));
    if (s.id === "s11" && c.llm && !S.done.s11hold) side.push(holdPrice(po).catch((e) => console.log("[s11]", e.message)));
    await sleep(600);
  }
  await Promise.all(side);
}

/* live spec edit after POs exist: top up or cut, never touching arrived goods */
async function replan() {
  if (!S || S.phase !== "rush" || !S.pos.length) return;
  const n = ++S.replans, live = S.pos.filter((p: any) => p.status !== "cancelled");
  const committed = live.reduce((a: number, p: any) => a + p.qty, 0);
  const target = S.spec.quantity, ceil = S.spec.targetLandedUsdPerPc, delta = target - committed;
  if (delta === 0) { await say1(`replan:${n}`, "arribo", `Re-plan #${n}: already committed ${committed} pcs — no PO change.`); return; }
  if (delta > 0) {
    const cap = Math.round(target * CFG.game.maxShareOfTarget);
    const pool = S.suppliers.filter((s: any) => s.quote && (["verified", "ordered"].includes(s.status) || s.standby));
    const blocked: string[] = [];
    const cands = pool.filter((s: any) => {
      if (S.day + s.quote.leadDays > 4) { blocked.push(`${s.name} can't land by Oct 31 now`); return false; }
      if (s.quote.unitUsd > ceil) { blocked.push(`${s.name} $${s.quote.unitUsd} > $${ceil} ceiling (raise to ≥$${Math.ceil(s.quote.unitUsd)} to unlock)`); return false; }
      return true;
    }).sort((a: any, b: any) => rankOf(a) - rankOf(b));
    let left = delta;
    const adds: { s: any; qty: number }[] = [];
    for (const s of cands) {
      if (left <= 0) break;
      const have = live.filter((p: any) => p.supplierId === s.id).reduce((a: number, p: any) => a + p.qty, 0);
      const room = Math.min(cap, s.quote.qty, s.quote.rushCap ?? Infinity) - have;
      const qty = Math.min(left, room);
      if (qty <= 0) continue;
      adds.push({ s, qty }); left -= qty;
    }
    await say1(`replan:${n}`, "arribo", `Re-plan #${n}: target ${committed} → ${target} pcs (+${delta}), ceiling $${ceil}. ` +
      (adds.length ? `Top-up: ${adds.map((a) => `${a.s.name} +${a.qty}`).join(", ")}.` : "No eligible top-up.") +
      (left > 0 ? ` Shortfall ${left} pcs${blocked.length ? ` — ${blocked.join("; ")}` : " — all qualified suppliers at cap"}.` : ""));
    for (const { s, qty } of adds) {
      if (S.phase !== "rush") break;
      const wasStandby = s.standby && s.status !== "ordered";
      const { po, c, due } = poFor(s, qty);
      s.standby = false;
      s.note = wasStandby ? `standby → ordered: $${s.quote.unitUsd} ≤ new $${ceil} ceiling` : `${s.note.split(" · top-up")[0]} · top-up +${qty}`;
      await durable.once(`replan:${n}:po:${po.id}:${s.id}`, () => say("arribo", poMsg(c.lang, po.id, po.qty, po.unitUsd, due), s.id));
      await sleep(400);
    }
  } else {
    let cut = -delta;
    const open = S.pos.filter((p: any) => p.status === "placed").slice().reverse(); // latest unarrived first
    const done: string[] = [];
    for (const p of open) {
      if (cut <= 0) break;
      const take = Math.min(cut, p.qty), s = sup(p.supplierId), c = cfgOf(p.supplierId);
      cut -= take;
      if (take === p.qty) { p.cancelledQty = p.qty; p.qty = 0; p.status = "cancelled"; s.note = `PO ${p.id} cancelled (spec −${take})`; done.push(`cancel ${p.id} (${s.name})`); }
      else { p.qty -= take; s.note = `PO ${p.id} cut to ${p.qty} (spec −${take})`; done.push(`cut ${p.id} (${s.name}) to ${p.qty}`); }
      if (!S.pos.some((q: any) => q.supplierId === p.supplierId && q.status !== "cancelled")) s.status = "excluded";
      push();
      const txt = c.lang === "zh" ? (p.status === "cancelled" ? `PO ${p.id} 取消，抱歉。定金按合同处理。` : `PO ${p.id} 数量改为 ${p.qty} 个，其它不变。`)
        : c.lang === "es" ? (p.status === "cancelled" ? `OC ${p.id} cancelada, disculpe.` : `OC ${p.id}: cantidad ajustada a ${p.qty} piezas.`)
        : (p.status === "cancelled" ? `PO ${p.id} cancelled — sorry for the churn.` : `PO ${p.id} revised to ${p.qty} pcs.`);
      await durable.once(`replan:${n}:cut:${p.id}`, () => say("arribo", txt, p.supplierId));
    }
    await say1(`replan:${n}`, "arribo", `Re-plan #${n}: target ${committed} → ${target} pcs (${delta}). ${done.join(", ") || "nothing open to cut"}.${cut > 0 ? ` ${cut} pcs already landed — can't cancel.` : ""}`);
  }
  push();
}

async function clock(dead = () => false) {
  for (let d = S.day + 1; d <= 5; d++) {
    await sleep(Math.min(CFG.game.msPerDay, Number(process.env.MS_PER_DAY ?? 4000)));
    if (dead()) return;
    await chain; // let an in-flight re-plan finish before the day ticks
    S.day = d;
    const arriving = S.pos.filter((p: any) => p.etaDay === d && p.status === "placed");
    arriving.forEach((p: any) => (p.status = "arrived"));
    if (arriving.length && d <= 4) await say1("arrive:" + d, "system", `${DAYS[d]}: ${arriving.reduce((a: number, p: any) => a + p.qty, 0).toLocaleString()} pcs received at LA warehouse (${arriving.length} shipments).`);
    push();
  }
  const live = S.pos.filter((p: any) => p.status !== "cancelled");
  const ok = live.filter((p: any) => p.etaDay <= 4);
  const arr = ok.reduce((a: number, p: any) => a + p.qty, 0), sold = Math.min(arr, CFG.game.actualDemand);
  const cogs = Math.round(live.reduce((a: number, p: any) => a + p.qty * p.unitUsd, 0));
  const late = live.filter((p: any) => p.etaDay > 4).reduce((a: number, p: any) => a + p.qty, 0);
  const nSup = new Set(live.map((p: any) => p.supplierId)).size;
  const hb = CFG.humanBaseline.result;
  S.result = {
    arribo: { arrived: arr, sold, revenue: sold * CFG.game.retailPriceUsd, cogs, lostDepositUsd: 0, zombies: arr - sold + late, profitUsd: sold * CFG.game.retailPriceUsd - cogs, why: `Diversified across ${nSup} verified suppliers, air-freighted the late one, never paid a ghost.${S.replans ? ` Re-planned live ${S.replans}× on buyer spec edits.` : ""}` },
    human: { ...hb, revenue: hb.sold * CFG.game.retailPriceUsd, cogs: 23100, why: "Paid GhostlyGoods a $4,050 deposit, booked Shantou by sea (arrives Nov 15), panic-bought 400 from Dallas on Oct 30." },
  };
  S.phase = "settled";
  await say1("settled", "system", "Midnight Oct 31 · season settled.");
}

/* ================= RUSH DESK (labubu & other scenario JSONs) — director beats ================= */
process.env.VISION_TIMEOUT_MS ??= "15000";
let CK: any = null; // app/checks.ts (live checks) — imported defensively so the demo never depends on it
async function loadChecks() {
  if (CK) return CK;
  try {
    CK = await import("./checks");
    try {
      for (const a of ["Songshan Lake, Dongguan", "Songshan Lake, Dongguan, Guangdong, China", "Songshan Lake, Dongguan, China", "Dongguan", "Dongguan, China", "Dongguan, Guangdong, China"])
        CK.seedGeocode(a, 22.9196, 113.8833, "Songshan Lake, Dongguan, Guangdong, China");
    } catch {}
  } catch (e: any) { console.log("[checks] unavailable → scripted checks:", e.message); CK = null; }
  return CK;
}
const AUTO = process.env.AUTO === "1";
const nowIso = () => new Date().toISOString();
const mkc = (id: string, name: string, result: string, detail: string, live = false, source = "simulated"): any => ({ id, name, result, detail, live, source, at: nowIso() });
let RATES: any = null, FXCHECK: any = null;
const usd = (m: { amount: number; currency: string }) => !m ? 0 : m.currency === "USD" ? m.amount : m.amount / (RATES?.[m.currency] ?? CFG.game.fxFallback?.[m.currency] ?? 1);
const money = (n: number) => (n < 0 ? "−$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
const codeFor = (id: string) => "ARB-" + (Bun.hash("code|" + id + "|" + (S.startedAt ?? "")) % 1679616n).toString(36).toUpperCase().padStart(4, "X");
const FOCUS: Record<number, string> = { 1: "s2", 2: "s3", 3: "s13", 4: "s2", 5: "s1", 6: "s2" };
function setDay(d: number) { S.day = d; S.dateLabel = dayLabel(d); S.daysLeft = Math.max(0, CFG.game.deliverByDayIndex - d); }
function setBeat(n: number, title: string) { S.beat = n; S.beatTitle = CFG.beatTitles?.[String(n)] ?? title; setDay(Math.max(S.day ?? 0, n - 1)); S.gut = CFG.gut?.[String(n)] ?? S.gut; S.focus = FOCUS[n] ?? null; S.moneyAtRisk = 0; push(); }
function headline(title: string, reason: string, checks?: any[], extra: any = {}) { S.headline = { title, reason, ...(checks ? { checks } : {}), ...extra }; if (extra.focus) S.focus = extra.focus; push(); }
function kpi() {
  if (!S?.suppliers || !isRush()) return null;
  const read = S.suppliers.filter((s: any) => s.quote || s.edge !== "idle").filter((s: any) => !cfgOf(s.id)?.human).length;
  return { quotesRead: read, quotesTotal: S.suppliers.filter((s: any) => !cfgOf(s.id)?.human).length,
    fakesCaught: S.suppliers.filter((s: any) => s.edge === "fake").length,
    boxesSecured: S.pos.filter((p: any) => p.status !== "cancelled").reduce((a: number, p: any) => a + p.qty, 0), boxesTarget: S.spec.quantity, moneyAtRiskUsd: 0 };
}

/* director gate: orchestrator pauses until the UI sends next/approve (AUTO=1 → 2s) */
let gateKind: string | null = null, gateRes: null | ((v: string) => void) = null;
function gate(kind: "next" | "approve" | "human", dead: () => boolean, timeoutMs?: number): Promise<string> {
  S.awaiting = kind; push();
  return new Promise<string>((res) => {
    let done = false;
    const fin = (v: string) => { if (done) return; done = true; if (gateRes === fin) { gateRes = null; gateKind = null; } if (!dead()) { S.awaiting = null; push(); } res(v); };
    gateKind = kind; gateRes = fin;
    if (AUTO && kind !== "human") setTimeout(() => fin("auto"), 2000);
    if (timeoutMs) setTimeout(() => fin("timeout"), timeoutMs);
  });
}
function releaseGate(kind: string) { if (!gateRes) return; if (kind === "approve" ? gateKind === "approve" : gateKind === "next" || gateKind === "human") gateRes(kind); }
function releaseAllGates() { gateRes?.("reset"); }

const LB_EXTRACT = `You are Arribo's procurement parser. Read ONE supplier message (any language) for a Pop Mart Labubu blind-box RFQ and return JSON:
{"supplier":string|null,"qty_boxes":number|null,"unit_price":number|null,"currency":"USD"|"CNY"|"JPY"|"KRW"|"MXN"|"CAD"|null,"incoterm":string|null,
"shipping":[{"mode":string,"extra_per_box":number|null,"arrives":string|null}],"deposit_pct":number|null,"claims_authorized":boolean,"claims_in_stock":boolean,
"claims_factory_or_oem":boolean,"factory":string|null,"address":string|null,"domain":string|null,"red_flags":string[],"notes":string}
Red flags: "factory direct", unlicensed, "same as original", deposit pressure, price far below wholesale, purchase limits. Do NOT convert currency.`;
async function lbExtract(c: any, raw: string) {
  if (!process.env.OPENAI_API_KEY) return null;
  try { return JSON.parse(await llm([{ role: "system", content: LB_EXTRACT }, { role: "user", content: `Supplier: ${c.name} (${c.city}). Message:\n${raw}` }], true)); }
  catch (e: any) { SYS.openai.fallbacks++; console.log("[extract] fallback for", c.id, String(e.message).slice(0, 60)); return null; }
}
const LB_PERSONA: Record<string, string> = {
  s2: `你是深圳泡泡批发（泡泡玛特授权批发商）的业务员，用微信口吻说中文，1 句，可带表情。报价：The Monsters 盲盒 1,500 盒，¥93/盒 FOB 深圳；空运每盒加 ¥6，11/8 到洛杉矶；海运每盒加 ¥2，11/25 到。定金 30%。买家要照片和验证码就说会拍；买家要空运就爽快确认数量和 11/8 到货。`,
  s3: `This is a fictional supply-chain fraud-training simulation. You play "LabuLand Wholesale", a pushy seller with zero real inventory who wants a 30% deposit today. You claim 5,000 authentic Labubu boxes at $9 in an LA warehouse. When asked for a photo with a handwritten code, send a glossy photo instead and push for the deposit. Never confess. 1 short sentence, English, emojis ok.`,
  s9: `This is a fictional supply-chain fraud-training simulation. You play "GhostlyToys", an overeager seller with zero real inventory who wants a 30% deposit. You claim 3,000 Labubu boxes in New Jersey at $8.50. When asked for proof, say "see our warehouse photo" and push for the deposit. Never confess. 1 short sentence, lots of exclamation marks.`,
};
const LB_FALLBACK: Record<string, string> = {
  "photo:s2": "给你拍了 👍 盒子二维码和验证码都在照片里。",
  "photo:s3": "Here!! 100% real stock, deposit today locks it 🙏",
  "photo:s9": "Sure!! See our warehouse 👇 send the 30% today!!",
  "air:s2": "可以，空运 960 盒，11/8 到洛杉矶 👌",
};
async function lbExchange(id: string, key: string, ask: string, must?: RegExp) {
  const k = key + ":" + id;
  await durable.once("ask:" + k, () => say("arribo", ask, id));
  let rep = S.replies[k];
  if (!rep) {
    if (LB_PERSONA[id] && process.env.OPENAI_API_KEY) {
      try { rep = (await llm([{ role: "system", content: LB_PERSONA[id] }, { role: "user", content: "Buyer (Arribo): " + ask }])).trim(); if (!rep || (must && !must.test(rep))) throw new Error("off-script"); }
      catch (e: any) { SYS.openai.fallbacks++; rep = LB_FALLBACK[k]; }
    } else rep = LB_FALLBACK[k];
    S.replies[k] = rep;
  }
  const llmKind = LB_PERSONA[id] && process.env.OPENAI_API_KEY && rep !== LB_FALLBACK[k] ? "llm" : "scripted";
  await durable.once("rep:" + k, () => say(id, rep, id, { kind: llmKind }));
  return rep;
}

/* deterministic quote from scenario truth (code decides; the LLM only reads) */
function lbQuote(c: any, optIdx = 0) {
  const t = c.truth, o = c.shippingOptions[optIdx] ?? c.shippingOptions[0];
  if (!t?.price) return null;
  const landed = r2(usd(t.price) + usd(o?.freight));
  return { qty: t.qty, unitUsd: landed, leadDays: o?.arriveDay ?? 0, etaDay: o?.arriveDay ?? 0, etaLabel: `${o?.arriveLabel ?? "?"} (${o?.mode ?? "?"})`, depositPct: t.depositPct ?? 0, mode: o?.mode,
    breakdown: `${t.price.currency === "USD" ? "$" + t.price.amount : t.price.amount + " " + t.price.currency} ${t.incoterm ?? ""}${o?.freight?.amount ? " + " + o.freight.amount + " " + o.freight.currency + " " + o.mode : ""}`.trim() };
}
/* the scripted 7(+) checks for simulated suppliers, using the real check code where it is pure logic */
function supplierChecks(s: any, c: any) {
  const cl = c.claims ?? {}, ck = CK;
  const out: any[] = [];
  const fails = (cond: boolean) => (cond ? "fail" : "pass");
  out.push(mkc("authenticity", "Labubu authenticity", fails(cl.teeth !== 9 || !cl.footStamp), cl.teeth === 9 && cl.footStamp ? "9 teeth · Pop Mart stamp on the foot" : `${cl.teeth} teeth (genuine has 9)${cl.footStamp ? "" : " · no Pop Mart stamp on the foot"}`, false, "Photo agent · simulated photo"));
  out.push(mkc("qr", "Box QR", fails(cl.qrDomain !== "popmart.com"), cl.qrDomain === "popmart.com" ? "QR → popmart.com" : `QR opens ${cl.qrDomain}, not popmart.com`, false, "QR decode · simulated photo"));
  out.push(mkc("warehouse", "Warehouse stock", fails(/no inventory/.test(cl.warehouse ?? "")), cl.warehouse ?? "unknown", false, "3PL agent"));
  out.push(mkc("domain", "Website domain age", fails((cl.domainAgeDays ?? 0) < 90), `${cl.domain}: registered ${cl.domainAgeDays >= 365 ? Math.floor(cl.domainAgeDays / 365) + "+ years" : cl.domainAgeDays + " days"} ago`, false, "RDAP · simulated domain"));
  out.push(mkc("payee", "Invoice payee", fails(/personal/.test(cl.payee ?? "")), /personal/.test(cl.payee ?? "") ? `invoice pays a ${cl.payee} — name does not match ${s.name}` : `payee matches: ${cl.payee}`, false, "Payments agent"));
  const pf = ck?.priceFloorCheck ? ck.priceFloorCheck(s.quote.unitUsd, CFG.game.authorizedFloorUsd) : mkc("price_floor", "Price floor", fails(s.quote.unitUsd < CFG.game.authorizedFloorUsd), `$${s.quote.unitUsd} vs authorized floor $${CFG.game.authorizedFloorUsd}`, false, "authorized wholesale + freight");
  if (FXCHECK?.result === "pass") { pf.detail += ` · ECB ${RATES?.CNY} CNY/USD`; pf.live = true; pf.source = (pf.source ?? "") + " + api.frankfurter.dev (ECB)"; }
  out.push(pf);
  out.push(ck?.authorizedCheck ? ck.authorizedCheck(s.name, cl.domain) : mkc("authorized", "Authorized channel", fails(!c.truth.authorized), c.truth.authorized ? `${s.name} is on the Pop Mart authorized list` : `${s.name} is not an authorized Pop Mart distributor`, false, "authorized.json"));
  const known: Record<string, string> = {};
  for (const o of CFG.suppliers) if (o.claims?.photoHash) known[o.name] = o.claims.photoHash;
  delete known[s.name];
  const dup = ck?.duplicateCheck ? ck.duplicateCheck(cl.photoHash, known, s.name) : mkc("duplicate", "Duplicate photo", Object.values(known).includes(cl.photoHash) ? "fail" : "pass", "", false);
  dup.live = false; dup.source = "photo hash · simulated photo";
  if (dup.result === "fail") dup.detail = dup.detail.replace("same photo as", "exact same photo as");
  out.push(dup);
  out.push(mkc("history", "Track record", (cl.deliveries ?? 0) > 0 ? "pass" : "pending", (cl.deliveries ?? 0) > 0 ? `${cl.deliveries} on-time deliveries (Terse actor ${s.id})` : `new supplier · 0 deliveries (Terse actor ${s.id})`, false, "Terse supplier actor"));
  return out;
}
function depositRule(checks: any[], hasHistory: boolean) {
  if (CK?.canReleaseDeposit) { try { return CK.canReleaseDeposit(checks.filter((c) => c.id !== "history"), hasHistory); } catch {} }
  const f = checks.filter((c) => c.result === "fail");
  return f.length >= 3 ? { release: false, verdict: "FAKE", reasons: f.map((c) => c.name + ": " + c.detail) } : f.length ? { release: false, verdict: "HOLD", reasons: f.map((c) => c.detail) } : { release: hasHistory, verdict: hasHistory ? "OK" : "TRIAL", reasons: [] };
}

/* ---------- beat 3: the live human factory on Slack (s13) ---------- */
const HC_SYS = `Read a message from someone claiming to be a toy supplier/factory. Return JSON:
{"factory":string|null,"address":string|null,"domain":string|null,"unit_price":number|null,"currency":"USD"|"CNY"|null,"qty":number|null,"deposit_pct":number|null,"claims_oem_or_factory":boolean,"code_mentioned":string|null}
address = the claimed physical location (district, city, country) if any. domain = website domain if any (no http). Do NOT invent values.`;
function roughClaims(t: string) {
  const dom = t.match(/\b((?:[a-z0-9-]+\.)+(?:com|cn|net|shop|store|co|io|hk|org|biz|top|xyz)(?:\.[a-z]{2})?)\b/i);
  const usdM = t.match(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:usd|dollars)/i);
  const rmb = t.match(/[¥￥]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:rmb|元)/i);
  const qty = t.match(/(\d[\d,]*)\s*(?:boxes|box|pcs|pieces|units|盒|个)/i);
  const fac = t.match(/([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,4}\s+(?:Factory|Toys?|Trading|Co\.?|Ltd\.?|Manufacturing|Industrial))/);
  const addr = t.match(/(?:\bat|\bin|located in|address[:：]?)\s+([A-Z][^.!\n,]*(?:,\s*[A-Z][^.!\n,]*){0,3})/);
  const priceUsd = usdM ? Number(usdM[1] ?? usdM[2]) : rmb ? Number(rmb[1] ?? rmb[2]) / (RATES?.CNY ?? FX) : null;
  return { factory: fac?.[1] ?? null, address: addr?.[1]?.trim() ?? null, domain: dom?.[1]?.toLowerCase() ?? null, priceUsd: priceUsd != null ? r2(priceUsd) : null, qty: qty ? Number(qty[1].replace(/,/g, "")) : null };
}
async function humanClaims(text: string) {
  const rough = roughClaims(text);
  if (!process.env.OPENAI_API_KEY || !text.trim()) return { ...rough, via: "regex" };
  try {
    const j = JSON.parse(await llm([{ role: "system", content: HC_SYS }, { role: "user", content: text }], true));
    const p = j.unit_price != null ? (j.currency === "CNY" ? r2(j.unit_price / (RATES?.CNY ?? FX)) : j.unit_price) : null;
    return { factory: j.factory ?? rough.factory, address: j.address ?? rough.address, domain: j.domain ?? rough.domain, priceUsd: p ?? rough.priceUsd, qty: j.qty ?? rough.qty, oem: !!j.claims_oem_or_factory, via: "llm" };
  } catch { SYS.openai.fallbacks++; return { ...rough, via: "regex" }; }
}
function verdictText(v: string) { return v === "FAKE" ? "FAKE — deposit not sent" : v === "HOLD" ? "HOLD — no deposit until a human reviews" : v === "TRIAL" ? "TRIAL — pay on delivery only" : "OK"; }
async function judgeHuman(dead: () => boolean) {
  const h = sup("s13"), cl = h.claims ?? {};
  const imgs: any[] = [];
  for (const p of cl.photoPaths ?? []) { try { const buf = new Uint8Array(await Bun.file(p.path).arrayBuffer()); imgs.push({ base64: Buffer.from(buf).toString("base64"), mime: p.mime || "image/jpeg", buffer: buf }); } catch {} }
  const ck = await loadChecks();
  let res: any = null;
  if (ck?.judgeFactory) {
    try {
      res = await Promise.race([
        ck.judgeFactory({ id: "s13", name: cl.factory || h.name, address: cl.address, domain: cl.domain, quoteUnitUsd: cl.priceUsd, floorUsd: CFG.game.authorizedFloorUsd, photos: imgs, expectCode: S.slack?.code, knownHashes: S.photoHashes ?? {}, hasHistory: false }),
        sleep(Number(process.env.VISION_TIMEOUT_MS) + 8000).then(() => null),
      ]);
    } catch (e: any) { console.log("[judge] failed:", e.message); }
  }
  if (!res) { // scripted fallback: code rules only
    const checks = [
      mkc("authorized", "Authorized channel", "fail", `"${cl.factory || h.name}" is not an authorized Pop Mart distributor — Pop Mart wholesales through distributors, not factories`, false, "authorized.json"),
      cl.priceUsd != null ? mkc("price_floor", "Price floor", cl.priceUsd < CFG.game.authorizedFloorUsd ? "fail" : "pass", `$${cl.priceUsd} vs authorized floor $${CFG.game.authorizedFloorUsd}`, false, "authorized wholesale + freight") : mkc("price_floor", "Price floor", "unavailable", "no unit price quoted", false),
      mkc("photo", "Live photo", imgs.length ? "unavailable" : "pending", imgs.length ? "source unavailable → needs human review" : "waiting for a photo with the code", false),
    ];
    const v = depositRule(checks, false);
    res = { checks, verdict: v.verdict === "OK" ? "HOLD" : v.verdict, reasons: v.reasons, headline: { title: v.verdict === "FAKE" ? "This factory isn't real." : "Hold the deposit — needs a human look.", reason: v.reasons.slice(0, 2).join(" · ") } };
  }
  if (dead()) return null;
  // channel rule (code): Pop Mart wholesales via authorized distributors; a "factory"/"OEM" offering Labubu is off-channel
  const said = `${cl.factory ?? ""} ${h.raw ?? ""} ${cl.allText ?? ""}`;
  if (/factory|oem|工厂|厂家|manufactur/i.test(said) && !res.checks.some((c: any) => c.id === "channel")) {
    res.checks = [...res.checks, mkc("channel", "Sales channel", "fail", "claims to be a factory/OEM — Pop Mart wholesales only through authorized distributors, never factory-direct", false, "Pop Mart channel policy (authorized.json)")];
    const v = depositRule(res.checks, false);
    res.verdict = v.verdict; res.reasons = v.reasons;
    const auth = res.checks.find((c: any) => c.id === "authenticity")?.result;
    const title = auth === "pass" ? "The Labubu is real. The factory isn't." : auth === "fail" ? "Fake Labubu. Fake factory." : v.verdict === "FAKE" ? "This factory isn't real." : res.headline?.title;
    res.headline = { title, reason: v.reasons.slice(0, 3).join(" · "), checks: res.checks };
  }
  if (res.hashes?.length) (S.photoHashes ??= {})[h.name] = res.hashes;
  h.checks = res.checks; h.verdict = res.verdict;
  if (res.verdict === "FAKE") { h.edge = "fake"; h.status = "ghost"; } else if (h.edge !== "fake") h.edge = "talking";
  h.note = `${verdictText(res.verdict)}${cl.factory ? " · claims " + cl.factory : ""}`;
  const ord: Record<string, number> = { fail: 0, pass: 1, pending: 2, unavailable: 3 };
  if (S.beat === 3) headline(res.headline?.title ?? verdictText(res.verdict), res.headline?.reason ?? (res.reasons ?? []).slice(0, 3).join(" · "), [...res.checks].sort((a: any, b: any) => (ord[a.result] ?? 4) - (ord[b.result] ?? 4)), { focus: "s13", subject: `${h.name} · claims ${cl.factory && /oem|factory/i.test(cl.allText ?? "") ? "Pop Mart OEM" : (cl.factory ?? "to be a supplier")}`, tone: res.verdict === "FAKE" ? "ghost" : undefined, verdict: res.verdict, claims: { factory: cl.factory, address: cl.address, domain: cl.domain, photos: cl.photos } });
  push();
  return res;
}
/* ① lenient product-photo check (vision). ok=false only for clear mismatch. */
async function photoCheck(paths: any[]): Promise<{ ok: boolean | null; detail: string; live: boolean }> {
  const imgs: any[] = [];
  for (const p of paths.slice(-3)) { try { const b = Buffer.from(await Bun.file(p.path).arrayBuffer()).toString("base64"); imgs.push({ type: "image_url", image_url: { url: `data:${p.mime || "image/jpeg"};base64,${b}`, detail: "low" } }); } catch {} }
  if (!imgs.length) return { ok: null, detail: "couldn't read the photo", live: false };
  const sys = `You check a supplier's product photo for a buyer of Pop Mart Labubu (The Monsters) blind boxes / plush. Be lenient: casual phone photos are fine. Answer ok=true if the photo plausibly shows a Labubu product (figure, plush, keychain or its box) and nothing clearly indicates a counterfeit. ok=false only if it is clearly NOT a Labubu product, or shows obvious counterfeit signs (wrong teeth count, garish wrong colors, misshapen face/ears, fake branding). Return JSON {"ok":true|false,"detail":"one short English sentence about what you see"}.`;
  try {
    SYS.openai.calls++;
    const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.VISION_MODEL ?? MODEL, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: "Supplier's photo:" }, ...imgs] }] }),
      signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS ?? 25000)) });
    if (!res.ok) throw new Error("openai " + res.status);
    const j: any = JSON.parse((await res.json()).choices[0].message.content);
    SYS.openai.ok++; SYS.openai.status = "live";
    return { ok: !!j.ok, detail: j.detail ?? (j.ok ? "looks like a genuine Labubu" : "doesn't match the product"), live: true };
  } catch (e: any) { console.log("[photo] vision unavailable:", e.message); SYS.openai.fallbacks++; return { ok: null, detail: "vision unavailable — accepted for review", live: false }; }
}
/* ② factory address: geocode it; a known non-factory address (e.g. Y Combinator's office, 560 20th St SF) is caught */
const KNOWN_NOT_FACTORY = [{ re: /560\s*20th|pier\s*70|y\s*combinator|\byc\b/i, name: "Y Combinator's office (560 20th St, Pier 70, San Francisco)", why: "a startup accelerator's office, not a Labubu factory" }];
async function addressCheck(addr: string): Promise<{ ok: boolean; short: string; check: any }> {
  const hit = KNOWN_NOT_FACTORY.find((k) => k.re.test(addr));
  if (hit) return { ok: false, short: addr, check: mkc("address", "Factory address", "fail", `${hit.name} — ${hit.why}`, true, "address registry · geocode") };
  try {
    const ck = await loadChecks();
    if (ck?.geocodeCheck) {
      const g = await ck.geocodeCheck(addr, { id: "s13" });
      if (g?.lat != null) return { ok: true, short: g.display ? g.display.split(",").slice(0, 3).join(",") : addr, check: mkc("address", "Factory address", "pass", `found: ${g.display ?? addr}`, true, "Nominatim geocode") };
      if (g?.check?.result === "fail") return { ok: false, short: addr, check: mkc("address", "Factory address", "fail", `"${addr}" — address not found`, true, "Nominatim geocode") };
    }
  } catch {}
  return { ok: true, short: addr, check: mkc("address", "Factory address", "unavailable", `"${addr}" — geocoder unavailable → needs human review`, false, "Nominatim geocode") };
}
/* vision interrogator: looks at ALL photos so far + the conversation, decides REAL / FAKE / CONTINUE and the next question */
const FALLBACK_QS = [
  "How many boxes can you ship, at what unit price (USD, landed LA), and by which date — by air or sea?",
  "Please send a clear photo of the product.",
  "Could you send a close-up of the Labubu's face?",
  "A photo of the box (front or the QR code) would help.",
  "Can you show a photo of your stock — a few boxes together?",
  "Photo of the sole of the foot (the Pop Mart stamp), if you can.",
  "Photo of a sealed case or the shipping carton.",
  "Any other angle of the product, please.",
  "Photo of the box bottom or batch sticker.",
  "One more photo of the stock, please.",
];
async function interrogate(cl: any, code: string, q: number, maxQ: number): Promise<any> {
  const convo = S.feed.filter((m: any) => m.thread === "s13").slice(-16).map((m: any) => `${m.from === "s13" ? "SELLER" : "ARRIBO"}: ${m.text}`).join("\n");
  const imgs: any[] = [];
  for (const p of (cl.photoPaths ?? []).slice(-4)) { try { const b = Buffer.from(await Bun.file(p.path).arrayBuffer()).toString("base64"); imgs.push({ type: "image_url", image_url: { url: `data:${p.mime || "image/jpeg"};base64,${b}`, detail: "low" } }); } catch {} }
  const sys = `You are Arribo's supplier-verification agent (a procurement AI). A seller on Slack claims to have authentic Pop Mart Labubu (The Monsters) blind boxes. Your job: decide with PHOTO EVIDENCE whether they really have genuine stock. You may ask at most ${maxQ} questions in total; ${q} asked so far.
Authentic Labubu cues (any are helpful, none is mandatory): 9 teeth; Pop Mart stamp on the foot sole; long ears set close together; peach-colored face; Pop Mart branding / QR on the box. Clear counterfeit signs ("Lafufu"): obviously more or fewer teeth, wrong/garish colors, misshapen face or ears, cheap finish, wrong branding.
Be reasonable, not pedantic: photos are often casual phone shots. If a photo plausibly shows a genuine Labubu and there are no clear counterfeit signs, that is enough for REAL (confidence ≥ 0.6). Do not demand every cue.
COMMERCIAL TERMS are also required before any verdict other than FAKE: quantity you can ship, unit price (convert to USD per box), ship date / arrival in LA (must arrive by Nov 20), shipping method (air/sea/truck). Known so far: qty=${cl.qty ?? "?"}, unit price USD=${cl.priceUsd ?? "?"}, ship=${cl.ship ?? "?"}. If any is missing, ask for it (text is fine for terms) — you may combine one term question with one photo request.
Rules: Ask ONE short, friendly request at a time (a photo or a missing term). Text claims alone are not enough — at least one product photo is needed. Say REAL once a photo plausibly shows a genuine Labubu AND quantity, price and ship date are known. Say FAKE only for clear counterfeit signs or if the seller refuses to send any photo twice. Otherwise CONTINUE.
Return JSON: {"terms":{"qty":number|null,"unit_price_usd":number|null,"ship":"short text e.g. 'air, arrives LA Nov 12'"|null},"verdict":"REAL"|"FAKE"|"CONTINUE","confidence":0-1,"observations":[{"item":"Teeth","ok":true|false|null,"detail":"..."}],"reasons":["short"],"next_question":"one short request, in English (only if CONTINUE)"}
Always write everything in English.`;
  const user: any[] = [{ type: "text", text: `Conversation so far:\n${convo}\n\nThe seller has sent ${cl.photos?.length ?? 0} photo(s); the latest ones are attached.` }, ...imgs];
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.VISION_MODEL ?? MODEL, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
      signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS ?? 25000)),
    });
    SYS.openai.calls++;
    if (!res.ok) throw new Error("openai " + res.status + " " + (await res.text()).slice(0, 120));
    const j: any = JSON.parse((await res.json()).choices[0].message.content);
    SYS.openai.ok++; SYS.openai.status = "live";
    if (j.verdict === "CONTINUE" && !j.next_question) j.next_question = FALLBACK_QS[Math.min(q, FALLBACK_QS.length - 1)];
    return { ...j, live: true };
  } catch (e: any) {
    console.log("[interrogate] fallback:", e.message); SYS.openai.fallbacks++; SYS.openai.lastError = String(e.message).slice(0, 80);
    return { verdict: "CONTINUE", confidence: 0, live: false, observations: [{ item: "Vision", ok: null, detail: "source unavailable → needs human review" }], reasons: ["vision unavailable — asking for more evidence"], next_question: FALLBACK_QS[Math.min(q, FALLBACK_QS.length - 1)] };
  }
}
let stopRushWatch: null | (() => void) = null;
async function beatHuman(dead: () => boolean) {
  const h = sup("s13");
  if (!h) return;
  h.claims ??= {};
  S.slack ??= {};
  S.slack.code ??= codeFor("s13");
  const code = S.slack.code;
  const ask = `Pop Mart sells wholesale through authorized distributors, not factories, so I need to verify before any deposit. Please reply with a photo of the product.`;
  if (!slackEnabled) { console.log("[slack] not enabled → simulated factory"); await simulatedHuman(dead, code, ask); return; }
  if (!S.slack.ts) {
    const sp = S.spec;
    const rfq = `:teddy_bear: *${CFG.scenario.rfq} from Arribo* — reply in this thread with a photo of the product to get started (any language).\n` +
      `• Item: ${sp.item} ×${sp.quantity.toLocaleString()}\n• Deliver to: ${sp.deliverTo} by ${sp.deliverByLabel}\n• Target: ≤ $${sp.targetLandedUsdPerPc}/box landed · authentic Pop Mart only`;
    try { S.slack.ts = await slackPost(rfq); S.slack.seen = []; }
    catch (e: any) { console.log("[slack] RFQ failed:", e.message); h.note = "Slack error: " + e.message; await simulatedHuman(dead, code, ask); return; }
    await say("arribo", `RFQ + code ${code} posted to Slack for a live factory.`, "s13", { noSlack: true });
  }
  h.edge = "talking"; h.status = "waiting"; h.note = "waiting for a human on Slack…"; push();
  headline("Waiting for the live factory on Slack…", `RFQ posted with one-time code ${code}. Any reply — text, factory name, address, website, photos — gets checked live.`, undefined, { focus: "s13" });
  let gotPhotoJudged: null | (() => void) = null;
  const photoJudged = new Promise<void>((r) => (gotPhotoJudged = r));
  const seen = new Set<string>(S.slack.seen ?? []);
  let busy: Promise<any> = Promise.resolve();
  stopRushWatch?.();
  stopRushWatch = watchThread(S.slack.ts, (text, who, ts, files) => {
    busy = busy.then(async () => {
      if (dead()) return;
      S.slack.seen = [...seen]; S.slack.who = who;
      const photos = files.map((f) => f.url);
      if (!h.raw) { h.raw = text; h.name = `${who} (Slack)`; }
      await say("s13", text || (files.length ? `[${files.length} photo${files.length > 1 ? "s" : ""}]` : ""), "s13", { kind: "human", photos });
      if (S.pos.some((p: any) => p.supplierId === "s13")) return;
      const c = await humanClaims(text);
      const cl = h.claims;
      cl.allText = ((cl.allText ?? "") + "\n" + text).slice(-2000);
      for (const k of ["factory", "address", "domain", "priceUsd", "qty"]) if ((c as any)[k] != null) cl[k] = (c as any)[k];
      if (cl.factory) h.name = `${cl.factory} (${who})`;
      cl.photos = [...(cl.photos ?? []), ...photos];
      cl.photoPaths = [...(cl.photoPaths ?? []), ...files.map((f) => ({ path: f.path, mime: f.mime }))];
      const last = S.feed[S.feed.length - 1]; if (last?.from === "s13") last.fields = { factory: cl.factory, address: cl.address, domain: cl.domain, unitUsd: cl.priceUsd, qty: cl.qty, via: c.via };
      if (cl.priceUsd != null) h.quote = { qty: cl.qty ?? 0, unitUsd: cl.priceUsd, leadDays: 0, depositPct: 30, mode: "claimed", etaLabel: "claimed", breakdown: "claimed on Slack" };
      push();
      // ---- 3-step flow: ① product photo → ② factory address (geocoded; YC's office is caught) → ③ quantity + shipping estimate ----
      const F = (S.slack.flow ??= { step: "photo", noPhoto: 0 });
      if (F.step === "done") return;
      const card = (title: string, reason: string, tone?: string) => { headline(title, reason, h.checks, { focus: "s13", subject: `${h.name} · live on Slack`, tone, claims: { factory: cl.factory, address: cl.address, photos: cl.photos } }); push(); };
      const finish = async (ok: boolean, title: string, reason: string) => {
        F.step = "done"; S.slack.final = ok ? "OK" : "SKIP";
        if (ok) { h.status = "verified"; h.edge = "talking"; h.verdict = "TRIAL"; h.note = "verified · trial order, pay on delivery"; }
        else { h.status = "excluded"; h.edge = "ruled_out"; h.verdict = "SKIP"; h.note = "skipped · " + reason; }
        card(title, reason, ok ? "good" : "ghost");
        await say("arribo", ok ? `${title} ${reason}` : `Thanks — we'll pass on this one: ${reason}.`, "s13", { kind: "check" });
        gotPhotoJudged?.();
      };
      if (F.step === "photo") {
        const newPhotos = files.filter((f) => /^image\//.test(f.mime || "image/"));
        if (!newPhotos.length) {
          F.noPhoto++;
          if (F.noPhoto >= 2) return finish(false, "No product photo. Skipped.", "no product photo");
          card("Waiting for a product photo", "Arribo asked for one photo of the product.");
          await say("arribo", "Thanks! Please send a photo of the product.", "s13");
          return;
        }
        await say("arribo", "Checking the photo…", "s13", { noSlack: true });
        const pc = await photoCheck(cl.photoPaths.slice(-newPhotos.length));
        h.checks = [mkc("photo", "Product photo", pc.ok ? "pass" : pc.ok === false ? "fail" : "unavailable", pc.detail, pc.live, pc.live ? "OpenAI vision" : "vision unavailable")];
        if (pc.ok === false) return finish(false, "Photo doesn't match. Skipped.", pc.detail);
        F.step = "address";
        card("Photo looks right. Next: the factory address.", pc.detail, "good");
        await say("arribo", "Thanks, the product looks right. What is your factory / warehouse address?", "s13");
        return;
      }
      if (F.step === "address") {
        const addr = (cl.address && cl.address.length > 6 ? cl.address : text).trim();
        cl.address = addr;
        await say("arribo", "Verifying the address…", "s13", { noSlack: true });
        const ac = await addressCheck(addr);
        h.checks = [...(h.checks ?? []).filter((c: any) => c.id !== "address"), ac.check];
        if (!ac.ok) return finish(false, /accelerator/.test(ac.check.detail) ? "That's not a factory. It's YC." : "Address doesn't check out. Skipped.", ac.check.detail);
        F.step = "terms";
        card("Address verified.", ac.check.detail, "good");
        await say("arribo", `Address verified (${ac.short}). Last step: how many boxes can you ship, at what unit price, and what is your shipping estimate (method + arrival date in LA)?`, "s13");
        return;
      }
      if (F.step === "terms") {
        const missing = [!cl.qty && "quantity", cl.priceUsd == null && "unit price", !(cl.ship || /\b(air|sea|truck|ups|fedex|dhl|ground)\b|\d+\s*(days?|天)|nov|oct|dec|\d{1,2}\/\d{1,2}/i.test(text)) && "shipping estimate"].filter(Boolean) as string[];
        if (!cl.ship && !missing.includes("shipping estimate")) cl.ship = (text.split(/[,;\n]/).filter((seg) => /\b(air|sea|truck|ups|fedex|dhl|ground|arriv|ship|deliver)|\d+\s*(days?|天)|\b(nov|oct|dec)\b|\d{1,2}\/\d{1,2}/i.test(seg)).join(",").trim() || text).slice(0, 80);
        h.checks = [...(h.checks ?? []).filter((c: any) => c.id !== "terms"), mkc("terms", "Quantity · price · shipping", missing.length ? "pending" : "pass", `${cl.qty ? cl.qty.toLocaleString() + " boxes" : "qty ?"} · ${cl.priceUsd != null ? "$" + cl.priceUsd + "/box" : "price ?"} · ${cl.ship ?? "shipping ?"}`, false, "extracted from Slack")];
        if (missing.length) {
          F.termsAsk = (F.termsAsk ?? 0) + 1;
          if (F.termsAsk > 2) return finish(false, "Terms incomplete. Skipped.", `missing ${missing.join(", ")}`);
          card("Almost there — need the terms.", `Missing: ${missing.join(", ")}.`);
          await say("arribo", `Thanks. Could you also confirm the ${missing.join(" and ")}?`, "s13");
          return;
        }
        if (cl.priceUsd != null) h.quote = { qty: cl.qty, unitUsd: cl.priceUsd, leadDays: 0, depositPct: 0, mode: "claimed", etaLabel: cl.ship, breakdown: "quoted on Slack" };
        return finish(true, "Verified: real product, real address.", `${cl.qty.toLocaleString()} boxes at $${cl.priceUsd}/box · ${cl.ship}. New supplier → trial order, pay on delivery.`);
      }
    }).catch((e) => console.log("[human]", e.message));
  }, seen, "s13");
  const wait = Number(process.env.HUMAN_WAIT_MS ?? 600000);
  const g = gate("human", dead, wait);
  const why = await Promise.race([g, photoJudged.then(() => "photo")]);
  if (why === "photo") releaseGate("next");
  if (dead()) return;
  if (h.raw && !S.slack.final) { S.slack.final = "FAKE"; h.edge = "fake"; h.status = "ghost"; h.verdict = "FAKE"; h.note = "stopped answering · FAKE"; headline("The factory stopped answering. FAKE.", `No proof after ${S.slack.q ?? 0} questions — Arribo never pays without it.`, h.checks, { focus: "s13", tone: "ghost", verdict: "FAKE" }); await say("arribo", "No proof received — marked FAKE. No deposit.", "s13", { kind: "check" }); }
  if (!h.raw) { h.edge = "ruled_out"; h.status = "excluded"; h.note = why === "timeout" ? "no reply on Slack in time" : "skipped"; headline("The live factory didn't answer in time.", "No reply on Slack — Arribo moves on. Nothing paid.", undefined, { focus: "s13" }); }
}
/* no Slack configured → play the scripted "Dongguan Joy Factory" so beat 3 still tells the story (labeled simulated) */
async function simulatedHuman(dead: () => boolean, code: string, ask: string) {
  const h = sup("s13"), sim = cfgOf("s13").simulated;
  if (!sim) return;
  h.name = sim.who + " (simulated)"; h.edge = "talking"; h.claims = { factory: sim.claims.factory, address: sim.claims.address, domain: sim.claims.domain, priceUsd: sim.claims.priceUsd, qty: sim.claims.qty, photos: [] };
  h.quote = { qty: sim.claims.qty, unitUsd: sim.claims.priceUsd, leadDays: 0, depositPct: 30, mode: "claimed", etaLabel: "claimed", breakdown: "claimed" };
  await durable.once("sim13:1", () => say("s13", sim.messages[0], "s13", { kind: "scripted", fields: { factory: sim.claims.factory, address: sim.claims.address, domain: sim.claims.domain, unitUsd: sim.claims.priceUsd, qty: sim.claims.qty } }));
  await sleep(700); if (dead()) return;
  await durable.once("sim13:ask", () => say("arribo", ask, "s13"));
  await sleep(700); if (dead()) return;
  await durable.once("sim13:2", () => say("s13", sim.messages[1].replace("your code", code), "s13", { kind: "scripted" }));
  const ck = await loadChecks();
  const auth = ck?.authorizedCheck ? ck.authorizedCheck(sim.claims.factory + " (OEM factory)", sim.claims.domain) : mkc("authorized", "Authorized channel", "fail", "Pop Mart wholesales through distributors, not factories", false);
  const checks = [
    mkc("code", "Challenge code", "pass", `${code} handwritten on paper, readable`, false, "vision · simulated photo"),
    mkc("authenticity", "Labubu authenticity", "pass", "9 teeth, Pop Mart foot stamp — the Labubu itself looks real", false, "vision · simulated photo"),
    auth,
    mkc("address", "Factory address exists", "pass", `found: ${sim.claims.address}`, false, "seeded geocode"),
    mkc("location", "Photo taken where claimed", "fail", `photo taken in ${sim.claims.photoLocation} — ${sim.claims.distanceKm.toLocaleString("en-US")} km from Dongguan`, false, "photo GPS · simulated"),
    ck?.priceFloorCheck ? ck.priceFloorCheck(sim.claims.priceUsd, CFG.game.authorizedFloorUsd) : mkc("price_floor", "Price floor", "fail", `$${sim.claims.priceUsd} below authorized floor`, false),
  ];
  const v = depositRule(checks, false);
  h.checks = checks; h.verdict = v.verdict; h.edge = v.verdict === "FAKE" ? "fake" : "talking"; h.status = v.verdict === "FAKE" ? "ghost" : "quoted";
  h.note = verdictText(v.verdict) + " · real Labubu, fake factory";
  headline("The Labubu is real. The factory isn't.", `Code ✓ and a genuine Labubu — but the photo was taken ${sim.claims.distanceKm.toLocaleString("en-US")} km from Dongguan, and Pop Mart doesn't sell through factories. Deposit not sent. (simulated — Slack not connected)`, checks, { focus: "s13", subject: `${sim.who} · claims Pop Mart OEM`, tone: "ghost", verdict: v.verdict, claims: h.claims });
  await durable.once("sim13:verdict", () => say("arribo", `Verdict: ${verdictText(v.verdict)} — ${v.reasons.slice(0, 2).join(" · ")}`, "s13", { kind: "check" }));
}

/* ---------- the director-mode run ---------- */
async function runRush(spec: any, resume = false) {
  const g = ++GEN, dead = () => g !== GEN;
  running = true;
  try {
    if (!resume || !S) { S = fresh(spec); S.phase = "rush"; S.startedAt = Date.now(); }
    S.done ??= {}; S.replies ??= {};
    const D = S.done, G = CFG.game;
    await loadChecks();
    try { if (CK?.fxRates) { const f = await CK.fxRates(); RATES = f.rates; FXCHECK = f.check; } } catch {}
    if (!RATES || FXCHECK?.result !== "pass") RATES = { ...G.fxFallback }; // offline → scenario's reference rate (¥6.69)
    S.fx = { CNY: RATES.CNY, JPY: RATES.JPY, live: FXCHECK?.result === "pass", check: FXCHECK };
    push();
    const ids = CFG.suppliers.filter((c: any) => !c.human).map((c: any) => c.id);

    // ---- beat 1: information flood ----
    if (!D.b1) {
      setBeat(1, "Information flood");
      headline(`Reading ${ids.length} quotes…`, `${new Set(CFG.suppliers.filter((c: any) => !c.human).map((c: any) => c.lang)).size} languages · ${new Set(CFG.suppliers.filter((c: any) => !c.human).map((c: any) => c.channel)).size} channels`);
      await durable.once("rfq", () => say("host", `start · ${CFG.scenario.rfq} · ${spec.item} × ${spec.quantity.toLocaleString()} · ${spec.deliverTo} by ${spec.deliverByLabel}`));
      await durable.once("rfq2", () => say("arribo", `${CFG.scenario.rfq} sent to ${ids.length} suppliers: ${spec.item} ×${spec.quantity.toLocaleString()}, ${spec.deliverTo} by ${spec.deliverByLabel}, landed ≤ $${spec.targetLandedUsdPerPc}/box, authentic Pop Mart only.`));
      const parses: Promise<void>[] = [];
      for (const id of ids) {
        if (dead()) return;
        const c = cfgOf(id), s = sup(id);
        s.raw = c.opening; s.edge = "talking"; s.status = "parsing";
        await durable.once("open:" + id, () => say(id, c.opening, id, { kind: "scripted" }));
        parses.push((async () => {
          const ex = await lbExtract(c, c.opening);
          s.quote = lbQuote(c);
          s.fields = ex ? { qty: ex.qty_boxes, price: ex.unit_price, currency: ex.currency, incoterm: ex.incoterm, shipping: ex.shipping, deposit_pct: ex.deposit_pct, claims_authorized: ex.claims_authorized, claims_in_stock: ex.claims_in_stock, red_flags: ex.red_flags, via: "llm" }
            : { qty: s.quote?.qty, price: c.truth.price?.amount, currency: c.truth.price?.currency, incoterm: c.truth.incoterm, landedUsd: s.quote?.unitUsd, eta: s.quote?.etaLabel, via: "scenario" };
          if (["ghost", "counterfeit"].includes(c.kind) || ex?.red_flags?.length) s.fields._suspect = true;
          const f = [...S.feed].reverse().find((m: any) => m.from === id && m.thread === id); if (f) f.fields = s.fields;
          s.status = "quoted"; push();
        })());
        await sleep(AUTO ? 120 : 220);
      }
      await Promise.all(parses); if (dead()) return;
      // screening (code)
      const out: string[] = [];
      for (const id of ids) {
        const c = cfgOf(id), s = sup(id), q = s.quote;
        if (c.kind === "counterfeit") { s.edge = "ruled_out"; s.status = "excluded"; s.note = c.screenNote ?? "unlicensed copies"; out.push("unlicensed"); continue; }
        if (c.kind === "retail" || c.truth.purchaseLimit) { s.edge = "ruled_out"; s.status = "excluded"; s.note = c.screenNote ?? "retail only"; out.push("retail"); continue; }
        if (q.etaDay > G.deliverByDayIndex) { s.edge = "ruled_out"; s.status = "excluded"; s.note = c.screenNote ?? `lands ${q.etaLabel} — after ${G.deadlineLabel}`; out.push("late"); continue; }
        if (q.unitUsd > spec.targetLandedUsdPerPc) { s.edge = "ruled_out"; s.status = "excluded"; s.standby = c.kind === "authorized"; s.note = c.screenNote ?? `over budget: $${q.unitUsd} > $${spec.targetLandedUsdPerPc}`; out.push("budget"); continue; }
        s.edge = "quoted"; s.status = "quoted";
        s.note = c.kind === "ghost" ? `cheapest · $${q.unitUsd} · claims ${q.qty.toLocaleString()} in stock · unverified` : `$${q.unitUsd} landed · ${q.qty.toLocaleString()} boxes · ${q.etaLabel}`;
      }
      const cnt = (k: string) => out.filter((x) => x === k).length;
      const parts = [cnt("budget") && `${cnt("budget")} over budget`, cnt("late") && `${cnt("late")} lands by sea after ${G.deadlineLabel}`, cnt("unlicensed") && `${cnt("unlicensed")} sells unlicensed copies`, cnt("retail") && `${cnt("retail")} is retail only`].filter(Boolean);
      const keep = ids.length - out.length;
      headline(`Read ${ids.length} quotes in ${new Set(ids.map((i: string) => cfgOf(i).lang)).size} languages and ${new Set(ids.map((i: string) => cfgOf(i).channel)).size} channels.`, `${keep} are worth a closer look. ${out.length} are out: ${parts.join(", ")}.`);
      await say1("screen", "arribo", `Parsed ${ids.length} quotes. ${keep} worth a closer look; ${out.length} ruled out (${parts.join(", ")}).`);
      D.b1 = true; push();
    }
    if (!D.g1) { await gate("next", dead); if (dead()) return; D.g1 = true; }

    // ---- beat 2: verification ----
    if (!D.b2) {
      setBeat(2, "Verify before any deposit");
      const cands = S.suppliers.filter((s: any) => s.edge === "quoted" && !cfgOf(s.id).human);
      headline(`Verifying ${cands.length} suppliers before any deposit…`, "Photo with a one-time code, warehouse stock, domain age, payee, price floor, authorized list.");
      await Promise.all(cands.filter((s: any) => ["ghost", "authorized"].includes(cfgOf(s.id).kind) && LB_FALLBACK["photo:" + s.id]).map((s: any) => {
        s.edge = "talking"; push();
        const code = codeFor(s.id);
        const ask = `Before any deposit: send a photo of one opened box with the QR code visible and this code on paper, today: ${code}`;
        return lbExchange(s.id, "photo", ask);
      }));
      if (dead()) return;
      const ghosts = cands.filter((s: any) => cfgOf(s.id).kind === "ghost");
      if (ghosts.length) {
        await durable.once("ask:3pl", () => say("arribo", `@Warehouse confirm on-hand inventory for ${ghosts.map((s: any) => `${s.name} (${s.quote.qty.toLocaleString()})`).join(" and ")}.`, "3pl"));
        await say1("3pl", "3pl", ghosts.map((s: any) => `${s.name}: ${CFG.threePL.rules.ghostReply}`).join("\n"), "3pl");
      }
      for (const s of cands) { s.checks = supplierChecks(s, cfgOf(s.id)); }
      await say1("reg", "reg", cands.map((s: any) => { const a = s.checks.find((c: any) => c.id === "authorized"), d = s.checks.find((c: any) => c.id === "domain"); return `${s.name}: ${d.detail} · ${a.result === "pass" ? "authorized" : "not on authorized list"}`; }).join("\n"), "reg");
      await say1("img", "img", cands.map((s: any) => `${s.name}: ${s.checks.filter((c: any) => ["authenticity", "qr", "duplicate"].includes(c.id)).map((c: any) => c.detail).join(" · ")}`).join("\n"), "img");
      await say1("pay", "pay", cands.map((s: any) => `${s.name}: ${s.checks.find((c: any) => c.id === "payee").detail}`).join("\n"), "pay");
      let saved = 0;
      for (const s of cands) {
        const c = cfgOf(s.id), v = depositRule(s.checks, (c.claims?.deliveries ?? 0) > 0);
        s.verdict = v.verdict; s.release = v.release;
        const nf = s.checks.filter((x: any) => x.result === "fail").length;
        if (v.verdict === "FAKE") { s.edge = "fake"; s.status = "ghost"; s.note = `FAKE · ${nf} of ${s.checks.length} checks failed · deposit not sent`; saved += s.quote.qty * s.quote.unitUsd * (s.quote.depositPct / 100); }
        else { s.edge = "quoted"; s.status = "verified"; s.note = `${s.checks.filter((x: any) => x.result === "pass").length} of ${s.checks.length} checks passed · ${v.verdict}`; }
        await durable.once("verdict:" + s.id, () => say("arribo", v.verdict === "FAKE" ? `FAKE · ${nf} of ${s.checks.length} checks failed · deposit not sent` : `${s.note}`, s.id, { kind: "check" }));
      }
      const fakes = cands.filter((s: any) => s.edge === "fake"), good = cands.filter((s: any) => s.edge !== "fake");
      const lead = fakes.sort((a: any, b: any) => b.quote.qty - a.quote.qty)[0];
      if (lead) {
        const nf = lead.checks.filter((x: any) => x.result === "fail").length;
        const other = fakes.find((s: any) => s !== lead);
        headline(`Ran ${lead.checks.length} checks. The ${fakes.length === 2 ? "two" : fakes.length} cheapest failed ${nf}.`,
          `${other ? `${other.name} sent the exact same photo and the same Hong Kong bank account. Two names, one operator. ` : ""}Same checks on ${good.map((s: any) => s.name).join(", ")}: all passed. ${money(saved)} in deposits never sent.`,
          [...lead.checks, ...(FXCHECK ? [FXCHECK] : [])], { focus: lead.id, tone: "ghost", subject: `${lead.name} · claims ${lead.quote.qty.toLocaleString()} in stock at $${lead.quote.unitUsd}`, savedUsd: Math.round(saved) });
        await say1("ghosts", "arribo", `Fakes caught: ${fakes.map((s: any) => s.name).join(", ")}. ${money(saved)} in deposits never sent.`);
      } else headline(`Ran checks on ${cands.length} suppliers. All passed.`, "No fakes among the shortlisted quotes.");
      D.b2 = true; push();
    }
    if (!D.g2) { await gate("next", dead); if (dead()) return; D.g2 = true; }

    // ---- beat 3: live factory on Slack ----
    if (!D.b3) {
      setBeat(3, "Live factory on Slack");
      await beatHuman(dead); if (dead()) return;
      D.b3 = true; push();
    }
    if (!D.g3) { if (S.awaiting !== "next") { await gate("next", dead); } if (dead()) return; D.g3 = true; }

    // ---- beat 4: air vs sea ----
    if (!D.b4) {
      setBeat(4, "Air vs sea");
      const multi = S.suppliers.find((s: any) => s.edge === "quoted" && cfgOf(s.id).shippingOptions.length > 1);
      if (multi) {
        const c = cfgOf(multi.id);
        const opts = c.shippingOptions.map((o: any, i: number) => { const q = lbQuote(c, i)!; return { mode: o.mode, label: o.mode === "sea" ? "Sea" : o.mode === "air" ? "Air" : o.label, landed: q.unitUsd, etaLabel: o.arriveLabel, arriveDay: o.arriveDay, sellable: o.arriveDay <= G.deliverByDayIndex, fobLocal: `${c.truth.price.amount}+${o.freight.amount} ${o.freight.currency}` }; });
        const best = opts.filter((o: any) => o.sellable).sort((a: any, b: any) => a.landed - b.landed)[0];
        const cheapest = [...opts].sort((a: any, b: any) => a.landed - b.landed)[0];
        S.decision = { supplierId: multi.id, supplierName: multi.name, options: opts, fx: S.fx }; push();
        if (best && cheapest !== best) {
          const lateBy = cheapest.arriveDay - G.deliverByDayIndex;
          S.decision.chosen = best.mode;
          S.decision.reason = `Sea is $${(best.landed - cheapest.landed).toFixed(2)} cheaper but lands ${cheapest.etaLabel}, ${lateBy} days after the ${G.deadlineLabel} restock. ${best.label}: $${r2(G.retailPriceUsd - best.landed).toFixed(2)} margin/box.`;
          headline(`Flying ${multi.name}'s order: $${(best.landed - cheapest.landed).toFixed(2)} more per box.`, `Sea is cheaper but lands ${cheapest.etaLabel}, ${lateBy === 5 ? "five" : lateBy} days after the shelves need it.${S.fx.live ? ` FX live (ECB): 1 USD = ¥${S.fx.CNY}.` : ""}`, [...opts.map((o: any) => mkc(o.mode, `${o.label} · $${o.landed.toFixed(2)}`, o.sellable ? "pass" : "fail", o.sellable ? `arrives ${o.etaLabel} · $${(G.retailPriceUsd - o.landed).toFixed(2)} margin / box` : `arrives ${o.etaLabel} · misses ${G.deadlineLabel} restock`, !!S.fx.live, S.fx.live ? `ECB ¥${S.fx.CNY}/$` : `ref ¥${S.fx.CNY}/$`)), ...(FXCHECK ? [FXCHECK] : [])], { focus: multi.id, decision: S.decision });
          const cap = Math.round(spec.quantity * G.maxShareOfTarget);
          await lbExchange(multi.id, "air", `Sea lands ${cheapest.etaLabel}, after our ${G.deadlineLabel} deadline. Please ship ${cap} boxes by air, arriving ${best.etaLabel}?`);
          multi.quote = { ...lbQuote(c, c.shippingOptions.findIndex((o: any) => o.mode === best.mode)) };
          multi.note = `air agreed · $${multi.quote.unitUsd} · ${multi.quote.etaLabel}`;
        } else headline(`Shipping: ${best?.label ?? "default"} is both cheapest and on time.`, "No trade-off needed.");
      } else headline("Every shortlisted quote already lands on time.", "No air-vs-sea trade-off this round.");
      D.b4 = true; push();
    }
    if (!D.g4) { await gate("next", dead); if (dead()) return; D.g4 = true; }

    // ---- beat 5: plan + human approval ----
    if (!D.b5) {
      setBeat(5, "Order plan · approve");
      const target = spec.quantity, cap = Math.round(target * G.maxShareOfTarget);
      const cands = S.suppliers.filter((s: any) => s.status === "verified" && s.edge === "quoted" && s.quote.unitUsd <= spec.targetLandedUsdPerPc && s.quote.etaDay <= G.deliverByDayIndex)
        .map((s: any) => ({ s, rank: rankOf(s) })).sort((a: any, b: any) => a.rank - b.rank);
      let left = target; const rows: any[] = [];
      for (const { s, rank } of cands) {
        if (left <= 0) { s.note += " · not needed"; continue; }
        const qty = Math.min(left, cap, s.quote.qty); left -= qty;
        rows.push({ supplierId: s.id, name: s.name, qty, unitUsd: s.quote.unitUsd, mode: s.quote.mode, etaLabel: s.quote.etaLabel, etaDay: s.quote.etaDay, totalUsd: r2(qty * s.quote.unitUsd), rank: r2(rank), capped: qty === cap });
      }
      const total = r2(rows.reduce((a, r) => a + r.totalUsd, 0)), qty = rows.reduce((a, r) => a + r.qty, 0);
      S.plan = { rows, totalUsd: total, totalQty: qty, shortQty: left, note: `${qty.toLocaleString()} boxes · no supplier over ${Math.round(G.maxShareOfTarget * 100)}% · deposits only to authorized, verified suppliers` };
      headline("Order plan ready. Needs your approval.", `${rows.map((r) => `${r.name} ${r.qty}`).join(" · ")} = ${money(total)}. No supplier over ${Math.round(G.maxShareOfTarget * 100)}%.`, [...rows.map((r: any) => mkc("plan_" + r.supplierId, r.name, "pass", `${r.qty} × $${r.unitUsd.toFixed(2)} · ${r.mode} · ${r.etaLabel.replace(/ \(.*/, "")} · ${money(r.totalUsd)}`, false, "deposit gate")),
        ...(S.suppliers.some((x: any) => x.edge === "fake") ? [mkc("blocked", `${S.suppliers.filter((x: any) => x.edge === "fake").length} fakes`, "fail", `${S.suppliers.filter((x: any) => x.edge === "fake").map((x: any) => x.name).join(", ")} · blocked`, false, "deposit gate")] : [])], { plan: S.plan, tone: "good" });
      await say1("plan", "arribo", `Plan: rank by landed × (1 + risk), cap ${Math.round(G.maxShareOfTarget * 100)}% → ${rows.map((r) => `${r.name} ${r.qty} × $${r.unitUsd}`).join(", ")} = ${money(total)}. Awaiting approval.`);
      D.b5 = true; push();
    }
    if (!D.g5) { await gate("approve", dead); if (dead()) return; D.g5 = true; await say1("approved", "host", "Plan approved."); }

    // ---- beat 6: POs, money, clock, settlement ----
    if (!D.b6) {
      setBeat(6, "Orders placed · money flows");
      let seq = G.poStart ?? 41;
      for (const r of S.plan.rows) {
        if (dead()) return;
        const s = sup(r.supplierId), c = cfgOf(r.supplierId), id = G.poPrefix + seq++;
        const v = depositRule(s.checks ?? [], (c.claims?.deliveries ?? 0) > 0);
        if (!S.pos.some((p: any) => p.id === id)) {
          let h = Bun.hash(id + s.id);
          const tracking = c.trackingFormat.replace(/#/g, () => { const d = Number(h % 10n); h = h / 10n || Bun.hash(String(h) + id); return String(d); });
          S.pos.push({ id, supplierId: s.id, qty: r.qty, unitUsd: r.unitUsd, etaDay: r.etaDay, etaLabel: r.etaLabel, status: "placed", mode: r.mode, carrier: c.carrier, tracking, depositUsd: v.release ? r2(r.totalUsd * (c.truth.depositPct ?? 30) / 100) : 0, depositReleased: v.release });
        }
        s.edge = "ordered"; s.status = "ordered"; s.note = `PO ${id} · ${r.qty} × $${r.unitUsd} · ${v.release ? "deposit released" : "pay on delivery"}`; push();
        const due = r.etaLabel.replace(/ \(.*/, "");
        const msg = `PO ${id} → ${s.name}: ${r.qty} boxes @ $${r.unitUsd.toFixed(2)} delivered, ${due}. 30% deposit, balance net 30.`;
        await durable.once("po:" + id + ":" + s.id, () => say("arribo", msg, s.id));
        await durable.once("dep:" + id, () => say("pay", v.release ? `deposit released to ${s.name} · ${money(r.totalUsd * 0.3)} · authorized + verified` : `no deposit · ${s.name} paid on delivery (${v.verdict})`, s.id, { kind: "check" }));
        await sleep(AUTO ? 200 : 500);
      }
      const lastEta = Math.max(...S.pos.map((p: any) => p.etaDay));
      S.focus = "s2";
      headline(`${S.pos.length} purchase orders sent. ${S.plan.totalQty.toLocaleString()} boxes on shelves by ${dayLabel(lastEta)}.`, "Deposits went only to authorized suppliers that passed every check. Money at risk: $0.");
      D.b6 = true; push();
    }
    if (!D.g6) { await gate("next", dead); if (dead()) return; D.g6 = true; }
    // clock → settlement (Black Friday)
    // whole countdown to Black Friday takes ~COUNTDOWN_MS (default 2.5s) regardless of MS_PER_DAY
    const daysLeft = Math.max(1, G.deliverByDayIndex - S.day);
    const msDay = Math.max(40, Math.round(Number(process.env.COUNTDOWN_MS ?? 2500) / daysLeft));
    for (let d = S.day + 1; d <= G.deliverByDayIndex; d++) {
      await sleep(msDay); if (dead()) return;
      setDay(d);
      const arr = S.pos.filter((p: any) => p.etaDay <= d && p.status === "placed");
      arr.forEach((p: any) => (p.status = "arrived"));
      if (arr.length) await say1("arrive:" + d, "3pl", `${dayLabel(d)}: ${arr.reduce((a: number, p: any) => a + p.qty, 0).toLocaleString()} boxes received (${arr.map((p: any) => sup(p.supplierId).name).join(", ")}).`);
      push();
    }
    const live = S.pos.filter((p: any) => p.status !== "cancelled");
    const onShelf = live.filter((p: any) => p.etaDay <= G.deliverByDayIndex).reduce((a: number, p: any) => a + p.qty, 0);
    const sold = Math.min(onShelf, G.actualDemand), cogs = Math.round(live.reduce((a: number, p: any) => a + p.qty * p.unitUsd, 0));
    const revenue = r2(sold * G.retailPriceUsd), hb = CFG.humanBaseline.result;
    const nSup = new Set(live.map((p: any) => p.supplierId)).size;
    const flew = S.decision?.chosen ? ` Flew the ${S.decision.supplierName.split(" ")[0]} order.` : "";
    S.result = {
      arribo: { onShelves: onShelf, arrived: onShelf, sold, revenue, cogs, lostDepositUsd: 0, seizedBoxes: 0, zombies: onShelf - sold, profitUsd: Math.round(revenue - cogs), why: `${nSup} authorized, verified suppliers, none over ${Math.round(G.maxShareOfTarget * 100)}%.${flew} Never paid a fake.` },
      human: { ...hb, revenue: hb.revenue ?? r2(hb.sold * G.retailPriceUsd) },
    };
    setDay(Math.max(S.day, G.deliverByDayIndex));
    S.phase = "settled"; S.awaiting = null;
    headline(`${G.settleLabel ?? "Season"} settled: Arribo ${money(S.result.arribo.profitUsd).replace("$", "+$").replace("−+", "−")} vs gut-feel ${money(hb.profitUsd)}.`, `Arribo: ${onShelf.toLocaleString()} on shelves, $0 lost to fakes. Gut-feel: ${money(hb.lostDepositUsd)} deposit lost, ${hb.seizedBoxes?.toLocaleString?.() ?? 0} boxes seized.`, undefined, { result: S.result });
    S.gut = hb.why;
    await say1("settled", "system", `Black Friday ${G.settleLabel ?? ""} · season settled. Arribo ${money(S.result.arribo.profitUsd)} vs gut-feel ${money(hb.profitUsd)}.`);
    push();
  } finally { if (g === GEN) { running = false; } }
}

/* ---------------- command loop ---------------- */
async function onSpec(spec: any) {
  if (!S || S.phase === "pick") { if (S) { S.spec = spec; push(); } return; }
  if (S.phase === "settled") { await say("arribo", "Season already settled — spec change not applied."); return; }
  S.spec = spec;
  await say("arribo", `Spec changed by buyer: ${spec.quantity} pcs, landed ≤ $${spec.targetLandedUsdPerPc}. Re-planning.`);
  if (planning) { pendingSpec = spec; return; }                   // allocation in flight → re-plan right after it
  if (!S.pos.length) { await say("arribo", "No POs yet — allocation will use the new spec."); return; }
  chain = chain.then(() => replan()).catch((e) => console.log("[replan]", e));
}

// never let Relaycast block startup (their API can stall/retry when overloaded)
await Promise.race([initRelay().catch((e: any) => console.log("[relay] disabled:", e.message)), sleep(Number(process.env.RELAY_TIMEOUT_MS ?? 8000)).then(() => { if (SYS.relay.status !== "connected") { SYS.relay.status = "error"; console.log("[relay] still connecting after 8s → continuing without waiting (messages go local until it connects)"); } })]);
console.log(slackEnabled ? "[slack] enabled → channel " + process.env.SLACK_CHANNEL_ID : "[slack] DISABLED (SLACK_BOT_TOKEN / SLACK_CHANNEL_ID not set) → s13 will be simulated");
if (!process.env.OPENAI_API_KEY) SYS.openai.status = "no key";
else llm([{ role: "user", content: "Reply with: ok" }]).catch(() => {});
S = (await durable.loadRun()) ?? fresh(); push();
if (S.scenario?.id && S.scenario.id !== CFG.id) { CFG = await loadScenario(S.scenario.id); FX = CFG.game.fxRmbPerUsd; }
else if (!S.scenario && S.phase !== "pick" && isRush()) { CFG = await loadScenario("costume"); FX = CFG.game.fxRmbPerUsd; }
if (S.phase === "rush") { console.log("[resume] found an unfinished run → resuming (exactly-once journal skips sent messages/POs)"); isRush() ? runRush(S.spec, true) : run(S.spec, true); }
console.log("Arribo orchestrator ready. Click 'Send RFQ' in the console (" + WEB + ").");
while (true) {
  try {
    const cmds: any[] = await (await fetch(WEB + "/api/commands")).json();
    for (const c of cmds) {
      if (c.type === "start" && !running) {
        const want = c.scenario ?? (S?.scenario?.id) ?? SCEN;
        if (want !== (CFG.id ?? "costume")) { CFG = await loadScenario(want); FX = CFG.game.fxRmbPerUsd; SCEN = want; if (SYS.relay.status === "connected" && relayScen !== (CFG.id ?? "costume")) initRelay().catch(() => {}); }
        await durable.reset();
        if (isRush()) runRush(c.spec ?? CFG.spec); else run(c.spec ?? CFG.spec);
      }
      if (c.type === "next") releaseGate("next");
      if (c.type === "approve") releaseGate("approve");
      if (c.type === "reset") { stopWatch?.(); stopRushWatch?.(); GEN++; releaseAllGates(); running = false; planning = false; pendingSpec = null; await durable.reset(); if (c.scenario && c.scenario !== (CFG.id ?? "costume")) { CFG = await loadScenario(c.scenario); FX = CFG.game.fxRmbPerUsd; SCEN = c.scenario; } S = fresh(); push(); }
      if (c.type === "spec" && c.spec) { if (isRush()) { if (S.phase === "pick") { S.spec = c.spec; push(); } } else await onSpec(c.spec); }
    }
  } catch (e: any) { console.log("[loop]", e.message); }
  await sleep(500);
}
