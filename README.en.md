<h1 align="center">🐟 LiHui (鲤慧)</h1>

<p align="center"><b>15-minute living circle — diagnosed and planned by AI.</b></p>
<p align="center">In one sentence: "What's missing around my home, where's the most convenient place, and what's the easiest way to get there."<br>Real road-network routing · Real shops · Real walking distances — no faking it.</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> · 🇺🇸 English
</p>

<p align="center">
  <a href="https://gitee.com/deng-he-ziyan/lihui/releases"><img alt="Latest Release" src="https://img.shields.io/badge/Latest%20Release-v1.0.0-C71D23"></a>
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Mini%20Program%20%C2%B7%20Web%20%C2%B7%20Cloud-2f75f0">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-Zero%20Dependencies-00B96B">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-8%20Servers%20Plug%20%26%20Play-FF8A00">
  <img alt="Map Data" src="https://img.shields.io/badge/Map%20Data-Baidu%20Map%20Open%20Platform-2f75f0">
  <a href="https://gitee.com/deng-he-ziyan/lihui"><img alt="Gitee" src="https://img.shields.io/badge/Gitee-Primary%20Repo-C71D23"></a>
</p>

<p align="center">
  <a href="#1-why-lihui">1. Why LiHui</a> ·
  <a href="#2-features">2. Features</a> ·
  <a href="#3-architecture-highlights">3. Architecture</a> ·
  <a href="#4-quick-start">4. Quick Start</a> ·
  <a href="#5-faq">5. FAQ</a> ·
  <a href="#6-docs">6. Docs</a> ·
  <a href="#7-contributing">7. Contributing</a> ·
  <a href="#8-ecosystem--tech-stack">8. Ecosystem</a> ·
  <a href="#9-about-the-competition--team">9. About</a>
</p>

<p align="center">
  <img src="docs/readme/hero-zh.gif" width="960" alt="LiHui web tour: locate → living-circle checkup → walking isochrones (15/30/60 min, real map) → nearby real shops (walking distance) → AI assistant chat">
</p>
<p align="center"><sub>↑ Web tour: checkup score → real-map isochrone switching → shop walking distance → assistant conversation (same backend powers the Mini Program)</sub></p>

## ✨ Core Features

- 🗺 **Real road-network routing**: isochrones converge along the real walking road network in 36 directions via binary search — no straight-line circles.
- 🏪 **Real shop data**: Baidu POI retrieved live; walking distance + duration measured, not offline simulation.
- 🤖 **AI assistant**: RRF three-channel retrieval + LLMWiki term graph; standard texts injected with numbered citations.
- 🧪 **E2E security + browser sandbox**: 459 attack cases all green; CSP sandbox headers effective on three response paths.
- 🔑 **AK pool self-healing**: Baidu Map multi-key rotation; auto cooldown switch on quota exhaustion/disable — zero manual intervention when a key dies.
- ⚡ **Faster checkups**: report-level cache + concurrent dedup + local engine priority; hot start 5.6ms / cold start 1.34s.
- 📦 **Zero third-party dependencies**: pure Node.js standard-library server, localized Leaflet frontend, deploy-on-push to Gitee.

## 1. Why LiHui?

"Is there a clinic near my home?" "How many shops can I reach in 15 minutes?" "What amenities is an elderly person living alone missing?" — Most tools answer with a straight-line radius circle and offline simulated data. Looks plausible, but you can't actually walk there.

**LiHui treats every distance as real.** Checkups use real road-network routing; isochrones converge along the real walking network in 36 directions; shop distances are measured walking minutes; shops are real Baidu Map stores — every conclusion is reproducible and benchmarkable against international standards.

| | Common "living circle" tools | LiHui |
| --- | --- | --- |
| **Reachable range** | Straight-line radius (as the crow flies) | routematrix batch matrix routing, 36 directions along real road network |
| **Shop distance** | Straight-line or hardcoded fake data | Walk 222m · ~3 min — real walking distance + duration |
| **Shops** | Offline simulated data | Baidu POI builds 102 real stores live (rating/category tags passed through) |
| **Speed** | Full recompute each time | Report-level cache + concurrent dedup: hot 5.6ms, cold 1.34s |
| **Professional basis** | Self-invented metrics | GB 50180 / ISO 37120 / SDG 11, RAG with source citations |

Great for community-planning research, real-estate site evaluation, aging-friendly renovation assessment, and competition demos — any scenario that needs to answer "can I really walk there within 15 minutes."

## 2. Features

### 🩺 Living-circle checkup

Six facility categories — medical, education, commercial, transit, leisure, elderly care — are weighted into a score. Each category reports its **nearest facility, walking-reachable count, and pass threshold**; shortfalls are listed one by one, ending in a 0–100 total score with a radar chart.

<p align="center"><img src="docs/readme/frames/f02-life.png" width="860" alt="Living-circle checkup: six-category weighted score with shortfall hints"></p>

### ⏱ Walking isochrones · service blind spots

Centered on home, 36 directions converge along the real road network via binary search to find "how far you can walk in N minutes"; a Catmull-Rom spline connects them into a smooth isochrone. Inside the isochrone, an N×N grid evaluates six-category coverage per cell; a weighted score <40 marks a **service blind spot** (red cell), and candidate blind cells get a second real measurement. **Toggle "real map / schematic"** anytime; 15/30/45/60-minute tiers compute on demand.

<p align="center">
  <img src="docs/readme/isochrone-zh.gif" width="860" alt="Isochrone: 15→30→60 min switching, real-map overlay of isochrones and blind cells, schematic toggle">
</p>

<details>
<summary>How the isochrone is computed (algorithm)</summary>

- Sector sampling: 36 directions (every 10°); each direction **binary-searches** the max walking-reachable distance within the time cap;
- Batch matrix: each round packs the 36 midpoints into one `1×36 routematrix` call — a single checkup burns only 3 routing quotas, not 36×3 single-point requests;
- Degradation chain: batch matrix → concurrent single-point routing (token-bucket limiter) → ideal circle (explicitly flagged "degraded", never impersonating real routing);
- Blind-spot recheck: candidate blind cells get one more batch matrix measuring "home → cell center"; optimistically-interpolated cells are dropped;
- Coordinate discipline: GCJ-02 throughout, consistent with Mini Program `wx.getLocation` and tile basemaps.

</details>

### 🐟 AI assistant (web + Mini Program)

"Which convenience store nearby is still open?" "Help me read my checkup." "What international standards benchmark a 15-minute living circle?" — just ask in plain language. Distances, shop names, and ratings in the answer all come from real tool calls; when asked about standards/specs/metrics, it auto-retrieves the **standards knowledge base**, injects the source text into context, and must cite numbered sources.

<p align="center">
  <img src="docs/readme/assistant-zh.gif" width="860" alt="AI assistant: greeting → question → typing animation → sourced answer">
</p>

<details>
<summary>Why answers are accurate: RRF three-channel retrieval + LLMWiki term graph + international standards knowledge base (RAG)</summary>

- General **RRF (Reciprocal Rank Fusion, k=60)** fuses three retrieval rankings: BM25 literal channel × tag/title channel × category-prior channel — each channel's literal/semantic blind spots complement the others (Cormack et al. 2009);
- **LLMWiki term graph expansion**: 14 standards cross-link as wiki pages via `related`, forming a graph; on a hit it auto-expands one hop of "see also" related-standard TL;DRs — ask ISO 37120 and it auto-brings SDG 11 / ISO 37122 context, single retrieval reasons across standards; adding a term is zero-code (just add a JSON entry to the knowledge base);
- Knowledge base covers **14 standards, 31 authoritative excerpts**: GB 50180-2018, TD/T 1062-2021, Shanghai 15-min community living-circle guidelines, Ministry of Commerce 15-min convenience living-circle guide, complete-community construction guide, ISO 37120/37101/37122/37170, UN SDG 11, 15-Minute City (Moreno), WHO, LEED-ND, BREEAM;
- Injected prompt forces "**standard numbers may only come from the injected source text — no memory-based fabrication**" — LLMs hallucinate ISO/GB numbers easily and must be fed the source;
- Small talk triggers no retrieval, zero token waste; debug endpoint `GET /api/v1/agent/standards?q=` shows fusion hits and graph expansion directly.

</details>

### 🛒 Nearby real shops

"Within 3km" pulls real stores live by location; "city hot" does city-level search; each store shows **real walking distance + duration** (batch-matrix measured, not straight-line), with rating and category tags; ordering jumps to Meituan/Ctrip Mini Program by real store name.

<p align="center">
  <img src="docs/readme/shop-zh.gif" width="860" alt="Shop: nearby 3km vs city-hot toggle, walking distance and reference price">
</p>

### 📱 Mini Program: map home · voice · vision

The WeChat Mini Program shares the backend: Baidu basemap home, voice dialog + playback (ASR + TTS), photo understanding (multimodal), order history, light/dark theme. Total package 223.7 KB, scan-to-try on the test version.

<p align="center">
  <img src="docs/screenshots/30-real-device-isochrone.jpg" width="420" alt="Real device: walking-isochrone blind-spot page">&nbsp;&nbsp;
  <img src="docs/screenshots/27-real-device-vision-tts.jpg" width="420" alt="Real device: multimodal vision + voice playback">
</p>
<p align="center"><sub>↑ Real-device captures (not emulator): isochrone blind-spot page / vision + voice-playback buttons</sub></p>

### 🧠 Memory · secure-ops memory

Human-machine collaboration: honeypot trapping, IP ban, AI analysis (real keys desensitized before egress), **AI suggests only, humans approve**; artifacts are merged by humans, learning memory accumulates ops experience.

<p align="center"><img src="docs/readme/frames/f12-memory.png" width="860" alt="Memory secure-ops panel: live security events and AI suggestions"></p>

## 3. Architecture Highlights

| | |
| --- | --- |
| 🧩 **Multi-agent orchestration** | Orchestrator + parallel expert agents + strongly-typed contracts + trust-based dispatch; rules call MCP tools directly (no function-calling tool-name guessing); MCP self-extends — when unsure, it auto-searches and installs a new MCP Server from ModelScope (8s cap, 3-process install limit). |
| ⚡ **Three performance gates** | Report-level cache (quantized center, 10-min TTL) → concurrent dedup (multi-client share one computation) → local engine first (shares POI cache with isochrones). Checkup hot 5.6ms, cold 1.34s. |
| 🔐 **Zero key to client** | Honeypot fake keys trap attackers, egress desensitization, server-side proxy, AK never reaches frontend; scrapers get dead keys, and any API hit is instantly logged and banned. |
| 🧪 **E2E security + browser sandbox** | 459 automated attack cases (SQLi/XSS/traversal/CRLF/overflow/honeypot…) all green on first run; CSP sandbox headers effective on three response paths — external scripts, iframe nesting, and tracking pixels are rejected by the browser. |
| 🔑 **AK pool self-healing** | Baidu Map AK supports multi-key rotation: auto cooldown switch on quota exhaustion/disable, auto return at quota reset (00:00) — a dead key needs no manual intervention. |
| 📦 **Zero third-party dependencies** | Pure Node standard-library server (`node src/app.js` to start, no npm install); localized Leaflet frontend, no CDN runtime dependency; Gitee push → cloud hosting auto-builds and deploys. |
| 🗺 **Coordinate discipline** | Site-wide GCJ-02 (location / search / routing / tiles consistent); the 500–900m offset trap from mixing systems is documented in code comments. |

## 4. 🚀 Quick Start

**Web version (fastest)**

```bash
cd 03-lh-server
node src/app.js        # zero dependencies, no npm install
# open http://localhost:8809
```

**WeChat Mini Program (test version)**

| Entry | Notes |
| :---: | --- |
| <img src="docs/release/v1.0.0-mp-preview-qr.png" width="140"> | Scan with WeChat to open the test version (223.7 KB total; map home / shop / voice / vision all functional) |

**API self-doc**: visit `/server-info` for all endpoints; server logs are in `data/logs`.

**Security self-check** (with the server running, in another terminal):

```bash
cd 03-lh-server
node tests/security-e2e.mjs   # 459 attack cases, five iron-law assertions, ~250ms
```

## 5. ❓ FAQ

<details>
<summary><b>Are the isochrone / checkup data real?</b></summary>

Yes. Reachable range is measured by Baidu routematrix batch matrix routing (real walking road network); shops are built live from Baidu place search; distances are real walking distances. Degraded scenarios (routing quota blown) are explicitly flagged `degraded` in the response — never impersonating real routing.
</details>

<details>
<summary><b>Does Baidu quota exhaustion blank the screen?</b></summary>

No. place search has an on-disk cache and a "quota-exceeded disables empty-result overwrite of old cache" guard — when quota dies it keeps serving earlier-synced real directories with a clear notice; matrix routing and place search have independent quota pools. The isochrone basemap uses AMap tiles (key-free), costing no Baidu quota.
</details>

<details>
<summary><b>Are shop prices real?</b></summary>

Prices marked "reference" are estimates (Baidu place gives no transaction price); ordering and payment complete in Meituan/Ctrip Mini Programs by real store name. LiHui handles selection and order history, never touches funds.
</details>

<details>
<summary><b>Does the assistant fabricate standard numbers?</b></summary>

Standard questions first retrieve the local standards knowledge base (RRF three-channel fusion), inject the source text into the model context, and force cited sources; content the knowledge base doesn't hit, the model will plainly say it can't find. Verify via `GET /api/v1/agent/standards?q=`.
</details>

<details>
<summary><b>What does voice need?</b></summary>

Playback uses the built-in free Microsoft Edge synthesis engine, zero key required; with Baidu voice keys configured it auto-switches to Baidu timbre. Speech recognition goes through the server-side ASR proxy; keys are likewise never sent to the client.
</details>

## 6. 📚 Docs

| Doc | Content |
| --- | --- |
| [Changelog](CHANGELOG.md) | Full dated evolution (with every pitfall and fix) |
| [Real-device gallery](docs/screenshots/) | Web分段 screenshots and real-device captures, #21–31 |
| [Release v1.0.0](https://gitee.com/deng-he-ziyan/lihui/releases) | Mini Program test-version QR + 29 release images |

## 7. 🤝 Contributing

- ⭐ **If LiHui helped you**: a Star would mean a lot — [Gitee](https://gitee.com/deng-he-ziyan/lihui) · [GitHub](https://github.com/DENGHEZI/lihui); and file suggestions or bugs in [Issue](https://gitee.com/deng-he-ziyan/lihui/issues) (please include OS/browser version, repro steps, and screenshots).
- Dual-repo sync: [Gitee (primary)](https://gitee.com/deng-he-ziyan/lihui) · [GitHub](https://github.com/DENGHEZI/lihui); pushing Gitee auto-triggers WeChat cloud-hosting build & deploy.

## 8. 🌐 Ecosystem & Tech Stack

LiHui is built on the following open capabilities and in-house modules:

| Layer | Tech / capability |
| --- | --- |
| 🗺 Map data | Baidu Map Open Platform (routematrix batch routing, place POI search, AK pool self-healing); AMap tile basemap (key-free, no quota cost) |
| 🤖 AI orchestration | Orchestrator + parallel expert agents + strongly-typed contracts + trust-based dispatch; 8 MCP Servers plug & play (auto-searches and installs new Servers when unsure) |
| 🧠 Knowledge retrieval | RRF three-channel fusion (BM25 × tag × category prior) + LLMWiki 14-standard term graph; zero-dependency local vectors |
| 🖥 Server | Pure Node.js standard library (`node src/app.js` to start, no npm install); report cache + concurrent dedup |
| 🌐 Frontend | Localized Leaflet (no CDN runtime dependency); web + WeChat Mini Program, same backend |
| 🔒 Security | Honeypot trapping + IP ban + egress desensitization + CSP browser sandbox + 459 E2E attack cases |

Sibling product lines: WenTu AI Transcoding · Death & Life FPS · LiHui Research Agent (LiyuAgent).

## 9. 🏆 About the Competition & Team

- **Entry**: 2026 Shanghai Open-Source Innovation Contest · Baidu Map track "15-Minute Living Circle".
- **By**: Hunan Dengfeng Technology Co., Ltd.
- **Philosophy**: make every "can I walk there in 15 minutes" a real distance — real road network, real shops, real walking duration.
- **License**: open-sourced for the contest; see the repo license file.

---

<p align="center"><sub>2026 Shanghai Open-Source Innovation Contest · Baidu Map track "15-Minute Living Circle" entry 🐟</sub></p>
