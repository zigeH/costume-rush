// Costume Rush · web server (Bun)
// - serves the console (index.html) and ../config.json
// - GET  /events        SSE stream of full state snapshots to the browser
// - POST /api/state     orchestrator (app/) pushes the latest state snapshot here
// - POST /api/command   browser sends {type:"start"|"reset"|"spec", spec?}
// - GET  /api/commands  orchestrator long-polls commands from here
// Run:  bun web/server.ts   → http://localhost:3000   (replay mode: /?mode=replay)
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
let state: any = null;
const clients = new Set<ReadableStreamDefaultController>();
const commands: any[] = [];
const enc = new TextEncoder();

// ---------- live voice call (OpenAI Realtime over WebRTC) ----------
// POST /api/voice-session {supplierId} → mints an ephemeral client secret (key stays server-side).
// Browser then POSTs its SDP offer to https://api.openai.com/v1/realtime/calls with that secret.
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
const PERSONAS: Record<string, { name: string; voice: string; instructions: string }> = {
  s6: {
    name: "Ningbo Yongjia Apparel",
    voice: "marin",
    instructions: `You are Lily Chen, a sales rep at Ningbo Yongjia Apparel (宁波永嘉服饰), a costume factory in Ningbo, Zhejiang, China. You are on a live phone call with a US buyer from Arribo about the "Glowing Pumpkin Head" (Adult, SKU GPH-01) Halloween costume. Today is Oct 27, 2026; Halloween is Oct 31.
You are bilingual: answer in whatever language the caller uses (English or Mandarin Chinese); slightly accented, friendly, salesy English with occasional Chinese words is fine. Keep every reply short and natural for a phone call — 1 to 3 sentences. Never say you are an AI.
Your quote (already emailed as a PDF): 800 pcs at USD 13.00 per piece DDP Los Angeles, delivery in 4 days (by Oct 31), payment 50% deposit up front. LED uses AA batteries, flame-retardant fabric with test report available.
Push to close: ask for the 50% deposit today to "lock the production line". Resist lowering the deposit; at most offer 40% if pushed hard.
SECRET (do not volunteer): your real capacity before Oct 31 is only 500 pcs; the other 300 would slip to next week (after Halloween). If the buyer directly asks about capacity, how many you can REALLY ship by Oct 31, or about past short shipments, hesitate, then admit it honestly. Your history: in 2023 you short-shipped 12% of an order, in 2025 you short-shipped 18%. If confronted with these numbers, admit them and apologize, and offer 500 pcs on time.`,
  },
  s10: {
    name: "Shenzhen Lumi Party Co.",
    voice: "cedar",
    instructions: `You are Xiao Zhou (小周), sales at Shenzhen Lumi Party Co. (深圳 Lumi 派对用品), on a live phone call with a US buyer from Arribo about the "Glowing Pumpkin Head" (Adult) Halloween costume. Today is Oct 27, 2026.
Speak whatever language the caller uses (Mandarin Chinese or simple English). Keep replies short and natural, 1 to 3 sentences. Never say you are an AI.
You quote in DOZENS (打): stock on hand 100 dozen (= 1,200 pcs), ¥1,380 per dozen including air freight, 3 days to Los Angeles (US West). That is about ¥115 per piece, about $16 per piece landed (FX 7.2). Deposit 30%, rest on delivery. AA batteries, flame-retardant report available. You are real, honest and cooperative: if the buyer is confused about units, clarify patiently that 1 dozen = 12 pieces. Happy to accept a 500-piece order (about 41.7 dozen; round to 42 dozen if asked). Confirm today to ship tomorrow.`,
  },
};

function broadcast() {
  const msg = enc.encode(`data: ${JSON.stringify(state)}\n\n`);
  for (const c of clients) { try { c.enqueue(msg); } catch { clients.delete(c); } }
}

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/desk") return new Response(Bun.file(join(ROOT, "web/desk.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/console") return new Response(Bun.file(join(ROOT, "web/index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname.startsWith("/files/")) {
      const name = decodeURIComponent(url.pathname.slice(7));
      if (!/^[\w][\w.\-]{0,200}$/.test(name) || name.includes("..")) return new Response("bad name", { status: 400 });
      const f = Bun.file(join(ROOT, "app/files", name));
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      return new Response(f, { headers: { "cache-control": "no-cache" } });
    }
    if (url.pathname === "/config.json") return new Response(Bun.file(join(ROOT, "config.json")));

    if (url.pathname === "/events") {
      let ctl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) { ctl = c; clients.add(c); if (state) c.enqueue(enc.encode(`data: ${JSON.stringify(state)}\n\n`)); },
        cancel() { clients.delete(ctl); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
    }

    if (url.pathname === "/api/state" && req.method === "POST") { state = await req.json(); broadcast(); return Response.json({ ok: true }); }
    if (url.pathname === "/api/state") return Response.json(state);

    if (url.pathname === "/api/command" && req.method === "POST") { commands.push(await req.json()); return Response.json({ ok: true }); }
    if (url.pathname === "/api/commands") { const out = commands.splice(0); return Response.json(out); }

    if (url.pathname === "/voice.js") return new Response(Bun.file(join(ROOT, "web/voice.js")), { headers: { "content-type": "text/javascript" } });

    if (url.pathname === "/api/voice-session" && req.method === "POST") {
      const { supplierId = "s6" } = await req.json().catch(() => ({}));
      const p = PERSONAS[supplierId];
      if (!p) return Response.json({ error: `no voice persona for ${supplierId}` }, { status: 400 });
      if (!process.env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEY not set on server" }, { status: 500 });
      try {
        const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            expires_after: { anchor: "created_at", seconds: 600 },
            session: {
              type: "realtime",
              model: REALTIME_MODEL,
              instructions: p.instructions,
              audio: {
                input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad" } },
                output: { voice: p.voice },
              },
            },
          }),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) return Response.json({ error: j?.error?.message ?? `OpenAI HTTP ${r.status}` }, { status: 502 });
        return Response.json({ value: j.value ?? j.client_secret?.value, expires_at: j.expires_at, model: REALTIME_MODEL, name: p.name });
      } catch (e: any) {
        return Response.json({ error: "cannot reach api.openai.com: " + (e?.message ?? e) }, { status: 502 });
      }
    }
    // POST /api/voice-note {supplierId,text} → append a line to the live feed + queue for orchestrator
    if (url.pathname === "/api/voice-note" && req.method === "POST") {
      const note = await req.json();
      commands.push({ type: "voice_note", ...note });
      if (state?.feed) {
        state.feed.push({ t: "", from: note.supplierId ?? "system", text: note.text, thread: note.supplierId });
        broadcast();
      }
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});
console.log("Arribo console → http://localhost:" + (process.env.PORT ?? 3000) + "   (replay: /?mode=replay)");
