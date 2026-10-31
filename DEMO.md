# Costume Rush · Demo Script (team Trick or Trade, built on Arribo)

Haunted Hacks: Real-Time AI Edition · YC SF · Oct 31, 2026
**A** = presenter (talks, faces judges, does the voice call). **B** = driver (laptop, terminals, clicks; never talks unless asked).

Lines to land no matter what:
- **"The suppliers are simulated. Everything Arribo does is live."**
- **"Agents lie. Arribo verifies."**
- *LLM reads messages and talks. Deterministic code makes every money decision.*

---

## 0. Run mechanics B must know (why the order is what it is)

- Start the orchestrator with **`MS_PER_DAY=15000`** (15s per sim day, the max allowed by `config.json`). Rough timeline after **Send RFQ** (t=0):
  - flood ~t+0–10s
  - screening plus Ningbo/Shenzhen text clarifications ~t+10–15s
  - ghosts and 3PL ~t+15–25s
  - Yiwu rush ~t+25–30s
  - **POs ~t+30–35s**
  - Oct 28 ~t+50s, **Oct 29 ~t+65s**, Oct 30 ~t+80s, Oct 31 ~t+95s, settlement ~t+110s
  - A kill-and-restart pauses the clock (a fresh 15s day starts after resume), which buys ~10s.
- The run **does not wait** for the voice call. POs land while A is on the phone. That's fine and part of the story ("Arribo kept working while I was on the phone").
- **Judge edit window:** do it when the clock shows **Oct 29 or Oct 30**.
  - Shenzhen (air, 3 days) and Monterrey (truck, 3 days) can no longer land by Oct 31, so Arribo reports them as blocked. Only Dallas (ground, 1 day, $24, on standby) can fill the gap.
  - Step 1, qty 1500 with ceiling $18: **"Shortfall 250 pcs — Lone Star $24 > $18 ceiling (raise to ≥$24 to unlock)"**.
  - Step 2, ceiling 25: Dallas comes off standby, **+250 @ $24, PO ARB-2026-1044**.
  - If you edit earlier (Oct 27–28), Shenzhen and Monterrey get the top-up first and Dallas gets only ~+50. It still works; A just reads the re-plan line.
  - After the Oct 31 tick, nothing can land, and Arribo says so.
- Inputs fire on **Enter/Tab** (change event). Edit **ceiling first, Enter** only if you want to skip the shortfall beat; the script does qty first on purpose.
- With the judge's 1,500, settlement is about **+$21.6k with ~300 zombies** (demand is fixed at 1,200 in config). Without the edit it's about **+$27.5k with 50 zombies**. Read it off the screen and own it (see 2:30).

---

## 1. Three-minute script (English)

Before the timer: Live mode, Reset clicked, qty 1250 / ceiling $18, terminal 2 visible in split screen, Chrome mic permission already granted for `localhost:3000`.

| Time | A says | B does |
|---|---|---|
| **0:00** | "October 27th. A glowing pumpkin-head costume just went viral. Search is up 8x in a week. A retailer needs 1,250 in LA by Halloween. Arrive one day late and every unit is a **zombie**: dead stock on November 1st." | Console with the spec panel. |
| **0:12** | "This is Arribo, our procurement agent. **The suppliers are simulated. Everything Arribo does is live**: OpenAI parsing and dialogue, Relaycast messaging, Terse durable state. The spec: landed $18 or less, AA batteries only, flame-retardant test report, deposit 30% or less." | — |
| **0:22** | "One RFQ, 12 supplier agents." | **Send RFQ.** |
| **0:25** | "Here comes the flood. WeChat in Chinese, email in Spanish, a PDF, an Excel row, a voice transcript. RMB, **dozens**, EXW, FOB, DDP. Every message is parsed in parallel into one number: landed dollars per piece. Shenzhen quoted '100 打 at ¥1,380 a dozen including air.' Arribo asked them to confirm the unit, then turned it into $15.97 a piece." | Points at rows flipping *parsing → quoted*, then at the Shenzhen thread. |
| **0:40** | "Screening is plain code. Coin cells: out. 'No paperwork': out. Cheapest factory ships by sea and lands November 15th: out. Sold out: out." | Scrolls the table; reasons are visible. |
| **0:48** | "BooSupply at $11 and GhostlyGoods at $9 have thousands 'in stock' and no history. **Agents lie. Arribo verifies.** It asks for a receipt, they dodge, so it asks their warehouse directly. *No inventory on record.* Ghost stock, caught before a single deposit." | Points at **👻 GHOST STOCK** and the deposit-protected line. |
| **0:58** | "Ningbo quoted 800 at $13, but they short-shipped in 2023 and 2025. Let's call them. Live." | Clicks **📞 Call supplier** on the **Ningbo Yongjia** row. Supplier speaks first. |
| **1:02** | *(to the phone)* "Hi Lily, how many can you **really** ship by October 31st?" … *(she hedges, then admits 500)* … "Thanks, we'll come back to you." | Clicks **Hang up** when she says 500. A call summary posts to the feed. |
| **1:22** | "While I was on the phone, Arribo kept going. Yiwu quoted 5 days, which is too late, but it delivered early in 2023 and 2024. So Arribo asked in Chinese and unlocked rush air. Sea is cheaper and lands November 14th: zombies. Rush air wins, with the reason written down. POs are out: Shenzhen 500, Monterrey 500, Yiwu 250 rush, each in the supplier's own language." | Points at the **Freight decision** card, then the **POs** panel. Watches the clock. |
| **1:40** | "Judge, you're the buyer. Marketing just doubled the forecast. Change the quantity to 1,500." | Clock should read **Oct 29**; if not, A stretches. Judge (or B on their word) sets **Quantity 1500 + Enter**. |
| **1:48** | "Arribo re-plans live. It's October 29th, so Shenzhen and Monterrey can't land in time anymore. Dallas can, but it's $24, over your $18 ceiling. Short 250. It won't fake it. Raise the ceiling?" | Points at the "Re-plan #1 … Shortfall 250" line. Judge/B sets **Max landed 25 + Enter**. |
| **1:58** | "Dallas comes off standby: plus 250 at $24, PO 1044." | Points at the new PO ARB-2026-1044 and its tracking number. |
| **2:05** | "Now we kill the orchestrator." | **Ctrl-C** (or `kill -9`) in terminal 2, then **↑ Enter**. Terminal shows `[durable] Terse actor Run…` and `[resume]`. |
| **2:10** | "State lives in a Terse durable actor. It comes back, rebuilds from the actor, and every message and PO is a keyed exactly-once step. Same four POs, same tracking numbers, nothing re-sent to suppliers." | Points at the POs panel (unchanged) and the feed (no duplicates). |
| **2:25** | "Midnight, Halloween." | Settlement modal appears (~2:25–2:35). |
| **2:30** | "Arribo: everything landed on time, zero deposits lost, **[profit on screen]**. Your extra 250 became zombies, because real demand was 1,200. Arribo buys what you ask, and tells you what it costs. The gut-feel buyer took the cheapest quotes and believed them: $4,050 deposit to a ghost, 1,500 units arriving by sea after Halloween, **minus $11,550**." | Modal on screen. |
| **2:48** | "Seasonal buying is a race against a date, and lying and over-promising are part of the game. Arribo reads every message, checks every claim, and never pays a ghost. We're Trick or Trade. Thank you." | Leaves the modal up. |

If the clock runs ahead (Oct 31 already at 1:40), keep the edit anyway. Arribo will say nothing can land by Oct 31 now. A: "And it tells you that honestly, instead of booking stock that shows up as zombies."

---

## 2. Thirty-second version

> "A costume goes viral on October 27th, and you need 1,250 in LA by Halloween. A day late is dead stock. Zombies. Arribo sends one RFQ to 12 suppliers and parses Chinese, Spanish, dozens, RMB, and FOB live into landed dollars per piece. Code, not the LLM, screens out coin cells and sea freight that lands after Halloween. Two suppliers claim thousands in stock at half price. Arribo asks their warehouse: zero inventory. **Agents lie, Arribo verifies.** It calls a factory by voice and gets them to admit real capacity is 500, not 800. It unlocks rush air using delivery history, re-plans live when the spec changes, and survives a kill -9 without sending a duplicate PO. Result: about +$27k versus −$11.5k for a gut-feel buyer. The suppliers are simulated. Everything Arribo does is live."

---

## 3. 三分钟脚本（中文，排练用）

| 时间 | A 说 | B 操作 |
|---|---|---|
| **0:00** | "10 月 27 号。一款发光南瓜头套突然爆火，一周搜索量涨了 8 倍。零售商要在万圣节前把 1,250 个送到洛杉矶。晚到一天，每一个都是**僵尸**：11 月 1 号就是死库存。" | 控制台，spec 面板 |
| **0:12** | "这是 Arribo，我们的采购 agent。**供应商是模拟的，Arribo 做的每一步都是实时的**：OpenAI 解析和对话、Relaycast 消息、Terse 持久化状态。要求：到岸价 ≤ $18，只要 AA 电池，阻燃检测报告，定金 ≤ 30%。" | — |
| **0:22** | "一份 RFQ，发给 12 个供应商 agent。" | 点 **Send RFQ** |
| **0:25** | "报价涌进来了：中文微信、西班牙语邮件、PDF、Excel、语音转写。人民币、**按打报价**、EXW、FOB、DDP。每条消息并行解析成一个数：每件到岸美元价。深圳报'100 打，¥1,380 一打含空运'，Arribo 先跟对方确认单位，再换算成每件 $15.97。" | 指向表格 parsing → quoted，再指深圳对话 |
| **0:40** | "筛选用的是确定性代码。纽扣电池：淘汰。没有文件：淘汰。最便宜的工厂走海运，11 月 15 号才到：淘汰。售罄：淘汰。" | 滚动表格 |
| **0:48** | "BooSupply 报 $11，GhostlyGoods 报 $9，号称有几千件现货，但没有任何交易记录。**Agent 会撒谎，Arribo 会核实。**要仓单，对方推脱；Arribo 直接问他们的仓库：*没有任何库存记录。*幽灵库存，在付出任何定金之前就被抓到了。" | 指向 👻 GHOST STOCK |
| **0:58** | "宁波报 800 个、$13，但他们 2023 和 2025 年都短装过。我们现场打电话给他们。" | 在**宁波永嘉**那一行点 **📞 Call supplier**，对方先开口 |
| **1:02** | （对电话，用英文）"Hi Lily, how many can you **really** ship by October 31st?" ……（对方犹豫，然后承认只有 500）…… "Thanks, we'll come back to you." | 对方说出 500 后点 **Hang up**，通话摘要进 feed |
| **1:22** | "我打电话的时候，Arribo 一直在干活。义乌报 5 天，赶不上；但历史上 2023、2024 年都提前交货，所以 Arribo 用中文去问，谈下了加急空运。海运更便宜，但 11 月 14 号才到，全是僵尸，所以选加急空运，理由也写下来了。PO 已经发出：深圳 500、蒙特雷 500、义乌加急 250，用各家自己的语言。" | 指决策卡片和 PO 面板，盯时钟 |
| **1:40** | "请评委当采购：市场部刚把预测翻倍，把数量改成 1,500。" | 时钟应在 **Oct 29**。数量改 **1500 回车** |
| **1:48** | "Arribo 实时重新规划。今天已经 10 月 29 号，深圳和蒙特雷来不及了。达拉斯能到，但单价 $24，超过 $18 上限。缺 250 件，它不会硬凑。要不要提高上限？" | 指 "Re-plan #1 … Shortfall 250"。上限改 **25 回车** |
| **1:58** | "达拉斯从备选转正：+250 件 @ $24，PO 1044。" | 指新的 PO ARB-2026-1044 和运单号 |
| **2:05** | "现在我们直接把编排器杀掉。" | 终端 2 **Ctrl-C**（或 kill -9），**↑ 回车**，出现 `[durable] Terse…` 和 `[resume]` |
| **2:10** | "状态存在 Terse durable actor 里。重启后从 actor 恢复，每条消息、每张 PO 都是带 key 的 exactly-once 步骤。还是那四张 PO、同样的运单号，没有一条消息重发给供应商。" | 指 PO 面板（不变）和 feed（无重复） |
| **2:25** | "万圣节午夜。" | 结算弹窗 |
| **2:30** | "Arribo：全部准时到货，零定金损失，**盈利 [看屏幕]**。你多订的 250 件变成了僵尸，因为真实需求是 1,200。Arribo 按你的要求买，同时告诉你代价。凭感觉的采购员选最便宜的、相信对方说的：$4,050 定金被幽灵骗走，1,500 件海运货万圣节后才到，**亏 $11,550**。" | 弹窗 |
| **2:48** | "季节性采购就是和日期赛跑，撒谎和过度承诺是常态。Arribo 读每条消息、核实每个承诺、从不给幽灵付钱。我们是 Trick or Trade，谢谢。" | 弹窗留着 |

---

## 4. Backup plan (B owns it; A says at most one sentence and keeps going)

| Failure | Symptom | Action | What A says |
|---|---|---|---|
| **OpenAI down / slow / 429** | Rows stuck on *parsing*, extract errors in terminal | Parsing and persona replies fall back to deterministic values automatically, so keep going. If the run stalls for more than 10s: Source → **Replay** (or `localhost:3000/?mode=replay`), Send RFQ. Replay has no live spec edit or kill; voice still works in replay. | "Wi-Fi gremlins. Here's this morning's recorded run; same decision code." |
| **Relaycast down / no key** | `[relay] disabled` / `send failed` in terminal | Nothing to do. The run continues on the local feed and the UI is identical. | Drop "on Relaycast." If asked: "Transport is pluggable; it falls back to the local feed." |
| **Voice fails** (no audio, mic blocked, Realtime error, model won't admit 500) | Panel shows a red status, or silence for 5s | **Hang up immediately.** Point at the feed: Arribo already asked Ningbo in text and got "500" (the s6 thread). Skip to 1:22. | "Same question, already answered in writing: real capacity is 500. History doesn't lie." |
| **Voice runs long** | Still talking at 1:25 | Hang up. Summary posts anyway. | "Got what we needed." |
| **Terse dev server down** | Terminal shows `[durable] Terse unavailable, using local journal` | Kill-and-resume still works on the journal. | Say "durable journal" instead of "Terse actor." Don't claim Terse. |
| **Restart doesn't resume** | No `[resume]` line | Check that you restarted from the repo root with the same command and env. If still broken, don't retry on stage. | "We'll show exactly-once in Q&A." |
| **Judge edit misses the window** | Edit at Oct 27–28 (Shenzhen/Monterrey top-up, Dallas ~+50) or after Oct 31 (nothing can land) | Let it play; read the re-plan line aloud. | Early: "It prefers the cheaper suppliers while they can still land." Late: "Too late for anyone to land, and it tells you instead of buying zombies." |
| **Judge types something wild** (0, 99999) | Odd cut/shortfall | If it's 500–2,000, let it play (lowering cancels the latest unarrived POs). Otherwise: "Let's keep it realistic: 1,500?" | — |
| **UI frozen / SSE dropped** | "reconnecting…" by the clock | Refresh the page; the orchestrator re-pushes state. | — |
| **Laptop dead** | — | Second laptop with replay preloaded, plus a 3-min screen recording on a phone. | — |

---

## 5. Likely judge Q&A

**1. Why is this a company, not a hackathon toy?**
Seasonal and trend-driven buying is deadline-bound and high-variance. Buyers juggle dozens of suppliers across languages, units, and Incoterms. The costly mistakes are fraud, over-promised capacity, and arriving a day late. Arribo does that coordination end to end. Today is the extreme version (a 4-day window). The everyday version is the same loop running on every PO.

**2. What's real vs simulated?**
Simulated: the 12 suppliers (6 driven by LLM personas: Yiwu, both ghosts, Ningbo, Shenzhen, Monterrey; the rest scripted), the 3PL, and the clock. Live: OpenAI parsing, the Realtime voice call, Relaycast messages, screening, verification, freight math, allocation, re-planning, POs, and Terse durable state. The gut-feel baseline is a fixed rule set (cheapest quote, trust claims, first quoted lead time), not tuned after the fact.

**3. Why not let the LLM decide?**
Money decisions must be reproducible and auditable. The LLM reads messy multilingual messages and holds conversations. Landed cost, spec checks, risk ranking (landed × (1 + risk), 40% cap per supplier), air vs sea, and re-planning are deterministic code you can test and explain to a CFO. The LLM never sets a price or a quantity on a PO.

**4. Why Terse / durable actors?**
A procurement run lasts days and moves money. A crash must not re-send a PO or pay a deposit twice. Each run is a Terse actor holding the full run state plus idempotency keys, and every external side effect is a keyed exactly-once step. You saw kill -9: same POs, same tracking numbers, nothing duplicated.

**5. Why Agent Relay / Relaycast?**
Suppliers, 3PLs, and forwarders will run their own agents. Arribo needs identities, per-supplier threads, and idempotent sends across many counterparties without building messaging infrastructure. Each supplier and the 3PL is a registered agent on `#costume-rush`, with a thread per supplier.

**6. Verification against a fake 3PL won't scale. How does it really work?**
The pattern is: never trust the claim, ask an independent party. In production that means 3PL/WMS inventory APIs (or portal/email when there's no API), forwarder and carrier tracking, business registries and import/trade records (did this "factory" ever ship?), and our own cross-customer delivery history. It only triggers on risk signals (no history, price far below market, new account, large deposit ask), so cost scales with risk. The voice call shows the cheap version: ask the right question, backed by history.

**7. Business model?**
*[Team: confirm before stage.]* SaaS per buyer team plus a fee on spend placed through verified POs, tied to the ROI the buyer already measures: deposits protected and on-time fill.

**8. Competition?**
Coupa and SAP Ariba are systems of record, not agents that chase suppliers. Pactum, Fairmarkit, and Keelvar focus on enterprise tail spend and RFQ events. AI procurement agents like Didero are the closest. Our wedge: messy, multilingual, cross-border supplier conversations, plus **verification** (agents lie) and **deadline-aware freight and re-planning**, with deterministic money logic underneath.

Quick one-liners:
- *"Is the voice call scripted?"* The persona has a secret (real capacity is 500) and only admits it if asked the right question. Ask it something else and it'll push for the 50% deposit.
- *"What if the parse is wrong?"* Every parse has a deterministic fallback, and ambiguous units get confirmed with the supplier (Shenzhen dozens). Money math never reads free text.
- *"Why did profit drop after my edit?"* Demand was 1,200. Arribo bought what the buyer asked and showed the cost: 300 zombies.

---

## 6. Pre-demo checklist (T-30 min)

- [ ] `.env`: `OPENAI_API_KEY`, `RELAYCAST_API_KEY`. Full rehearsal on venue Wi-Fi **and** phone hotspot.
- [ ] Terminal 0: `cd actor && npx terse actor dev` (:7100 up). `app/generated/` exists (`terse actor generate` was run once).
- [ ] Terminal 1: `bun web/server.ts`.
- [ ] Terminal 2 (repo root): `TERSE=1 MS_PER_DAY=15000 bun --env-file=.env app/main.ts`. Look for `[durable] Terse actor Run backing store` and `[relay] connected: 14 agents`.
- [ ] **Reset** clicked, so the actor and journal are clean (otherwise it auto-resumes an old run).
- [ ] UI: qty 1250, ceiling 18, Source = **Live**.
- [ ] **Chrome** on `http://localhost:3000` (not an IP address; WebRTC mic needs a secure context). Mic permission set to Allow. Test one call to Ningbo and hang up, then Reset.
- [ ] Sound: laptop volume high, judges can hear it, A's voice reaches the mic. Hang-up button within reach.
- [ ] Second tab: `localhost:3000/?mode=replay`, tested once.
- [ ] Terminal 2 visible (split) at 18pt or larger. Browser zoom ~125%. `↑` recalls the exact start command.
- [ ] One timed full run: POs by ~1:00, Oct 29 by ~1:40, settlement by ~2:35. Adjust A's pacing, not the code.
- [ ] Judge prompt ready: "quantity 1,500, Enter," then "ceiling 25, Enter." Decide who types (B is safer).
- [ ] Business-model line confirmed. Phone screen recording ready. Notifications off, charger in.
