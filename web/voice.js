// Live voice call with an AI supplier (OpenAI Realtime over WebRTC).
// Flow: POST /api/voice-session → ephemeral key → SDP offer to /v1/realtime/calls → audio both ways.
(() => {
  const VOICE_IDS = ["s6", "s10"];
  const css = document.createElement("style");
  css.textContent = `
.vbtn{display:inline-block;margin-left:6px;padding:2px 7px;border-radius:10px;border:1px solid #ff8a1f;background:transparent;color:#ff8a1f;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.vbtn:hover{background:#ff8a1f;color:#111}
#vpanel{position:fixed;right:18px;bottom:18px;width:340px;z-index:9999;background:#15161a;color:#eee;border:1px solid #ff8a1f;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);font:13px/1.4 system-ui,sans-serif;display:none}
#vpanel .vh{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #333}
#vpanel .vdot{width:9px;height:9px;border-radius:50%;background:#888}
#vpanel .vdot.live{background:#3ddc84;animation:vp 1s infinite}
@keyframes vp{50%{opacity:.3}}
#vpanel .vname{font-weight:600;flex:1}
#vpanel .vtime{font-variant-numeric:tabular-nums;color:#aaa}
#vpanel .vstat{padding:6px 12px;color:#aaa;font-size:12px}
#vpanel .vstat.err{color:#ff6b6b}
#vpanel .vtx{max-height:220px;overflow:auto;padding:4px 12px 8px}
#vpanel .vtx div{margin:3px 0}
#vpanel .vtx b{color:#ff8a1f}
#vpanel .vtx b.me{color:#6cb6ff}
#vpanel .vft{padding:8px 12px;border-top:1px solid #333;text-align:right}
#vpanel .vhang{background:#e5484d;color:#fff;border:0;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer}`;
  document.head.appendChild(css);

  const panel = document.createElement("div");
  panel.id = "vpanel";
  panel.innerHTML = `<div class="vh"><span class="vdot"></span><span class="vname"></span><span class="vtime">00:00</span></div>
    <div class="vstat"></div><div class="vtx"></div>
    <div class="vft"><button class="vhang">Hang up</button></div>`;
  document.body.appendChild(panel);
  const q = (s) => panel.querySelector(s);

  let call = null; // {pc, dc, mic, audio, timer, t0, sid, name, lines, partial}

  window.voiceBtn = (s) => VOICE_IDS.includes(s.id) && s.status !== "ghost"
    ? `<button class="vbtn" data-voice="${s.id}" title="Live voice call (AI supplier)">📞 Call supplier</button>` : "";

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-voice]");
    if (b) { e.preventDefault(); startCall(b.dataset.voice); }
  });
  q(".vhang").onclick = () => hangUp();

  // S is a top-level `let` in index.html: visible as a global binding, not on window
  const getS = () => { try { return S; } catch { return null; } };
  const supName = (id) => (getS()?.suppliers || []).find((s) => s.id === id)?.name
    || ({ s6: "Ningbo Yongjia Apparel", s10: "Shenzhen Lumi Party Co." })[id] || id;
  const status = (t, err) => { const el = q(".vstat"); el.textContent = t; el.className = "vstat" + (err ? " err" : ""); };
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

  function renderTx() {
    const el = q(".vtx");
    const rows = call.lines.map((l) => `<div><b class="${l.me ? "me" : ""}">${l.me ? "Arribo" : "Supplier"}:</b> ${esc(l.text)}</div>`);
    if (call.partial) rows.push(`<div><b>Supplier:</b> ${esc(call.partial)}…</div>`);
    el.innerHTML = rows.join("");
    el.scrollTop = el.scrollHeight;
  }

  function onEvent(ev) {
    switch (ev.type) {
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript?.trim()) { call.lines.push({ me: true, text: ev.transcript.trim() }); renderTx(); }
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": // beta name
        call.partial += ev.delta || ""; renderTx();
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        call.lines.push({ me: false, text: (ev.transcript || call.partial).trim() }); call.partial = ""; renderTx();
        break;
      case "input_audio_buffer.speech_started": status("listening…"); break;
      case "response.created": status("supplier speaking…"); break;
      case "response.done": status("live"); break;
      case "error": status("error: " + (ev.error?.message || "unknown"), true); break;
    }
  }

  async function startCall(sid) {
    if (call) hangUp(true);
    call = { sid, name: supName(sid), lines: [], partial: "", t0: 0 };
    panel.style.display = "block";
    q(".vname").textContent = "📞 " + call.name;
    q(".vtime").textContent = "00:00";
    q(".vdot").className = "vdot";
    q(".vtx").innerHTML = "";
    const me = call;
    try {
      status("requesting session…");
      const r = await fetch("/api/voice-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ supplierId: sid }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.value) throw new Error(j.error || `session HTTP ${r.status}`);
      if (me !== call) return;

      status("opening microphone…");
      const pc = new RTCPeerConnection(); me.pc = pc;
      me.audio = document.createElement("audio"); me.audio.autoplay = true;
      pc.ontrack = (e) => { me.audio.srcObject = e.streams[0]; };
      me.mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(me.mic.getTracks()[0]);
      const dc = pc.createDataChannel("oai-events"); me.dc = dc;
      dc.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch {} };
      dc.onopen = () => {
        // supplier picks up the phone first
        dc.send(JSON.stringify({ type: "response.create", response: { instructions: "You just picked up the phone. Greet the caller briefly as yourself and your company." } }));
      };

      status("dialing…");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST", body: offer.sdp,
        headers: { Authorization: `Bearer ${j.value}`, "Content-Type": "application/sdp" },
      });
      if (!sdp.ok) throw new Error(`realtime/calls HTTP ${sdp.status}: ${(await sdp.text()).slice(0, 160)}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
      if (me !== call) return;

      status("live");
      q(".vdot").className = "vdot live";
      me.t0 = Date.now();
      me.timer = setInterval(() => {
        const s = Math.floor((Date.now() - me.t0) / 1000);
        q(".vtime").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      }, 500);
    } catch (e) {
      console.warn("[voice]", e);
      if (me === call) { status("Call failed: " + (e.message || e), true); cleanup(me); }
    }
  }

  function cleanup(c) {
    clearInterval(c.timer);
    try { c.dc?.close(); } catch {}
    try { c.pc?.close(); } catch {}
    c.mic?.getTracks().forEach((t) => t.stop());
    if (c.audio) c.audio.srcObject = null;
    q(".vdot").className = "vdot";
  }

  function hangUp(silent) {
    if (!call) { panel.style.display = "none"; return; }
    const c = call; call = null;
    cleanup(c);
    panel.style.display = "none";
    if (silent || !c.t0) return;
    const secs = Math.round((Date.now() - c.t0) / 1000);
    const last = c.lines.filter((l) => !l.me).slice(-1)[0]?.text || "";
    const text = `📞 Live call with ${c.name} (${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s, ${c.lines.length} turns).` + (last ? ` Last: "${last.slice(0, 140)}"` : "");
    const replay = document.getElementById("mode")?.value === "replay";
    if (replay && typeof window.feed === "function" && getS()) { feed(c.sid, text, c.sid); render(); }
    else fetch("/api/voice-note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ supplierId: c.sid, text, transcript: c.lines }) }).catch(() => {});
  }

  // index.html rendered once before this script loaded — re-render so buttons appear
  try { if (getS() && typeof window.render === "function") render(); } catch {}
})();
