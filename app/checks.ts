// app/checks.ts — live checks for Arribo Rush Desk. Code decides; the LLM only reads photos.
// Every external call: ≤4s timeout, never throws, on failure → result "unavailable".
import { createHash } from "node:crypto";
import AUTH from "./authorized.json";

export type CheckResult = "pass" | "fail" | "pending" | "unavailable";
export type Check = { id: string; name: string; result: CheckResult; detail: string; live: boolean; source?: string; at?: string };
export type Verdict = "OK" | "TRIAL" | "FAKE" | "HOLD";

const T = 4000;
const UNAVAIL = "source unavailable → needs human review";
const now = () => new Date().toISOString();
const mk = (id: string, name: string, result: CheckResult, detail: string, source?: string, live = true): Check =>
  ({ id, name, result, detail, live, source, at: now() });

/* ---------------- FX (frankfurter / ECB) ---------------- */
export type Fx = { CNY: number; MXN: number; JPY: number; KRW: number; CAD: number };
const FX_FALLBACK: Fx = { CNY: 7.2, MXN: 18, JPY: 150, KRW: 1380, CAD: 1.37 };
let fxCache: { at: number; rates: Fx; check: Check } | null = null;

export async function fxRates(): Promise<{ rates: Fx; check: Check }> {
  if (fxCache && Date.now() - fxCache.at < 10 * 60_000) return { rates: fxCache.rates, check: fxCache.check };
  const src = "api.frankfurter.dev (ECB)";
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY,MXN,JPY,KRW,CAD", { signal: AbortSignal.timeout(T) });
    if (!r.ok) throw new Error("http " + r.status);
    const j: any = await r.json();
    const rates = { ...FX_FALLBACK, ...j.rates } as Fx;
    const check = mk("fx", "FX rates", "pass", `1 USD = ${rates.CNY} CNY · ${rates.MXN} MXN (ECB ${j.date})`, src);
    fxCache = { at: Date.now(), rates, check };
    return { rates, check };
  } catch {
    return { rates: FX_FALLBACK, check: mk("fx", "FX rates", "unavailable", `${UNAVAIL} — using fallback 1 USD = ${FX_FALLBACK.CNY} CNY`, src) };
  }
}

/* ---------------- RDAP domain age ---------------- */
export async function rdapCheck(domain: string): Promise<Check & { registered?: string; ageDays?: number }> {
  const d = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  const name = "Website domain age";
  if (!d || !d.includes(".")) return mk("domain", name, "unavailable", "no domain given");
  const url = d.endsWith(".com") ? `https://rdap.verisign.com/com/v1/domain/${d}` : `https://rdap.org/domain/${d}`;
  const src = d.endsWith(".com") ? "rdap.verisign.com" : "rdap.org";
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(T), headers: { accept: "application/rdap+json" } });
    if (r.status === 404) return mk("domain", name, "fail", `${d}: domain not registered`, src);
    if (!r.ok) throw new Error("http " + r.status);
    const j: any = await r.json();
    const ev = (j.events || []).find((e: any) => e.eventAction === "registration");
    if (!ev?.eventDate) return mk("domain", name, "unavailable", `${d}: no registration date in RDAP — needs human review`, src);
    const reg = new Date(ev.eventDate);
    const ageDays = Math.floor((Date.now() - reg.getTime()) / 86_400_000);
    const ymd = reg.toISOString().slice(0, 10);
    const ago = ageDays >= 730 ? `${Math.floor(ageDays / 365)} years ago` : `${ageDays} days ago`;
    return { ...mk("domain", name, ageDays < 90 ? "fail" : "pass", `${d} registered ${ymd} (${ago})`, src), registered: ymd, ageDays };
  } catch {
    return mk("domain", name, "unavailable", `${d}: ${UNAVAIL}`, src);
  }
}

/* ---------------- Nominatim geocode (global ≤1 req/s) ---------------- */
export type LatLon = { lat: number; lon: number };
let nomChain: Promise<void> = Promise.resolve();
let nomLast = 0;
function nomSlot(): Promise<void> {
  const p = nomChain.then(async () => {
    const wait = nomLast + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nomLast = Date.now();
  });
  nomChain = p.catch(() => {});
  return p;
}
const geoCache = new Map<string, any>();
// Pre-seed a known address (offline fallback / tests). Seeded results are marked live:false.
export function seedGeocode(address: string, lat: number, lon: number, display = address) {
  geoCache.set(address.trim(), { check: mk("address", "Factory address exists", "pass", `found: ${display}`, "seeded (offline)", false), lat, lon, display });
}

export async function geocodeCheck(address: string, opts: { id?: string; name?: string } = {}):
  Promise<{ check: Check; lat?: number; lon?: number; display?: string }> {
  const id = opts.id ?? "address", name = opts.name ?? "Factory address exists";
  const src = "nominatim.openstreetmap.org";
  const q = String(address || "").trim();
  if (!q) return { check: mk(id, name, "unavailable", "no address given") };
  if (geoCache.has(q)) return geoCache.get(q);
  try {
    await nomSlot();
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
      { headers: { "User-Agent": "arribo-hackathon/1.0", "accept-language": "en" }, signal: AbortSignal.timeout(T) });
    if (!r.ok) throw new Error("http " + r.status);
    const j: any[] = await r.json();
    let out;
    if (!j.length) out = { check: mk(id, name, "fail", `"${q}" not found on OpenStreetMap`, src) };
    else {
      const lat = +j[0].lat, lon = +j[0].lon, display = String(j[0].display_name);
      out = { check: mk(id, name, "pass", `found: ${display.slice(0, 120)}`, src), lat, lon, display };
    }
    geoCache.set(q, out);
    return out;
  } catch {
    return { check: mk(id, name, "unavailable", `${UNAVAIL}`, src) };
  }
}

export function distanceKm(a: LatLon, b: LatLon): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------------- OpenAI vision (Labubu) ---------------- */
export type Img = { base64: string; mime: string; buffer?: Uint8Array };
const VISION_SYS = `You inspect a supplier photo for a Pop Mart Labubu buyer. Return JSON only:
{"is_labubu":boolean,"teeth_count":number|null,"foot_stamp_visible":boolean,"qr_visible":boolean,"qr_text":string|null,
"handwritten_code":string|null,"location_clues":string,"notes":string,"confidence":number}
Rules: count the visible teeth in Labubu's grin exactly (authentic = 9). foot_stamp_visible = Pop Mart stamp/print on a sole.
qr_text = the URL/text the QR encodes if you can read it (or printed next to it), else null.
handwritten_code = text handwritten on paper in the photo (e.g. ARB-7Q2K), else null.
location_clues = visible landmarks, signage, language, plugs, license plates suggesting where the photo was taken ("" if none).
confidence 0..1 for your authenticity read.`;

export async function visionLabubu(image: Img, expectCode?: string): Promise<{ checks: Check[]; raw?: any }> {
  const src = "OpenAI vision (" + (process.env.OPENAI_MODEL ?? "gpt-4.1-mini") + ")";
  let v: any;
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error("no key");
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini", temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "system", content: VISION_SYS }, { role: "user", content: [
          { type: "text", text: "Inspect this photo." + (expectCode ? ` We asked them to handwrite code ${expectCode}.` : "") },
          { type: "image_url", image_url: { url: `data:${image.mime || "image/jpeg"};base64,${image.base64}` } }] }],
      }),
      signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS ?? T)),
    });
    if (!r.ok) throw new Error("openai " + r.status);
    const j: any = await r.json();
    v = JSON.parse(j.choices[0].message.content);
  } catch {
    return { checks: [
      mk("authenticity", "Labubu authenticity", "unavailable", UNAVAIL, src),
      mk("code", "Verification code", "unavailable", UNAVAIL, src),
      mk("qr", "Box QR code", "unavailable", UNAVAIL, src),
      mk("photo_clues", "Photo location clues", "unavailable", UNAVAIL, src),
    ] };
  }
  return { checks: mapVision(v, expectCode, src), raw: v };
}

export function mapVision(v: any, expectCode: string | undefined, src = "OpenAI vision"): Check[] {
  const out: Check[] = [];
  const conf = Number(v.confidence ?? 0);
  const teeth = v.teeth_count == null ? null : Number(v.teeth_count);
  if (!v.is_labubu) out.push(mk("authenticity", "Labubu authenticity", "unavailable", "no Labubu in photo", src));
  else if (teeth != null && teeth !== 9) out.push(mk("authenticity", "Labubu authenticity", "fail", `${teeth} teeth — real Labubu has 9`, src));
  else if (teeth === 9 && (v.foot_stamp_visible || conf >= 0.8))
    out.push(mk("authenticity", "Labubu authenticity", "pass", `9 teeth${v.foot_stamp_visible ? " · Pop Mart foot stamp visible" : ""} · confidence ${conf.toFixed(2)}`, src));
  else out.push(mk("authenticity", "Labubu authenticity", "unavailable", `inconclusive (teeth ${teeth ?? "?"}, confidence ${conf.toFixed(2)}) — needs human review`, src));

  const got = v.handwritten_code ? String(v.handwritten_code).trim() : "";
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!expectCode) out.push(mk("code", "Verification code", got ? "pass" : "unavailable", got ? `read "${got}" (no code requested)` : "no code requested", src));
  else if (!got) out.push(mk("code", "Verification code", "fail", `no handwritten code in photo (expected ${expectCode})`, src));
  else if (norm(got) === norm(expectCode)) out.push(mk("code", "Verification code", "pass", `handwritten "${got}" matches ${expectCode} — photo is fresh`, src));
  else out.push(mk("code", "Verification code", "fail", `handwritten "${got}" ≠ ${expectCode}`, src));

  const qt = v.qr_text ? String(v.qr_text).trim() : "";
  if (qt) {
    const host = (qt.match(/^(?:https?:\/\/)?([^/\s?#]+)/i)?.[1] || "").toLowerCase();
    const ok = host === "popmart.com" || host.endsWith(".popmart.com");
    out.push(mk("qr", "Box QR code", ok ? "pass" : "fail", ok ? `QR → ${host} (official)` : `QR → ${host || qt.slice(0, 40)} — not popmart.com`, src));
  } else out.push(mk("qr", "Box QR code", "unavailable", v.qr_visible ? "QR visible but unreadable" : "no QR in photo", src));

  const clues = String(v.location_clues || "").trim();
  out.push(mk("photo_clues", "Photo location clues", clues ? "pass" : "unavailable", clues || "no location clues visible", src));
  if (v.notes) out[0].detail += ` — ${String(v.notes).slice(0, 100)}`;
  return out;
}

/* ---------------- EXIF GPS (hand-rolled JPEG/TIFF parser) ---------------- */
export function exifLocation(buf: Uint8Array | ArrayBuffer | null | undefined): LatLon | null {
  try {
    if (!buf) return null;
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 < b.length) {
      if (b[p] !== 0xff) return null;
      const marker = b[p + 1], len = dv.getUint16(p + 2);
      if (marker === 0xe1 && String.fromCharCode(...b.subarray(p + 4, p + 8)) === "Exif") return parseTiffGps(dv, p + 10);
      if (marker === 0xda) return null;
      p += 2 + len;
    }
    return null;
  } catch { return null; }
}
function parseTiffGps(dv: DataView, t: number): LatLon | null {
  const le = dv.getUint16(t) === 0x4949;
  const u16 = (o: number) => dv.getUint16(t + o, le), u32 = (o: number) => dv.getUint32(t + o, le);
  const ifd0 = u32(4);
  let gpsOff = 0;
  for (let i = 0, n = u16(ifd0); i < n; i++) { const e = ifd0 + 2 + i * 12; if (u16(e) === 0x8825) gpsOff = u32(e + 8); }
  if (!gpsOff) return null;
  const tags: Record<number, any> = {};
  const rat3 = (o: number) => [0, 1, 2].map((k) => u32(o + k * 8) / (u32(o + k * 8 + 4) || 1));
  for (let i = 0, n = u16(gpsOff); i < n; i++) {
    const e = gpsOff + 2 + i * 12, tag = u16(e), type = u16(e + 2);
    if (type === 2) tags[tag] = String.fromCharCode(dv.getUint8(t + e + 8)); // ref char (inline)
    else if (type === 5) tags[tag] = rat3(u32(e + 8));
  }
  if (!tags[2] || !tags[4]) return null;
  const dms = (a: number[]) => a[0] + a[1] / 60 + a[2] / 3600;
  let lat = dms(tags[2]), lon = dms(tags[4]);
  if (tags[1] === "S") lat = -lat;
  if (tags[3] === "W") lon = -lon;
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/* ---------------- photo hash / duplicates ---------------- */
// sha256 of bytes → exact-duplicate detection (re-sent / forwarded same file). Returns first 16 hex chars (64-bit).
export function photoHash(buf: Uint8Array | ArrayBuffer): string {
  return createHash("sha256").update(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).digest("hex").slice(0, 16);
}
export function duplicateCheck(hash: string, knownHashes: Record<string, string | string[]>, selfId?: string): Check {
  for (const [who, h] of Object.entries(knownHashes || {})) {
    if (who === selfId) continue;
    if ((Array.isArray(h) ? h : [h]).includes(hash)) return mk("duplicate", "Duplicate photo", "fail", `same photo as ${who}`, "sha256 (exact match)");
  }
  return mk("duplicate", "Duplicate photo", "pass", `photo ${hash.slice(0, 8)}… not seen from any other supplier`, "sha256 (exact match)");
}

/* ---------------- price floor ---------------- */
export function priceFloorCheck(unitUsd?: number | null, floorUsd: number = (AUTH as any).floorUnitUsd ?? 13.8): Check {
  const f = (n: number) => "$" + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, "");
  if (unitUsd == null || !isFinite(unitUsd)) return mk("price_floor", "Price floor", "unavailable", "no unit price quoted", "authorized wholesale + freight", false);
  // floorUsd is already the hard floor (= 60% of authorized wholesale+freight, e.g. $23 × 0.6 = $13.80)
  if (unitUsd < floorUsd) return mk("price_floor", "Price floor", "fail", `${f(unitUsd)} is below the authorized floor ${f(floorUsd)} — too cheap to be real`, "authorized wholesale + freight", false);
  return mk("price_floor", "Price floor", "pass", `${f(unitUsd)} vs authorized floor ${f(floorUsd)}`, "authorized wholesale + freight", false);
}

/* ---------------- authorized distributor list ---------------- */
export function authorizedCheck(name?: string, domain?: string): Check {
  const src = "app/authorized.json (Pop Mart channel list)";
  const n = String(name || "").toLowerCase().trim();
  const d = String(domain || "").toLowerCase();
  if (!n && !d) return mk("authorized", "Authorized channel", "unavailable", "no company name given", src, false);
  const hit = (AUTH as any).authorized.find((a: any) =>
    [a.name, ...(a.aliases || [])].some((x: string) => n && (n.includes(x.toLowerCase()) || x.toLowerCase() === n)) || (a.domain && d.endsWith(a.domain)));
  if (hit) return mk("authorized", "Authorized channel", "pass", `${hit.name} is on the Pop Mart authorized list (${hit.region})`, src, false);
  const flag = (AUTH as any).redFlags.find((r: string) => n.includes(r));
  return mk("authorized", "Authorized channel", "fail",
    `"${name}" is not an authorized Pop Mart distributor${flag ? ` — Pop Mart does not sell via "${flag}" OEMs` : ""}`, src, false);
}

/* ---------------- deposit rule (code decides) ---------------- */
const CRITICAL = ["authenticity", "warehouse", "inventory", "payee", "location"];
export function canReleaseDeposit(checks: Check[], hasHistory = false): { release: boolean; verdict: Verdict; reasons: string[] } {
  const fails = checks.filter((c) => c.result === "fail");
  const crit = fails.filter((c) => CRITICAL.includes(c.id));
  const reasons = fails.map((c) => `${c.name}: ${c.detail}`);
  if (fails.length >= 3) return { release: false, verdict: "FAKE", reasons };
  if (crit.length) return { release: false, verdict: "HOLD", reasons };
  if (fails.length) return { release: false, verdict: "HOLD", reasons };
  const unk = checks.filter((c) => c.result === "unavailable" && CRITICAL.includes(c.id));
  if (unk.length) return { release: false, verdict: "HOLD", reasons: unk.map((c) => `${c.name}: ${c.detail}`) };
  if (!hasHistory) return { release: false, verdict: "TRIAL", reasons: ["all checks pass but no order history → TRIAL (pay on delivery)"] };
  return { release: true, verdict: "OK", reasons: ["all checks pass"] };
}

/* ---------------- orchestrate one factory ---------------- */
export type FactoryInput = {
  id?: string; name: string; address?: string; domain?: string; quoteUnitUsd?: number | null; floorUsd?: number;
  photos?: Img[]; expectCode?: string; knownHashes?: Record<string, string | string[]>; hasHistory?: boolean;
};
export async function judgeFactory(input: FactoryInput): Promise<{
  checks: Check[]; verdict: Verdict; release: boolean; reasons: string[]; headline: { title: string; reason: string; checks: Check[] }; hashes: string[]; vision?: any[];
}> {
  const photos = input.photos ?? [];
  const city = cityOf(input.address);
  const [geo, dom, vis] = await Promise.all([
    input.address ? geocodeCheck(input.address) : Promise.resolve(null),
    input.domain ? rdapCheck(input.domain) : Promise.resolve(null),
    Promise.all(photos.map((p) => visionLabubu(p, input.expectCode))),
  ]);
  const checks: Check[] = [];
  // vision: keep the most decisive result per check id across photos (fail > pass > unavailable)
  const rank: Record<string, number> = { fail: 3, pass: 2, pending: 1, unavailable: 0 };
  const best = new Map<string, Check>();
  for (const v of vis) for (const c of v.checks) { const o = best.get(c.id); if (!o || rank[c.result] > rank[o.result]) best.set(c.id, c); }
  checks.push(...best.values());
  if (geo) checks.push(geo.check);
  // location: EXIF GPS vs claimed address
  const gps = photos.map((p) => p.buffer && exifLocation(p.buffer)).find(Boolean) as LatLon | undefined;
  if (gps && geo?.lat != null) {
    const km = Math.round(distanceKm(gps, { lat: geo.lat!, lon: geo.lon! }));
    checks.push(mk("location", "Photo taken where claimed", km > 300 ? "fail" : "pass",
      km > 300 ? `photo taken ${km.toLocaleString("en-US")} km from ${city}` : `photo taken ${km} km from ${city}`, "EXIF GPS + Nominatim"));
  } else checks.push(mk("location", "Photo taken where claimed", "unavailable", gps ? "address not geocoded — needs human review" : "no GPS in photo (EXIF stripped) — needs human review", "EXIF GPS"));
  if (dom) checks.push(dom);
  const hashes = photos.filter((p) => p.buffer).map((p) => photoHash(p.buffer!));
  if (hashes.length) {
    const dups = hashes.map((h) => duplicateCheck(h, input.knownHashes ?? {}, input.id));
    checks.push(dups.find((d) => d.result === "fail") ?? dups[0]);
  }
  checks.push(priceFloorCheck(input.quoteUnitUsd, input.floorUsd));
  checks.push(authorizedCheck(input.name, input.domain));

  const { release, verdict, reasons } = canReleaseDeposit(checks, input.hasHistory);
  const r = (id: string) => checks.find((c) => c.id === id)?.result;
  const factoryBad = ["location", "authorized", "domain", "duplicate", "address", "price_floor", "code", "qr"].filter((id) => r(id) === "fail");
  let title: string;
  if (r("authenticity") === "pass" && factoryBad.length) title = "The Labubu is real. The factory isn't.";
  else if (r("authenticity") === "fail") title = "Fake Labubu.";
  else if (verdict === "FAKE") title = "This factory isn't real.";
  else if (verdict === "TRIAL") title = "Looks legit — trial order, pay on delivery.";
  else if (verdict === "OK") title = "Verified — deposit can be released.";
  else title = "Hold the deposit — needs a human look.";
  const reason = reasons.slice(0, 3).join(" · ") || "all live checks passed";
  return { checks, verdict, release, reasons, headline: { title, reason, checks }, hashes, vision: vis.map((v) => v.raw) };
}

function cityOf(addr?: string): string {
  const a = String(addr || "");
  const known = ["Dongguan", "Shenzhen", "Guangzhou", "Yiwu", "Shantou", "Los Angeles", "Ningbo"];
  return known.find((k) => a.toLowerCase().includes(k.toLowerCase())) ?? (a.split(",").map((s) => s.trim()).filter(Boolean).slice(-2)[0] || "the claimed address");
}
