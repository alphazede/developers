import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryBootstrap } from "../repository/bootstrap.js";
import { RepositoryChoiceService, type RepositoryChoiceResult, type RepositoryOptions } from "../repository/choice.js";
import type { ProcessRunner } from "../adapters/adapters.js";
import { BearingStore } from "../store/bearing-store.js";
import { AdapterVerification, ReadinessService, REASONING_LEVELS, type RouteInspectionPort, type VerificationPort } from "../onboarding/readiness.js";
import type { ResolvedRun, RunOverrides, Selection } from "../profile/profile.js";
import { CommandGateway } from "./command-gateway.js";
import { SseProjection } from "./sse.js";
import { MAX_SHOWCASE_JSON, MAX_SHOWCASE_REPORT, listWorkflowShowcases, projectWorkflowShowcase, renderWorkflowReport } from "../workflows/showcase.js";
import { JourneyService, type JourneyStage } from "../journey/planning-journey.js";

// ponytail: 32-byte (256-bit) tokens give 2^256 entropy; hex is URL-fragment-safe.
const CAPABILITY_BYTES = 32;
const SESSION_BYTES = 32;
const MAX_SESSION_BODY = 8 * 1024;
const MAX_REPOSITORY_BODY = 8 * 1024;
const MAX_READINESS_BODY = 4 * 1024;
const MAX_OWNER_BODY = 512;
const MAX_JOURNEY_BODY = 16 * 1024;
const MAX_JOURNEYS = 16;
const MAX_JOURNEY_ARTIFACT = 2 * 1024 * 1024;
const SIGNATURE_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-office.png", import.meta.url)));
const EXPEDITION_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-expedition.png", import.meta.url)));
const EXPLORER_CARD_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-explorer-card.png", import.meta.url)));
const EXPEDITION_CARD_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-expedition-card.png", import.meta.url)));

/** Cookie name for the local browser session. The value is the secret; the name is not. */
export const SESSION_COOKIE_NAME = "bearing_session";

export function greetingFor(name: string, now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5 || hour >= 22) return `Burning the midnight oil, ${name}? What's on your mind to build today?`;
  const salutation = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return now.getDay() === 0 || now.getDay() === 6
    ? `${salutation}, ${name}. Weekend warrior—what are we building today?`
    : `${salutation}, ${name}. What are we working on today?`;
}

function randomToken(byteLen: number): string {
  return randomBytes(byteLen).toString("hex");
}

/** Constant-time equality for equal-length strings. Caller must guard length. */
function equalConstTime(a: string, b: string): boolean {
  // ponytail: latin1 keeps ASCII hex single-byte; utf8 would be identical here.
  return timingSafeEqual(Buffer.from(a, "latin1"), Buffer.from(b, "latin1"));
}

/**
 * Owns the per-launch one-time capability and the browser session identity only.
 * It never holds provider credentials or workflow state. All decisions are
 * synchronous so the single-threaded event loop makes one-time exchange
 * race-free without locks.
 */
export class LocalSessionService {
  /** Per-launch capability. Goes in the URL fragment; never logged or echoed. */
  readonly capability: string;
  private readonly boundHost: string;
  private cookieValue: string | null = null;
  private sessionId: string | null = null;
  private consumed = false;

  constructor(boundHost: string) {
    this.boundHost = boundHost;
    this.capability = randomToken(CAPABILITY_BYTES);
  }

  /**
   * One-time exchange of the capability for a session cookie value. A wrong
   * capability does NOT consume the real capability (replay-safe on failure).
   */
  exchange(
    presented: string,
  ): { ok: true; cookieValue: string } | { ok: false } {
    if (this.consumed) return { ok: false };
    if (typeof presented !== "string") return { ok: false };
    if (presented.length !== this.capability.length) return { ok: false };
    if (!equalConstTime(presented, this.capability)) return { ok: false };
    this.consumed = true;
    this.cookieValue = randomToken(SESSION_BYTES);
    this.sessionId = randomToken(16);
    return { ok: true, cookieValue: this.cookieValue };
  }

  /** Host must equal the bound loopback host:port (DNS-rebinding guard). */
  validHost(host: string | undefined | null): boolean {
    return host === this.boundHost;
  }

  /**
   * Origin must be the loopback origin matching the bound host:port. Rejects
   * absent, cross-site, https, and path-bearing origins at this boundary.
   */
  validOrigin(origin: string | undefined | null): boolean {
    if (typeof origin !== "string" || origin.length === 0) return false;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    return (
      parsed.protocol === "http:" &&
      parsed.host === this.boundHost &&
      parsed.origin === origin
    );
  }

  /** Session cookie check, constant-time. Fails before any exchange happens. */
  authenticate(cookieValue: string | undefined | null): boolean {
    if (this.cookieValue === null) return false;
    if (typeof cookieValue !== "string") return false;
    if (cookieValue.length !== this.cookieValue.length) return false;
    return equalConstTime(cookieValue, this.cookieValue);
  }

  authenticateRequest(req: IncomingMessage): boolean {
    return this.authenticate(readCookie(req.headers.cookie, SESSION_COOKIE_NAME));
  }

  /** Non-secret durable command identity; the cookie itself is never exposed. */
  ownerSessionId(): string | null {
    return this.sessionId;
  }
}

const NATIVE_HTML =
  "<!doctype html>\n" +
  '<html lang="en">\n' +
  "<head>\n" +
  '<meta charset="utf-8">\n' +
  '<link rel="icon" href="data:,">\n' +
  "<title>Bearing</title>\n" +
  "<style>:root{color-scheme:dark;--canvas:#010102;--s1:#0f1011;--s2:#141516;--s3:#18191a;--line:#23252a;--line2:#34343a;--ink:#f7f8f8;--muted:#d0d6e0;--subtle:#8a8f98;--accent:#5e6ad2;--hover:#828fff;--success:#27a644}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:-.01em}button,input,select,textarea{font:inherit}button,input,select,textarea,a{min-height:40px}button{border:1px solid var(--line2);border-radius:8px;background:var(--s2);color:var(--ink);padding:.6rem .9rem;cursor:pointer}button:hover{background:var(--s3);border-color:#4a4c54}.primary{background:var(--accent);border-color:var(--accent);color:#fff}.primary:hover{background:var(--hover)}button:disabled{cursor:not-allowed;color:#62666d;background:var(--s1)}input,select,textarea{width:100%;border:1px solid var(--line2);border-radius:8px;background:var(--s1);color:var(--ink);padding:.65rem .75rem}textarea{min-height:88px;resize:vertical}a{color:#aeb6ff;display:inline-flex;align-items:center}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:3px}header{height:56px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 clamp(24px,4vw,72px);position:sticky;top:0;background:rgba(1,1,2,.96);z-index:2}.brand{display:flex;gap:10px;align-items:center;font-weight:650}.brand-mark{width:12px;height:12px;border:2px solid var(--accent);transform:rotate(45deg)}.nav-state{display:flex;gap:8px}.badge{border:1px solid var(--line);border-radius:999px;background:var(--s1);color:var(--subtle);padding:3px 9px;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}main{max-width:1180px;margin:0;padding:42px clamp(24px,4vw,72px) 72px}.intro{display:grid;grid-template-columns:1fr auto;align-items:end;gap:24px;margin-bottom:24px}.eyebrow{margin:0 0 8px;color:var(--subtle);font-size:12px;letter-spacing:.1em;text-transform:uppercase}.intro h1{font-size:clamp(32px,5vw,54px);line-height:1.05;letter-spacing:-.045em;margin:0;font-weight:600}.status-wrap{min-width:min(100%,360px);border-left:1px solid var(--line2);padding-left:18px}.status-label{color:var(--subtle);font-size:11px;letter-spacing:.08em;text-transform:uppercase}.status{margin:4px 0 0;color:var(--muted)}.panel{background:var(--s1);border:1px solid var(--line);border-radius:12px;margin-top:16px;overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 20px;border-bottom:1px solid var(--line)}.panel-head h2{font-size:16px;margin:0}.step{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--subtle)}.panel-body{padding:20px}.repo-grid{display:grid;grid-template-columns:minmax(0,1fr) 190px 260px;gap:12px}.repo-card{text-align:left;background:var(--s2);border-left:3px solid var(--accent);padding:18px;min-height:112px}.repo-card strong,.repo-card span{display:block}.repo-card strong{font-size:17px;margin:4px 0}.repo-card span{color:var(--subtle);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.repo-card .source{color:var(--muted);font-family:inherit}.browse{min-width:190px}.signature{margin:0;border:1px solid var(--line2);border-radius:9px;overflow:hidden;background:var(--s2);min-height:112px}.signature img{width:100%;height:84px;object-fit:cover;object-position:center 43%;display:block;filter:saturate(.72) contrast(1.04)}.signature figcaption{padding:6px 10px;background:var(--s2);font-size:11px;color:var(--muted)}.platform{display:flex;gap:8px;flex-wrap:wrap;color:var(--subtle);font-size:12px;margin:0 0 14px}.form-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.form-grid .wide{grid-column:1/-1}label,dt{display:block;font-weight:600;margin:0 0 6px;color:var(--muted)}.actions{display:flex;gap:10px;align-items:center;margin-top:16px}.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border-top:1px solid var(--line)}.metric-grid p{background:var(--s2);margin:0;padding:14px 18px}.panel h3,.panel h4{letter-spacing:-.02em}.workflow-grid{display:grid;grid-template-columns:minmax(220px,.7fr) minmax(0,1.3fr);gap:20px}.workflow-grid article{border-left:1px solid var(--line);padding-left:20px}dl{display:grid;grid-template-columns:130px 1fr;gap:8px;margin:16px 0}dd{margin:0;color:var(--muted)}li{margin:.4rem 0;color:var(--muted)}[hidden]{display:none!important}@media(max-width:960px){.repo-grid{grid-template-columns:minmax(0,1fr) 190px}.signature{grid-column:1/-1}.signature img{height:160px}}@media(max-width:760px){header{padding:0 16px}.nav-state .badge:first-child{display:none}main{padding:28px 16px 56px}.intro,.repo-grid,.workflow-grid{grid-template-columns:1fr}.status-wrap{border-left:0;border-top:1px solid var(--line);padding:14px 0 0}.form-grid,.metric-grid{grid-template-columns:1fr}.workflow-grid article{border-left:0;border-top:1px solid var(--line);padding:16px 0 0}.signature{grid-column:auto}.browse{min-width:0}.panel-body{padding:16px}button,input,select,textarea,a{min-height:44px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}</style>\n" +
  '<style>body{position:relative;isolation:isolate;background:transparent}body::before,body::after{content:"";position:fixed;inset:0;pointer-events:none}body::before{z-index:-2;background:var(--canvas) url("/assets/bearing-expedition.png") center/cover no-repeat}body::after{z-index:-1;background:rgba(1,1,2,.48)}.intro,.panel{max-width:900px}#repository-panel{max-width:780px;background:var(--s1)}#repository-panel .panel-head{padding:11px 16px}#repository-panel .panel-body{padding:14px 16px}#repository-panel .platform{margin-bottom:10px}#repository-panel .repo-grid{grid-template-columns:minmax(0,1fr) 150px 180px;gap:10px}#repository-panel .repo-card{min-height:84px;padding:12px}#repository-panel .browse{min-width:150px}#repository-panel .signature-link{display:block;min-height:84px;color:inherit;text-decoration:none;border-radius:9px}#repository-panel .signature{min-height:84px}#repository-panel .signature img{height:58px}#repository-panel .signature figcaption{padding:5px 8px}.route-fieldset{border:0;margin:0;padding:0}.route-fieldset legend{font-weight:600;margin-bottom:8px}.route-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.route-card{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;margin:0;padding:12px;border:1px solid var(--line2);border-radius:9px;background:var(--s2);cursor:pointer;min-height:76px}.route-card:hover{border-color:#4a4c54}.route-card input{width:18px;min-height:18px;margin:3px 0 0;padding:0;accent-color:var(--accent)}.route-card strong,.route-card span{display:block}.route-card .route-status,.route-card .route-model{font-size:12px;color:var(--subtle)}.route-card.unavailable{cursor:not-allowed;opacity:.55}.route-details{display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,1fr);gap:14px;margin-top:14px}@supports ((-webkit-backdrop-filter:blur(8px)) or (backdrop-filter:blur(8px))){#repository-panel{background:rgba(15,16,17,.78);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}}@media(max-width:760px){body::before{background-position:65% center}body::after{background:rgba(1,1,2,.78)}#repository-panel{max-width:100%}#repository-panel .repo-grid,.route-options,.route-details{grid-template-columns:1fr}#repository-panel .browse{min-width:0}#repository-panel .signature-link{display:none}}</style>\n' +
  '<style>.repo-switch{min-height:32px;padding:3px 9px;border-radius:999px;background:var(--s1);color:var(--muted);font-size:12px}.demo-link{min-height:28px;padding:0;border:0;background:transparent;color:#aeb6ff;font-size:12px;text-decoration:underline;text-underline-offset:3px}.demo-link:hover{background:transparent;color:#fff}.panel-head-actions{display:flex;align-items:center;gap:10px}.compact-back{min-height:32px;padding:3px 8px;background:transparent;color:var(--muted);font-size:12px}.actions-end{justify-content:flex-end}.panel:not([hidden]){animation:panel-in .3s cubic-bezier(.2,.8,.2,1) both}.status.busy::before{content:"";display:inline-block;width:9px;height:9px;margin-right:9px;border:2px solid var(--accent);vertical-align:-1px;animation:compass-spin .8s linear infinite}.prompt-panel textarea{min-height:132px;font-size:16px}.prompt-panel .hint{margin:0;color:var(--subtle);font-size:12px}.prompt-panel .actions{justify-content:space-between}.demo-panel{max-width:1000px}.demo-progress{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:20px}.demo-progress span{border-top:2px solid var(--line2);padding-top:7px;color:var(--subtle);font-size:11px}.demo-progress span.active{border-color:var(--accent);color:var(--ink)}.demo-example{border-left:3px solid var(--accent);background:var(--s2);padding:14px 16px;color:var(--muted)}.demo-stage h3{font-size:22px;margin:0 0 8px}.demo-stage>p{color:var(--muted)}.demo-actions{display:flex;justify-content:space-between;gap:10px;margin-top:20px}.mode-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px}.mode-card{display:block;padding:0;overflow:hidden;text-align:left;background:var(--s2);border:2px solid var(--line2);border-radius:12px;min-height:420px}.mode-card:hover{border-color:var(--hover)}.mode-card.selected{border-color:var(--accent);box-shadow:0 0 0 2px rgba(94,106,210,.28)}.mode-card img{display:block;width:100%;height:190px;object-fit:cover}.mode-copy{display:block;padding:16px}.mode-copy strong,.mode-copy span{display:block}.mode-copy strong{font-size:23px;margin-bottom:3px}.mode-kicker{color:#c2c8ff;font-weight:600;margin-bottom:10px}.mode-line{color:var(--muted);margin-top:7px}.mode-line b{color:var(--ink)}@keyframes panel-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}@keyframes compass-spin{to{transform:rotate(360deg)}}@media(max-width:760px){.nav-state .badge{display:none}.repo-switch{max-width:145px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.prompt-panel .actions{align-items:stretch;flex-direction:column}.prompt-panel .actions .primary{align-self:flex-end}.demo-progress{grid-template-columns:1fr}.demo-progress span:not(.active){display:none}.mode-grid{grid-template-columns:1fr}.mode-card{min-height:0}.mode-card img{height:160px}}</style>\n' +
  '<style>.hero-help{margin:14px 0 0;color:var(--muted)}.hero-help .demo-link{margin-left:4px;font-size:14px}.demo-progress{grid-template-columns:repeat(4,1fr);list-style:none;padding:0}.demo-progress li{margin:0;border-top:2px solid var(--line2);padding-top:7px;color:var(--subtle);font-size:11px}.demo-progress li[aria-current="step"]{border-color:var(--accent);color:var(--ink)}.benefit-list{padding-left:20px}.benefit-list strong{color:var(--ink)}@media(max-width:760px){.demo-progress{grid-template-columns:1fr}.demo-progress li:not([aria-current="step"]){display:none}}</style>\n' +
  '<style>html{zoom:1.2}.token-banner{margin:0;padding:10px clamp(24px,4vw,72px);border-bottom:1px solid rgba(227,177,79,.5);background:rgba(74,52,15,.72);color:#fff1c7;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}.token-banner strong{color:#fff}.token-banner a{min-height:24px;color:#fff;text-decoration:underline;text-underline-offset:3px}.panel,#repository-panel{background:rgba(15,16,17,.35);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}.question-form{margin-top:16px}.question-form textarea{min-height:96px;background:rgba(15,16,17,.72)}.wait-panel{position:relative;overflow:hidden;border:1px solid var(--line2);border-radius:10px;background:rgba(15,16,17,.35);padding:16px;margin:16px 0}.wait-trail{height:4px;background:var(--line);overflow:hidden;border-radius:999px}.wait-trail::after{content:"";display:block;width:32%;height:100%;background:var(--accent);animation:wait-trail 1.2s ease-in-out infinite}.wait-meta{display:flex;justify-content:space-between;gap:12px;color:var(--subtle);font-size:12px}.artifact-checklist{padding-left:20px}.artifact-checklist a{min-height:28px}.cadence{border:0;padding:0;margin:18px 0}.cadence-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.cadence-options label{border:1px solid var(--line2);border-radius:9px;padding:12px;background:rgba(15,16,17,.35)}.cadence-options span{display:block;color:var(--subtle);font-weight:400;font-size:12px}.journey-actions{display:flex;justify-content:space-between;gap:10px;margin-top:18px}@keyframes wait-trail{from{transform:translateX(-110%)}to{transform:translateX(320%)}}@media(max-width:760px){.token-banner{padding:10px 16px}.cadence-options{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){.wait-trail::after{animation:none;width:100%}}</style>\n' +
  "</head>\n" +
  "<body>\n" +
  '<header><div class="brand"><span class="brand-mark" aria-hidden="true"></span>Bearing</div><nav class="nav-state" aria-label="Runtime status"><button class="repo-switch" id="change-repository" type="button" hidden>Change repository</button><span class="badge local-badge">LOCAL</span><span class="badge">OWNER CONTROLLED</span></nav></header>\n' +
  '<aside class="token-banner" role="note"><strong>Plan for substantial token use.</strong> Accurate Bearing designs can require significant context. If you use a subscription plan, consider a higher tier, choose reasoning deliberately, and use <a href="https://github.com/juliusbrussee/caveman" target="_blank" rel="noopener noreferrer">Caveman</a> to reduce planning context.</aside>\n' +
  "<main>\n" +
  '<div class="intro"><div><p class="eyebrow">Local agent control room</p><h1>Set bearings.</h1><p class="hero-help">New to Bearing?<button class="demo-link" id="view-demo" type="button">See how it works</button></p></div><div class="status-wrap"><span class="status-label">Current status</span><p class="status" id="status" role="status" aria-live="polite">Establishing local session\u2026</p></div></div>\n' +
  '<section class="panel" id="repository-panel" hidden aria-labelledby="repository-heading"><div class="panel-head"><h2 id="repository-heading">Repository</h2><span class="step">01 / SELECT</span></div><div class="panel-body"><p class="platform"><span id="platform-name" class="badge"></span><span id="distro-name" class="badge" hidden></span><span id="picker-state" class="badge"></span></p><div class="repo-grid"><button class="repo-card" id="current-repository" type="button" disabled><span class="source" id="repository-source">Detected current repository</span><strong id="repository-name">Loading\u2026</strong><span id="repository-path"></span></button><button class="browse" id="browse-repository" type="button" disabled>Browse for repository</button><a class="signature-link" href="https://github.com/alphazede/developers/tree/main/bearing" target="_blank" rel="noopener noreferrer" aria-label="Open Bearing GitHub repository"><figure class="signature"><img src="/assets/bearing-office.png" alt="A bear in sunglasses working at a tidy office desk."><figcaption>GitHub repo \u2197</figcaption></figure></a></div></div></section>\n' +
  '<form class="panel" id="route-form" hidden><div class="panel-head"><h2>Agent route</h2><span class="step">02 / LAUNCH</span></div><div class="panel-body"><fieldset class="route-fieldset"><legend>Choose one agent route</legend><p id="detected-routes">Checking CLI availability\u2026</p><div class="route-options" id="route-options"></div></fieldset><div class="route-details"><div><label for="owner-name">What should we call you?</label><input id="owner-name" type="text" required autocomplete="name" maxlength="80"></div><div><label for="reasoning">Reasoning</label><select id="reasoning" required><option value="" selected disabled>Choose reasoning</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></div></div><div class="actions actions-end"><button class="primary">Launch</button></div></div></form>\n' +
  '<form class="panel prompt-panel" id="work-form" hidden><div class="panel-head"><h2>What are we working on?</h2><div class="panel-head-actions"><button class="compact-back" id="work-back" type="button">\u2190 Back</button><span class="step">03 / ASK</span></div></div><div class="panel-body"><label for="work-goal">Describe the work</label><textarea id="work-goal" required maxlength="4096" placeholder="Build, fix, investigate, or prepare something..."></textarea><div class="actions"><span class="hint">Bearing plans first. You choose Explorer or Expedition after implementation.md is ready.</span><button class="primary">Embark</button></div></div></form>\n' +
  '<section class="panel" id="planning-panel" hidden aria-live="polite"><div class="panel-head"><h2>Journey</h2><span class="step" id="journey-phase">SET BEARINGS</span></div><div class="panel-body" id="journey-body" aria-busy="false"><div class="wait-panel" id="journey-wait" hidden><strong id="wait-phase">Set Bearings</strong><p id="wait-help">Your selected agent is working. Bearing will show only validated results.</p><div class="wait-trail" role="progressbar" aria-label="Agent work in progress"></div><div class="wait-meta"><span id="wait-status" role="status" aria-live="polite">Waiting for the agent\u2026</span><span id="wait-elapsed">0s elapsed</span></div><ul class="artifact-checklist" id="artifact-checklist"><li>No validated artifacts yet.</li></ul></div><div id="journey-content"><h3 id="journey-heading">Set Bearings</h3><p id="journey-summary">Bearing is preparing the bounded journey before gathering owner decisions.</p><div class="demo-example" id="journey-question-box"><strong>Agent question</strong><br><span id="planning-question">Preparing the first question\u2026</span></div><form class="question-form" id="planning-answer-form"><label for="planning-answer">Your answer</label><textarea id="planning-answer" required maxlength="4096" placeholder="Type your answer here\u2026"></textarea><div class="journey-actions"><button id="journey-back" type="button">\u2190 Back</button><button class="primary">Continue</button></div></form><div id="journey-action" hidden><div class="journey-actions"><button id="journey-action-back" type="button">\u2190 Back</button><button id="journey-next" class="primary" type="button">Map the Route</button></div></div><div id="mode-choice" hidden><h3>Choose the crew</h3><p>The plan is ready. Choose the execution shape and how often Surveyor reviews it.</p><div class="mode-grid"><button class="mode-card" id="journey-explorer" type="button" aria-pressed="false"><img src="/assets/bearing-explorer-card.png" alt="Two bears following one focused mountain route."><span class="mode-copy"><strong>Explorer</strong><span class="mode-kicker">Focused route \u00b7 fewer sessions</span><span class="mode-line"><b>Best for:</b> compact or mostly sequential plans.</span><span class="mode-line"><b>Tradeoff:</b> less parallelism.</span></span></button><button class="mode-card" id="journey-expedition" type="button" aria-pressed="false"><img src="/assets/bearing-expedition-card.png" alt="Five bears coordinating multiple mountain activities."><span class="mode-copy"><strong>Expedition</strong><span class="mode-kicker">Parallel ascent \u00b7 more sessions</span><span class="mode-line"><b>Best for:</b> independent lanes or multiple phases.</span><span class="mode-line"><b>Tradeoff:</b> higher token and coordination cost.</span></span></button></div><fieldset class="cadence"><legend>Review cadence</legend><div class="cadence-options"><label><input type="radio" name="review-cadence" value="slice">Each slice<span>Fast feedback; highest review cost.</span></label><label><input type="radio" name="review-cadence" value="phase" checked>Each phase <b>(recommended)</b><span>Balanced safety, cost, and recovery.</span></label><label><input type="radio" name="review-cadence" value="end">End only<span>Lowest review cost; issues surface later.</span></label></div></fieldset><div class="journey-actions"><button id="mode-back" type="button">\u2190 Back</button><button id="execute-journey" class="primary" type="button" disabled>Continue</button></div></div><div id="journey-complete" hidden><h3>Evidence complete</h3><p id="completion-summary"></p><ul class="artifact-checklist" id="completion-artifacts"></ul><div class="journey-actions"><button id="completion-back" type="button">\u2190 Back</button><button id="journey-retry" type="button" hidden>Retry</button><button id="new-journey" class="primary" type="button">Start another journey</button></div></div></div></div></section>\n' +
  '<section class="panel demo-panel" id="demo-panel" hidden aria-labelledby="demo-heading"><div class="panel-head"><div><h2 id="demo-heading">How Bearing works</h2><span class="step" id="demo-step" aria-live="polite">Step 1 of 4</span></div><div class="panel-head-actions"><span class="step">NO TOKENS</span><button class="compact-back" id="close-demo" type="button">Close</button></div></div><div class="panel-body"><ol class="demo-progress" aria-label="Tutorial progress"><li aria-current="step">Why Bearing</li><li>Your request</li><li>Choose the crew</li><li>Your evidence</li></ol><div class="demo-stage" data-demo-stage="0"><h3>Stay in control while agents do the work</h3><p>Bearing is a local control room that turns a complex request into an approved plan, bounded agent work, and evidence you can review.</p><ul class="benefit-list"><li><strong>You stay in charge:</strong> choose the repository, model, plan, execution mode, and consequential actions.</li><li><strong>Your work stays local:</strong> Bearing uses your selected repository and installed agent CLIs. No hosted account is required.</li><li><strong>You can step away:</strong> agents keep moving inside the approved boundaries and stop when they need your decision.</li></ul></div><div class="demo-stage" data-demo-stage="1" hidden><h3>Describe the outcome in your own words</h3><p>Choose the repository and tell Bearing what you want to accomplish. Before planning, it checks whether the source files are here and asks whether there are reference documents it should use.</p><div class="demo-example"><strong>Example request</strong><br>Add bulk customer onboarding with validation, duplicate handling, a dry-run preview, tests, and independent review.</div><p>Bearing asks only the questions needed to remove important ambiguity, then ends with: <strong>Anything else?</strong></p></div><div class="demo-stage" data-demo-stage="2" hidden><h3>Review the plan, then choose the crew</h3><p>Nothing executes until <code>implementation.md</code> is ready for your review. Then you choose the work style. More bears mean more parallel work, coordination, and token use.</p><div class="mode-grid"><button class="mode-card" id="demo-explorer" type="button" aria-pressed="false"><img src="/assets/bearing-explorer-card.png" alt="Two bears following one focused mountain route."><span class="mode-copy"><strong>Explorer</strong><span class="mode-kicker">Focused route \u00b7 fewer agent sessions</span><span class="mode-line"><b>Use when:</b> the plan is compact, mostly sequential, or has one clear workstream.</span><span class="mode-line"><b>Pros:</b> lower token use and simpler coordination.</span><span class="mode-line"><b>Tradeoff:</b> less parallelism on broad plans.</span></span></button><button class="mode-card" id="demo-expedition" type="button" aria-pressed="false"><img src="/assets/bearing-expedition-card.png" alt="Five bears coordinating multiple mountain activities."><span class="mode-copy"><strong>Expedition</strong><span class="mode-kicker">Parallel ascent \u00b7 more agent sessions</span><span class="mode-line"><b>Use when:</b> the plan has several independent lanes, specialties, or waves.</span><span class="mode-line"><b>Pros:</b> more parallel progress and dedicated coordination.</span><span class="mode-line"><b>Tradeoff:</b> higher token use and coordination overhead.</span></span></button></div><p id="demo-mode-status" role="status">Choose a card to continue the tutorial.</p></div><div class="demo-stage" data-demo-stage="3" hidden><h3>Come back to evidence, not just “done”</h3><p id="demo-selected-mode">Your selected execution mode appears here.</p><p>Agents execute only approved slices and stop at owner decisions. An independent Surveyor then checks the result against the plan, tests, and recorded evidence.</p><div class="demo-example"><strong>Your final view</strong><br>What changed \u00b7 what passed \u00b7 what deviated \u00b7 what is blocked \u00b7 what still needs your decision</div></div><div class="demo-actions"><button id="demo-prev" type="button" disabled>\u2190 Previous</button><button class="primary" id="demo-next" type="button">Next \u2192</button></div></div></section>\n' +
  "<noscript><p>Bearing requires JavaScript to establish a local session.</p></noscript>\n" +
  "</main>\n" +
  "<script>\n" +
  '(function () {\n' +
  '  "use strict";\n' +
  '  var status = document.getElementById("status");\n' +
  '  var repositoryPanel = document.getElementById("repository-panel");\n' +
  '  var currentRepository = document.getElementById("current-repository");\n' +
  '  var browseRepository = document.getElementById("browse-repository");\n' +
  '  var routeForm = document.getElementById("route-form");\n' +
  '  var detectedRoutes = document.getElementById("detected-routes");\n' +
  '  var routeOptions = document.getElementById("route-options");\n' +
  '  var workForm = document.getElementById("work-form");\n' +
  '  var planningPanel = document.getElementById("planning-panel");\n' +
  '  var planningAnswerForm = document.getElementById("planning-answer-form");\n' +
  '  var planningAnswer = document.getElementById("planning-answer");\n' +
  '  var demoPanel = document.getElementById("demo-panel");\n' +
  '  var viewDemo = document.getElementById("view-demo");\n' +
  '  var changeRepository = document.getElementById("change-repository");\n' +
  '  var workBack = document.getElementById("work-back");\n' +
  '  var currentRunId = "";\n' +
  '  var demoStage = 0;\n' +
  '  var demoMode = "";\n' +
  '  var demoReturnPanel = null;\n' +
  '  var browseAvailable = false;\n' +
  '  var selectedRoute = null;\n' +
  '  var rememberedName = "";\n' +
  '  var rememberedGreeting = "";\n' +
  '  var onboardingReady = false;\n' +
  '  var returnPanel = null;\n' +
  '  var currentGoal = ""; var currentStage = "set-bearings"; var journeyMode = ""; var elapsedTimer = null; var elapsedStarted = 0;\n' +
  '  function setStatus(message, busy) { status.textContent = message; status.classList.toggle("busy", !!busy); }\n' +
  '  function fail(msg) { setStatus("Session could not start: " + msg, false); }\n' +
  '  function requestError(label, r) { throw new Error(label + " (" + r.status + "). Refresh the run state and try again."); }\n' +
  '  function readRun(id) { return fetch("/api/v1/runs/" + encodeURIComponent(id), { credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("Run could not be read", r); return r.json(); }); }\n' +
  '  function postCommand(id, state, type, payload) { var commandId = crypto.randomUUID(); return fetch("/api/v1/runs/" + encodeURIComponent(id) + "/commands", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ schemaVersion: 1, commandId: commandId, runId: id, expectedRevision: state.revision, session: { sessionId: "browser", actor: "owner" }, correlationId: commandId, type: type, payload: payload }) }).then(function (r) { if (!r.ok) requestError("Command was rejected", r); return r.json(); }); }\n' +
  '  function persistAgentQuestion(question) { return readRun(currentRunId).then(function (state) { if (state.pendingDecision) { if (state.pendingDecision.question !== question) throw new Error("Another owner decision is already pending."); return state; } return postCommand(currentRunId, state, "requireDecision", { decisionId: "journey-" + currentStage + "-" + crypto.randomUUID(), question: question, consequential: true }).then(function () { return readRun(currentRunId); }); }); }\n' +
  '  var phaseNames = { "set-bearings": "Set Bearings", "gather-supplies": "Gather Supplies", "map-route": "Map the Route", "draft-implementation": "Draft implementation", "execute-explorer": "Explorer", "execute-expedition": "Expedition", "review": "Surveyor review" };\n' +
  '  function showWait(stage) { setStatus(phaseNames[stage] + " is working\u2026", true); document.getElementById("journey-content").hidden = true; document.getElementById("journey-wait").hidden = false; document.getElementById("journey-body").setAttribute("aria-busy", "true"); document.getElementById("wait-phase").textContent = phaseNames[stage]; document.getElementById("wait-status").textContent = "Waiting for the selected agent\u2026"; elapsedStarted = Date.now(); document.getElementById("wait-elapsed").textContent = "0s elapsed"; clearInterval(elapsedTimer); elapsedTimer = setInterval(function () { document.getElementById("wait-elapsed").textContent = Math.floor((Date.now() - elapsedStarted) / 1000) + "s elapsed"; }, 1000); }\n' +
  '  function hideWait() { clearInterval(elapsedTimer); elapsedTimer = null; document.getElementById("journey-wait").hidden = true; document.getElementById("journey-content").hidden = false; document.getElementById("journey-body").setAttribute("aria-busy", "false"); }\n' +
  '  function renderArtifacts(body) { var list = document.getElementById("artifact-checklist"); list.replaceChildren(); var paths = body.artifacts || []; if (!paths.length) { var empty = document.createElement("li"); empty.textContent = "No validated artifacts yet."; list.appendChild(empty); return; } paths.forEach(function (path) { var item = document.createElement("li"); item.textContent = path; var link = (body.artifactLinks || []).find(function (entry) { return entry.path === path; }); if (link) { item.textContent = ""; var anchor = document.createElement("a"); anchor.href = link.url; anchor.target = "_blank"; anchor.rel = "noopener"; anchor.textContent = path; item.appendChild(anchor); } list.appendChild(item); }); }\n' +
  '  function renderFailure(body) { hideWait(); planningAnswerForm.hidden = true; document.getElementById("journey-action").hidden = true; document.getElementById("mode-choice").hidden = true; document.getElementById("journey-complete").hidden = false; document.getElementById("completion-summary").textContent = body.code === "token_budget" ? "This run reached its token budget before the phase completed. Retry with a higher CLI --budget or a lower reasoning profile." : "The agent could not complete " + phaseNames[currentStage] + ": " + (body.code || "request_failed") + ". No success was recorded."; document.getElementById("completion-artifacts").replaceChildren(); document.getElementById("journey-retry").hidden = false; document.getElementById("new-journey").hidden = true; setStatus("Journey blocked. Retry is available.", false); }\n' +
  '  function renderJourney(body) { hideWait(); renderArtifacts(body); document.getElementById("journey-phase").textContent = phaseNames[currentStage].toUpperCase(); document.getElementById("journey-heading").textContent = phaseNames[currentStage]; document.getElementById("journey-summary").textContent = body.status === "action" ? body.summary : "The selected agent needs an owner answer before it can continue."; document.getElementById("journey-complete").hidden = true; document.getElementById("mode-choice").hidden = true; document.getElementById("journey-action").hidden = true; if (body.status === "failure") { renderFailure(body); return; } if (body.status === "question") { document.getElementById("journey-question-box").hidden = false; document.getElementById("planning-question").textContent = body.question; planningAnswerForm.hidden = false; planningAnswer.value = ""; planningAnswer.focus(); setStatus(phaseNames[currentStage] + " needs your answer.", false); return; } document.getElementById("journey-question-box").hidden = true; planningAnswerForm.hidden = true; if (currentStage === "map-route") { invokeJourney("draft-implementation"); return; } if (currentStage === "draft-implementation") { document.getElementById("mode-choice").hidden = false; setStatus("implementation.md is ready. Choose the crew and review cadence.", false); return; } if (currentStage === "execute-explorer" || currentStage === "execute-expedition") { invokeJourney("review"); return; } if (currentStage === "review") { document.getElementById("journey-complete").hidden = false; document.getElementById("completion-summary").textContent = body.summary; var target = document.getElementById("completion-artifacts"); target.replaceChildren(); (body.artifacts || []).forEach(function (path) { var item = document.createElement("li"); var link = (body.artifactLinks || []).find(function (entry) { return entry.path === path; }); if (link) { var anchor = document.createElement("a"); anchor.href = link.url; anchor.target = "_blank"; anchor.rel = "noopener"; anchor.textContent = path; item.appendChild(anchor); } else item.textContent = path; target.appendChild(item); }); document.getElementById("journey-retry").hidden = true; document.getElementById("new-journey").hidden = false; setStatus("Journey complete. Review the validated evidence.", false); return; } var next = document.getElementById("journey-next"); next.textContent = currentStage === "set-bearings" ? "Gather Supplies" : "Map the Route"; document.getElementById("journey-action").hidden = false; setStatus(phaseNames[currentStage] + " complete. Owner handoff required.", false); }\n' +
  '  function invokeJourney(stage, extra) { currentStage = stage; showWait(stage); var payload = Object.assign({ runId: currentRunId, stage: stage, workGoal: currentGoal }, extra || {}); fetch("/api/v1/journey", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(payload) }).then(function (r) { return r.json().catch(function () { return { status: "failure", code: "request_failed" }; }).then(function (body) { if (!r.ok && body.status !== "failure") return { status: "failure", code: "request_failed" }; return body; }); }).then(function (body) { return body.status === "question" ? persistAgentQuestion(body.question).then(function () { return body; }) : body; }).then(renderJourney, function () { renderFailure({ code: "network_error" }); }); }\n' +
  '  function showError(error) { setStatus(error instanceof Error ? error.message : "Request failed.", false); }\n' +
  '  function showDemoStage(next) { var stages = document.querySelectorAll("[data-demo-stage]"); var progress = document.querySelectorAll(".demo-progress li"); demoStage = Math.max(0, Math.min(stages.length - 1, next)); stages.forEach(function (stage, index) { stage.hidden = index !== demoStage; }); progress.forEach(function (step, index) { if (index === demoStage) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current"); }); document.getElementById("demo-step").textContent = "Step " + (demoStage + 1) + " of " + stages.length; document.getElementById("demo-prev").disabled = demoStage === 0; document.getElementById("demo-next").textContent = demoStage === stages.length - 1 ? (currentRunId ? "Back to journey" : "Start journey") : "Next \\u2192"; }\n' +
  '  function chooseDemoMode(mode) { demoMode = mode; ["explorer", "expedition"].forEach(function (name) { var card = document.getElementById("demo-" + name); var selected = name === mode; card.classList.toggle("selected", selected); card.setAttribute("aria-pressed", String(selected)); }); if (!mode) { document.getElementById("demo-mode-status").textContent = "Choose a card to continue the tutorial."; document.getElementById("demo-selected-mode").textContent = "Your selected execution mode appears here."; return; } document.getElementById("demo-mode-status").textContent = (mode === "explorer" ? "Explorer selected: focused execution with fewer agent sessions." : "Expedition selected: parallel execution with more coordination.") + " Tutorial only; nothing was launched."; document.getElementById("demo-selected-mode").textContent = "Tutorial selection: " + (mode === "explorer" ? "Explorer" : "Expedition") + ". In a real run, Bearing records owner approval before execution."; }\n' +
  '  function openDemo() { demoReturnPanel = !planningPanel.hidden ? planningPanel : !workForm.hidden ? workForm : !routeForm.hidden ? routeForm : repositoryPanel; [repositoryPanel, routeForm, workForm, planningPanel].forEach(function (panel) { panel.hidden = true; }); demoPanel.hidden = false; viewDemo.textContent = "Exit tutorial"; chooseDemoMode(""); showDemoStage(0); setStatus("How it works. No model calls or tokens.", false); }\n' +
  '  function closeDemoPanel() { demoPanel.hidden = true; viewDemo.textContent = "See how it works"; if (demoReturnPanel) demoReturnPanel.hidden = false; setStatus(rememberedGreeting || (demoReturnPanel === repositoryPanel ? "Choose a repository." : "Tutorial closed."), false); }\n' +
  '  function renderRoutes(routes) { var names = { "codex": "Codex — configured model", "grok-safe": "Grok Build", "pi-zai-glm-5.2": "GLM 5.2", "pi-deepseek-deepseek-v4-pro": "DeepSeek V4 Pro" }; var firstAvailable = null; selectedRoute = null; routeOptions.replaceChildren(); routes.forEach(function (route, index) { var label = document.createElement("label"); label.className = "route-card" + (route.detected ? "" : " unavailable"); var input = document.createElement("input"); input.type = "radio"; input.name = "route"; input.id = "route-option-" + index; input.required = true; input.disabled = !route.detected; input.addEventListener("change", function () { selectedRoute = route; }); var copy = document.createElement("span"); var title = document.createElement("strong"); title.textContent = names[route.id] || route.id; var statusText = document.createElement("span"); statusText.className = "route-status"; statusText.id = input.id + "-status"; statusText.textContent = route.detected ? "CLI detected" : "CLI unavailable"; input.setAttribute("aria-describedby", statusText.id); var modelText = document.createElement("span"); modelText.className = "route-model"; modelText.textContent = route.model === "*" ? "Uses your configured Codex model (*)" : route.provider + " / " + route.model; copy.append(title, statusText, modelText); label.append(input, copy); routeOptions.appendChild(label); if (!firstAvailable && route.detected) firstAvailable = input; }); var detected = routes.filter(function (route) { return route.detected; }).length; detectedRoutes.textContent = "CLI detection only; Launch verifies the selected route. " + detected + " of " + routes.length + " CLIs detected."; if (firstAvailable) firstAvailable.focus(); }\n' +
  '  function revealWork(greeting) { onboardingReady = true; repositoryPanel.hidden = true; routeForm.hidden = true; planningPanel.hidden = true; workForm.hidden = false; changeRepository.hidden = false; changeRepository.textContent = "Change repository"; setStatus(greeting, false); document.getElementById("work-goal").focus(); }\n' +
  '  function finishReady(name, forcePersist) { if (!forcePersist && rememberedName === name && rememberedGreeting) { revealWork(rememberedGreeting); return; } setStatus("Saving your bearings...", true); fetch("/api/v1/owner", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ name: name }) }).then(function (r) { if (!r.ok) throw new Error("owner"); return r.json(); }).then(function (body) { rememberedName = body.name; rememberedGreeting = body.greeting; revealWork(body.greeting); }, function () { setStatus("Your name could not be remembered. Try again.", false); }); }\n' +
  '  function toggleRepositoryChooser() { if (!demoPanel.hidden) closeDemoPanel(); if (!repositoryPanel.hidden) { repositoryPanel.hidden = true; changeRepository.textContent = "Change repository"; if (returnPanel) returnPanel.hidden = false; setStatus(rememberedGreeting || "Repository unchanged.", false); return; } returnPanel = !planningPanel.hidden ? planningPanel : workForm.hidden ? routeForm : workForm; routeForm.hidden = true; workForm.hidden = true; planningPanel.hidden = true; repositoryPanel.hidden = false; changeRepository.textContent = "Keep current"; setStatus("Choose another repository.", false); loadRepositoryOptions(); }\n' +
  '  function restoreRepositoryControls() { currentRepository.disabled = false; browseRepository.disabled = !browseAvailable; currentRepository.focus(); }\n' +
  '  function loadRepositoryOptions() { fetch("/api/v1/repository-options", { credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("Repository options could not be loaded", r); return r.json(); }).then(function (body) { browseAvailable = body.browse.available; document.getElementById("platform-name").textContent = body.platform; var distro = document.getElementById("distro-name"); if (body.linuxDistro) { distro.textContent = body.linuxDistro; distro.hidden = false; } document.getElementById("picker-state").textContent = browseAvailable ? "BROWSE READY" : "BROWSE UNAVAILABLE"; document.getElementById("repository-source").textContent = body.current.source === "git-root" ? "Detected launch Git root" : "Detected launch directory"; document.getElementById("repository-name").textContent = body.current.source === "git-root" ? "Use current repository" : "Use current directory"; document.getElementById("repository-path").textContent = body.current.path; restoreRepositoryControls(); }, function () { browseAvailable = false; setStatus("Repository options unavailable. Current repository remains available.", false); restoreRepositoryControls(); }); }\n' +
  '  function chooseRepository(choice) { currentRepository.disabled = true; browseRepository.disabled = true; setStatus(choice === "browse" ? "Opening system repository picker..." : "Validating current repository...", true); fetch("/api/v1/repository", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ choice: choice }) }).then(function (r) { return r.text().then(function (text) { var body = {}; try { body = JSON.parse(text); } catch (_) {} return { ok: r.ok, status: r.status, body: body }; }); }).then(function (result) { if (!result.ok) { var code = result.body.code || "repository_selection_failed"; if (code === "repository_picker_unavailable") browseAvailable = false; setStatus(code === "repository_picker_cancelled" ? "Browse cancelled. Current repository is still available." : code === "repository_picker_unavailable" ? "System picker unavailable. Use the current repository." : code === "repository_picker_timeout" ? "System picker timed out. Try again or use current." : code === "repository_picker_invalid" ? "Picker returned an invalid repository. Nothing changed." : "Repository could not be chosen (" + result.status + ").", false); restoreRepositoryControls(); return; } var repositoryHasOwner = !!result.body.ownerName; if (repositoryHasOwner) rememberedName = result.body.ownerName; rememberedGreeting = result.body.greeting || ""; document.getElementById("owner-name").value = rememberedName; changeRepository.hidden = false; changeRepository.textContent = "Change repository"; viewDemo.textContent = "See how it works"; returnPanel = null; planningPanel.hidden = true; demoPanel.hidden = true; setStatus(rememberedGreeting || (result.body.status === "resumed" ? "Repository resumed." : "Repository initialized."), false); repositoryPanel.hidden = true; if (onboardingReady && rememberedName) { finishReady(rememberedName, !repositoryHasOwner); return; } routeForm.hidden = false; fetch("/api/v1/routes", { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error("routes"); return r.json(); }).then(function (routesBody) { renderRoutes(routesBody.routes); }, function () { detectedRoutes.textContent = "CLI detection unavailable; no route has been selected or verified."; }); }, function () { setStatus("Repository request failed. Try again.", false); restoreRepositoryControls(); }); }\n' +
  "  // The capability lives only in the fragment; it is never sent on the GET.\n" +
  '  var m = /^#cap=([0-9a-f]{1,256})$/.exec(location.hash);\n' +
  '  if (!m) { fail("no capability present."); return; }\n' +
  "  var capability = m[1];\n" +
  '  fetch("/api/v1/session", {\n' +
  '    method: "POST",\n' +
  '    headers: { "Content-Type": "application/json" },\n' +
  '    credentials: "same-origin",\n' +
  "    body: JSON.stringify({ capability: capability })\n" +
  "  }).then(function (r) {\n" +
  "    capability = null; // drop the secret reference as soon as the exchange resolves\n" +
  "    if (r.ok) {\n" +
  "      // Clear the fragment so the capability is not retained in history or Referer.\n" +
  '      history.replaceState(null, "", location.pathname + location.search);\n' +
  '      setStatus("Choose a repository.", false);\n' +
  "      if (demoPanel.hidden) repositoryPanel.hidden = false; loadRepositoryOptions();\n" +
  "    } else {\n" +
  '      fail("server rejected (" + r.status + ").");\n' +
  "    }\n" +
  '  }, function () { capability = null; fail("network error."); });\n' +
  '  currentRepository.addEventListener("click", function () { chooseRepository("current"); });\n' +
  '  browseRepository.addEventListener("click", function () { chooseRepository("browse"); });\n' +
  '  changeRepository.addEventListener("click", toggleRepositoryChooser);\n' +
  '  viewDemo.addEventListener("click", function () { if (demoPanel.hidden) openDemo(); else closeDemoPanel(); });\n' +
  '  document.getElementById("close-demo").addEventListener("click", closeDemoPanel);\n' +
  '  document.getElementById("demo-explorer").addEventListener("click", function () { chooseDemoMode("explorer"); });\n' +
  '  document.getElementById("demo-expedition").addEventListener("click", function () { chooseDemoMode("expedition"); });\n' +
  '  document.getElementById("demo-prev").addEventListener("click", function () { showDemoStage(demoStage - 1); });\n' +
  '  document.getElementById("demo-next").addEventListener("click", function () { if (demoStage === 2 && !demoMode) { chooseDemoMode("explorer"); document.getElementById("demo-mode-status").textContent = "Explorer highlighted as the lower-token example. In a real run, you choose Explorer or Expedition."; document.getElementById("demo-next").textContent = "Continue \\u2192"; return; } if (demoStage === 3) { closeDemoPanel(); return; } showDemoStage(demoStage + 1); });\n' +
  '  document.getElementById("journey-next").addEventListener("click", function () { invokeJourney(currentStage === "set-bearings" ? "gather-supplies" : "map-route"); });\n' +
  '  document.getElementById("journey-action-back").addEventListener("click", function () { planningPanel.hidden = true; workForm.hidden = false; document.getElementById("work-goal").focus(); setStatus("Journey paused at the owner handoff.", false); });\n' +
  '  ["explorer", "expedition"].forEach(function (mode) { document.getElementById("journey-" + mode).addEventListener("click", function () { journeyMode = mode; ["explorer", "expedition"].forEach(function (name) { var card = document.getElementById("journey-" + name); var chosen = name === mode; card.classList.toggle("selected", chosen); card.setAttribute("aria-pressed", String(chosen)); }); document.getElementById("execute-journey").disabled = false; }); });\n' +
  '  document.getElementById("execute-journey").addEventListener("click", function () { if (!journeyMode) return; var cadence = document.querySelector("input[name=review-cadence]:checked").value; invokeJourney(journeyMode === "explorer" ? "execute-explorer" : "execute-expedition", { executionMode: journeyMode, reviewCadence: cadence }); });\n' +
  '  document.getElementById("journey-back").addEventListener("click", function () { planningPanel.hidden = true; workForm.hidden = false; document.getElementById("work-goal").focus(); setStatus("Review or update your work request.", false); });\n' +
  '  document.getElementById("mode-back").addEventListener("click", function () { document.getElementById("mode-choice").hidden = true; document.getElementById("journey-action").hidden = false; document.getElementById("journey-next").textContent = "Map the Route again"; setStatus("Plan ready. Continue when you want to revise it.", false); });\n' +
  '  document.getElementById("completion-back").addEventListener("click", function () { document.getElementById("journey-complete").hidden = true; document.getElementById("mode-choice").hidden = false; setStatus("Review the selected execution settings.", false); });\n' +
  '  document.getElementById("journey-retry").addEventListener("click", function () { invokeJourney(currentStage); });\n' +
  '  document.getElementById("new-journey").addEventListener("click", function () { planningPanel.hidden = true; workForm.hidden = false; currentRunId = ""; currentGoal = ""; journeyMode = ""; document.getElementById("work-goal").value = ""; document.getElementById("work-goal").focus(); setStatus("Ready for another journey.", false); });\n' +
  '  workBack.addEventListener("click", function () { workForm.hidden = true; planningPanel.hidden = true; routeForm.hidden = false; setStatus("Review your agent route.", false); });\n' +
  '  document.getElementById("owner-name").addEventListener("input", function () { this.setCustomValidity(""); });\n' +
  '  routeForm.addEventListener("submit", function (ev) {\n' +
  "    ev.preventDefault();\n" +
  '    var ownerName = document.getElementById("owner-name"); var name = ownerName.value.trim(); if (!name) { ownerName.setCustomValidity("Tell us what to call you."); ownerName.reportValidity(); return; } ownerName.setCustomValidity(""); if (!routeForm.reportValidity() || !selectedRoute) return; setStatus("Launching Bearing...", true); fetch("/api/v1/readiness", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ provider: selectedRoute.provider, model: selectedRoute.model, reasoning: document.getElementById("reasoning").value }) }).then(function (r) { return r.json(); }).then(function (body) { setStatus(body.status === "detected" ? "CLI detected; provider verification required." : body.status === "blocked" ? "Route unavailable." : status.textContent, body.status === "detected"); if (body.status === "ready") finishReady(name, false); }, function () { setStatus("Launch check failed.", false); });\n' +
  "  });\n" +
  '  workForm.addEventListener("submit", function (ev) {\n' +
  '    ev.preventDefault(); if (!workForm.reportValidity()) return; currentGoal = document.getElementById("work-goal").value.trim(); if (!currentGoal) return; currentRunId = "browser-" + crypto.randomUUID(); setStatus("Saving the work request...", true); readRun(currentRunId).then(function (state) { return state.workRequestCreated ? state : postCommand(currentRunId, state, "createWorkRequest", { title: currentGoal.split(/\\r?\\n/, 1)[0].slice(0, 160), goal: currentGoal }).then(function () { return readRun(currentRunId); }); }).then(function () { workForm.hidden = true; planningPanel.hidden = false; invokeJourney("set-bearings"); }, showError);\n' +
  "  });\n" +
  '  planningAnswerForm.addEventListener("submit", function (ev) {\n' +
  '    ev.preventDefault(); if (!planningAnswerForm.reportValidity()) return; var answer = planningAnswer.value.trim(); if (!answer) return; setStatus("Saving your answer...", true); readRun(currentRunId).then(function (state) { if (!state.pendingDecision) throw new Error("No owner decision is pending."); return postCommand(currentRunId, state, "recordOwnerAnswer", { decisionId: state.pendingDecision.decisionId, answer: answer }); }).then(function () { invokeJourney(currentStage, { answer: answer }); }, showError);\n' +
  "  });\n" +
  "})();\n" +
  "</script>\n" +
  "</body>\n" +
  "</html>\n";

export function writeRejection(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Rejected");
}

function isCapabilityBody(v: unknown): v is { capability: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length !== 1 || !("capability" in v)) return false;
  const cap = (v as { capability?: unknown }).capability;
  return typeof cap === "string" && cap.length > 0;
}

function isRepositoryPathBody(v: unknown): v is { path: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length !== 1 || !("path" in v)) return false;
  const path = (v as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 && path.length <= 4096;
}

function isRepositoryChoiceBody(v: unknown): v is { choice: "current" | "browse" } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 &&
    "choice" in v && ((v as { choice?: unknown }).choice === "current" || (v as { choice?: unknown }).choice === "browse");
}

function isOwnerNameBody(v: unknown): v is { name: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length !== 1 || !("name" in v)) return false;
  const name = (v as { name?: unknown }).name;
  return typeof name === "string" && name === name.trim() && name.length > 0 && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name);
}

function isSelectionBody(v: unknown): v is Selection {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const body = v as Record<string, unknown>;
  return Object.keys(body).length === 3 && ["provider", "model", "reasoning"].every((key) => key in body) &&
    typeof body.provider === "string" && body.provider.length > 0 && body.provider.length <= 256 &&
    typeof body.model === "string" && body.model.length > 0 && body.model.length <= 256 &&
    typeof body.reasoning === "string" && (REASONING_LEVELS as readonly string[]).includes(body.reasoning);
}

interface JourneyBody {
  readonly runId: string;
  readonly stage: JourneyStage;
  readonly workGoal?: string;
  readonly answer?: string;
  readonly executionMode?: "explorer" | "expedition";
  readonly reviewCadence?: "slice" | "phase" | "end";
}

function isJourneyBody(v: unknown): v is JourneyBody {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const body = v as Record<string, unknown>;
  const allowed = new Set(["runId", "stage", "workGoal", "answer", "executionMode", "reviewCadence"]);
  const stages = new Set<JourneyStage>(["set-bearings", "gather-supplies", "map-route", "draft-implementation", "execute-explorer", "execute-expedition", "review"]);
  return Object.keys(body).every((key) => allowed.has(key)) && /^[A-Za-z0-9_-]{1,128}$/.test(String(body.runId ?? "")) &&
    stages.has(body.stage as JourneyStage) &&
    (body.workGoal === undefined || (typeof body.workGoal === "string" && body.workGoal === body.workGoal.trim() && body.workGoal.length > 0 && body.workGoal.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(body.workGoal))) &&
    (body.answer === undefined || (typeof body.answer === "string" && body.answer === body.answer.trim() && body.answer.length > 0 && body.answer.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(body.answer))) &&
    (body.executionMode === undefined || body.executionMode === "explorer" || body.executionMode === "expedition") &&
    (body.reviewCadence === undefined || body.reviewCadence === "slice" || body.reviewCadence === "phase" || body.reviewCadence === "end");
}

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QUOTED_HEADER_VALUE = /^"(?:[\t !#-\[\]-~]|\\[\t !-~])*"$/;

export function hasJsonContentType(header: string | string[] | undefined): boolean {
  if (typeof header !== "string") return false;
  const parts = header.split(";");
  if (parts[0].trim().toLowerCase() !== "application/json") return false;
  for (const rawParam of parts.slice(1)) {
    const param = rawParam.trim();
    const eq = param.indexOf("=");
    if (param.length === 0 || eq <= 0) return false;
    const value = param.slice(eq + 1).trim();
    if (!HEADER_TOKEN.test(param.slice(0, eq).trim())) return false;
    if (!HEADER_TOKEN.test(value) && !QUOTED_HEADER_VALUE.test(value)) return false;
  }
  return true;
}

/** Read a deliberately small JSON request body after the caller checks headers. */
export function readJsonBody(req: IncomingMessage, limit = MAX_SESSION_BODY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new RangeError("body too large"));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new SyntaxError("invalid json")); }
    });
    req.on("error", () => { if (!done) { done = true; reject(new Error("request error")); } });
  });
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== "string") return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    const rawName = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
    if (rawName !== name) continue;
    if (found !== undefined) return undefined;
    found = eq === -1 ? "" : trimmed.slice(eq + 1);
  }
  return found;
}

function handleSessionPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
): void {
  // State-changing/session requests require a matching loopback Origin.
  if (!service.validOrigin(req.headers.origin)) {
    writeRejection(res, 403);
    return;
  }
  if (!hasJsonContentType(req.headers["content-type"])) {
    writeRejection(res, 415);
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  req.on("data", (c: Buffer) => {
    if (settled) return;
    size += c.length;
    if (size > MAX_SESSION_BODY) {
      // ponytail: ceiling — we keep draining the remainder of an Origin-checked
      // loopback POST rather than req.destroy() (which races the 413 response).
      // Revisit with a hard socket close if this surface ever leaves loopback.
      if (settled) return;
      settled = true;
      writeRejection(res, 413);
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (settled) return;
    settled = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      writeRejection(res, 400);
      return;
    }
    if (!isCapabilityBody(parsed)) {
      writeRejection(res, 400);
      return;
    }
    const result = service.exchange(parsed.capability);
    if (!result.ok) {
      // Wrong/missing/replayed capability: no capability is ever echoed back.
      writeRejection(res, 403);
      return;
    }
    // HttpOnly + SameSite=Strict + Path=/. No Secure: this is plain loopback HTTP.
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${result.cookieValue}; HttpOnly; SameSite=Strict; Path=/`,
    );
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end("{}");
  });
  req.on("error", () => {
    if (!settled) {
      settled = true;
      writeRejection(res, 400);
    }
  });
}

function handleRepositoryPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  repositoryBootstrap: RepositoryBootstrap,
  repositoryChoice: Pick<RepositoryChoiceService, "options" | "resolve">,
  selected: SelectedBrowserState,
): void {
  if (!service.validOrigin(req.headers.origin)) {
    writeRejection(res, 403);
    return;
  }
  if (!hasJsonContentType(req.headers["content-type"])) {
    writeRejection(res, 415);
    return;
  }
  if (!service.authenticateRequest(req)) {
    writeRejection(res, 401);
    return;
  }
  if ([...selected.journeys.values()].some((journey) => journey.busy)) {
    res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "blocked", code: "journey_in_progress" }));
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  req.on("data", (c: Buffer) => {
    if (settled) return;
    size += c.length;
    if (size > MAX_REPOSITORY_BODY) {
      settled = true;
      writeRejection(res, 413);
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (settled) return;
    settled = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      writeRejection(res, 400);
      return;
    }
    const directPath = isRepositoryPathBody(parsed) ? parsed : undefined;
    const choice = isRepositoryChoiceBody(parsed) ? parsed : undefined;
    if (!directPath && !choice) {
      writeRejection(res, typeof parsed === "object" && parsed !== null && "choice" in parsed ? 422 : 400);
      return;
    }
    if (selected.repositorySelecting) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "blocked", code: "repository_selection_in_progress" }));
      return;
    }
    selected.repositorySelecting = true;
    const candidate = directPath
      ? Promise.resolve<RepositoryChoiceResult>({ result: "selected", candidate: directPath.path, source: "picker" })
      : repositoryChoice.resolve(choice!.choice);
    candidate.then((resolved) => {
      if (resolved.result !== "selected") {
        selected.repositorySelecting = false;
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "blocked", code: `repository_picker_${resolved.result}` }));
        return;
      }
      return repositoryBootstrap.choose(resolved.candidate).then((result) => {
      selected.repositorySelecting = false;
      if (!result.ok) {
        writeRejection(res, repositoryFailureStatus(result.reason));
        return;
      }
      selected.store = new BearingStore(result.repositoryPath);
      selected.repositoryPath = result.repositoryPath;
      selected.selection = null;
      selected.run = null;
      selected.journeys.clear();
      selected.sse = new SseProjection(selected.store, service);
      selected.gateway = new CommandGateway(selected.store, service, selected.sse);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: result.status, repositoryPath: result.repositoryPath, ...(result.ownerName ? { ownerName: result.ownerName, greeting: greetingFor(result.ownerName) } : {}) }));
      });
    }).catch(() => { selected.repositorySelecting = false; writeRejection(res, 500); });
  });
  req.on("error", () => {
    if (!settled) {
      settled = true;
      writeRejection(res, 400);
    }
  });
}

function handleOwnerPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  repositoryBootstrap: RepositoryBootstrap,
  repositoryPath: string | null,
  repositorySelecting: boolean,
): void {
  if (!service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!hasJsonContentType(req.headers["content-type"])) { writeRejection(res, 415); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!repositoryPath || repositorySelecting) { writeRejection(res, 409); return; }
  readJsonBody(req, MAX_OWNER_BODY).then(async (body) => {
    if (!isOwnerNameBody(body)) { writeRejection(res, 400); return; }
    const name = await repositoryBootstrap.rememberOwnerName(repositoryPath, body.name);
    if (!name) { writeRejection(res, 500); return; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify({ name, greeting: greetingFor(name) }));
  }, (error: unknown) => writeRejection(res, error instanceof RangeError ? 413 : 400));
}

function repositoryFailureStatus(reason: string): number {
  if (reason === "initialize_failed") return 500;
  if (
    reason === "path_not_absolute" ||
    reason === "repository_unavailable" ||
    reason === "repository_not_directory" ||
    reason === "repository_not_writable"
  ) {
    return 400;
  }
  return 409;
}

export interface RequestHandlerOptions {
  readonly startupOverrides?: RunOverrides;
  readonly routeInspection?: RouteInspectionPort;
  readonly verification?: VerificationPort;
  readonly processRunner?: ProcessRunner;
  readonly repositoryChoice?: Pick<RepositoryChoiceService, "options" | "resolve">;
}

function handleRepositoryOptions(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  repositoryChoice: Pick<RepositoryChoiceService, "options" | "resolve">,
): void {
  if (req.headers.origin !== undefined && !service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  repositoryChoice.options().then((options: RepositoryOptions) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(options));
  }, () => writeRejection(res, 500));
}

function handleReadinessPost(
  req: IncomingMessage,
  res: ServerResponse,
  service: LocalSessionService,
  readiness: ReadinessService,
  repositoryPath: string | null,
  repositorySelecting: boolean,
  remember: (selection: Selection, run: ResolvedRun) => void,
): void {
  if (!service.validOrigin(req.headers.origin)) {
    writeRejection(res, 403);
    return;
  }
  if (!hasJsonContentType(req.headers["content-type"])) {
    writeRejection(res, 415);
    return;
  }
  if (!service.authenticateRequest(req)) {
    writeRejection(res, 401);
    return;
  }
  if (!repositoryPath || repositorySelecting) {
    writeRejection(res, 409);
    return;
  }
  readJsonBody(req, MAX_READINESS_BODY).then(async (body) => {
    if (!isSelectionBody(body)) {
      if (typeof body === "object" && body !== null && !Array.isArray(body) &&
          ["provider", "model", "reasoning"].some((key) => !(key in body))) {
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "blocked", detected: false, verified: false, code: "selection_unavailable", repair: "choose_detected_route" }));
        return;
      }
      writeRejection(res, 400);
      return;
    }
    const result = await readiness.check(body, repositoryPath);
    if (result.status === "ready") remember(result.run.roles[0].selection, result.run);
    res.writeHead(result.status === "blocked" ? 409 : 200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
  }, (error: unknown) => writeRejection(res, error instanceof RangeError ? 413 : 400));
}

interface BrowserJourney {
  goal: string;
  question?: string;
  questionStage?: JourneyStage;
  planDirectory?: string;
  busy: boolean;
  readonly qa: { question: string; answer: string }[];
  readonly artifacts: string[];
}

type SelectedBrowserState = {
  store: BearingStore | null;
  gateway: CommandGateway | null;
  sse: SseProjection | null;
  repositoryPath: string | null;
  repositorySelecting: boolean;
  selection: Selection | null;
  run: ResolvedRun | null;
  readonly journeys: Map<string, BrowserJourney>;
};

function handleJourneyPost(req: IncomingMessage, res: ServerResponse, service: LocalSessionService, selected: SelectedBrowserState, journey: JourneyService | undefined): void {
  if (!service.validOrigin(req.headers.origin)) { writeRejection(res, 403); return; }
  if (!hasJsonContentType(req.headers["content-type"])) { writeRejection(res, 415); return; }
  if (!service.authenticateRequest(req)) { writeRejection(res, 401); return; }
  if (!journey || !selected.repositoryPath || !selected.selection || !selected.run || selected.repositorySelecting) { writeRejection(res, 409); return; }
  const repositoryPath = selected.repositoryPath, selection = selected.selection, run = selected.run;
  readJsonBody(req, MAX_JOURNEY_BODY).then(async (value) => {
    if (!isJourneyBody(value)) { writeRejection(res, 400); return; }
    let state = selected.journeys.get(value.runId);
    if (!state) {
      if (!value.workGoal || selected.journeys.size >= MAX_JOURNEYS) { writeRejection(res, 409); return; }
      state = { goal: value.workGoal, qa: [], artifacts: [], busy: false };
      selected.journeys.set(value.runId, state);
    } else if (value.workGoal && value.workGoal !== state.goal) { writeRejection(res, 409); return; }
    if (state.busy) { writeRejection(res, 409); return; }
    if (value.answer) {
      if (!state.question || state.questionStage !== value.stage) { writeRejection(res, 409); return; }
      state.qa.push({ question: state.question, answer: value.answer });
      state.question = undefined;
      state.questionStage = undefined;
    }
    if (value.executionMode) state.qa.push({ question: "Execution mode", answer: value.executionMode });
    if (value.reviewCadence) state.qa.push({ question: "Review cadence", answer: value.reviewCadence });
    state.busy = true;
    let result;
    try {
      result = await journey.execute({ selection, run, repositoryPath, runId: value.runId, workGoal: state.goal, stage: value.stage, priorOwnerQa: state.qa, planDirectory: state.planDirectory });
    } catch {
      result = { status: "failure" as const, code: "adapter_failed" as const, tokens: 0 };
    } finally { state.busy = false; }
    if (result.status === "question") { state.question = result.question; state.questionStage = value.stage; }
    if (result.status === "action") {
      for (const artifact of result.artifacts) if (!state.artifacts.includes(artifact)) state.artifacts.push(artifact);
      if (value.stage === "set-bearings" && !state.planDirectory) {
        const planArtifact = result.artifacts.find((path) => dirname(path) !== "." && (path.endsWith("/plan-spec.md") || /\/[A-Za-z0-9][A-Za-z0-9._-]*-route-map\.md$/.test(path)));
        if (planArtifact) state.planDirectory = dirname(planArtifact);
      }
    }
    const links = state.artifacts.flatMap((path, index) => path.toLowerCase().endsWith(".html") ? [{ path, url: `/api/v1/journey/${encodeURIComponent(value.runId)}/artifacts/${index}` }] : []);
    writeShowcaseJson(res, { ...result, artifacts: state.artifacts, artifactLinks: links });
  }, (error: unknown) => writeRejection(res, error instanceof RangeError ? 413 : 400));
}

async function handleJourneyArtifactGet(res: ServerResponse, service: LocalSessionService, req: IncomingMessage, selected: SelectedBrowserState, runId: string, indexText: string): Promise<void> {
  if (!service.authenticateRequest(req) || !selected.repositoryPath) { writeRejection(res, 401); return; }
  const state = selected.journeys.get(runId);
  const index = Number(indexText);
  const path = Number.isSafeInteger(index) ? state?.artifacts[index] : undefined;
  if (!path || !path.toLowerCase().endsWith(".html")) { writeRejection(res, 404); return; }
  try {
    const candidate = await realpath(resolve(selected.repositoryPath, path));
    const relation = relative(selected.repositoryPath, candidate);
    const info = await stat(candidate);
    if (!relation || relation.startsWith("..") || isAbsolute(relation) || !info.isFile() || info.size > MAX_JOURNEY_ARTIFACT) throw new Error("invalid artifact");
    const html = await readFile(candidate);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    res.end(html);
  } catch { writeRejection(res, 404); }
}

function writeShowcaseJson(res: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_SHOWCASE_JSON) {
    writeRejection(res, 500);
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

/**
 * HTTP handler for the browser-control boundary. Host is checked on every
 * request; Origin is checked on POST. The capability is never in any response.
 */
export function createRequestHandler(
  service: LocalSessionService,
  repositoryBootstrap = new RepositoryBootstrap(),
  options: RequestHandlerOptions = {},
) {
  const selected: SelectedBrowserState = {
    store: null, gateway: null, sse: null, repositoryPath: null, repositorySelecting: false, selection: null, run: null, journeys: new Map(),
  };
  const readiness = new ReadinessService(
    options.routeInspection ?? options.processRunner ?? { executableAvailable: () => false },
    options.verification ?? (options.processRunner ? new AdapterVerification(options.processRunner) : undefined),
    options.startupOverrides,
  );
  const repositoryChoice = options.repositoryChoice ?? new RepositoryChoiceService();
  const journey = options.processRunner ? new JourneyService(options.processRunner) : undefined;
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!service.validHost(req.headers.host)) {
      writeRejection(res, 421);
      return;
    }
    const method = req.method ?? "";
    const path = req.url ?? "/";
    if (method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(NATIVE_HTML);
      return;
    }
    if (method === "GET" && path === "/assets/bearing-office.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": SIGNATURE_IMAGE.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(SIGNATURE_IMAGE);
      return;
    }
    if (method === "GET" && path === "/assets/bearing-expedition.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": EXPEDITION_IMAGE.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(EXPEDITION_IMAGE);
      return;
    }
    if (method === "GET" && path === "/assets/bearing-explorer-card.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": EXPLORER_CARD_IMAGE.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(EXPLORER_CARD_IMAGE);
      return;
    }
    if (method === "GET" && path === "/assets/bearing-expedition-card.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": EXPEDITION_CARD_IMAGE.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(EXPEDITION_CARD_IMAGE);
      return;
    }
    if (method === "POST" && path === "/api/v1/session") {
      handleSessionPost(req, res, service);
      return;
    }
    if (method === "POST" && path === "/api/v1/repository") {
      handleRepositoryPost(req, res, service, repositoryBootstrap, repositoryChoice, selected);
      return;
    }
    if (method === "POST" && path === "/api/v1/owner") {
      handleOwnerPost(req, res, service, repositoryBootstrap, selected.repositoryPath, selected.repositorySelecting);
      return;
    }
    if (method === "GET" && path === "/api/v1/repository-options") {
      handleRepositoryOptions(req, res, service, repositoryChoice);
      return;
    }
    if (method === "GET" && path === "/api/v1/routes") {
      if (!service.authenticateRequest(req)) writeRejection(res, 401);
      else if (selected.store === null) writeRejection(res, 409);
      else {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ routes: readiness.inspect() }));
      }
      return;
    }
    if (method === "POST" && path === "/api/v1/readiness") {
      handleReadinessPost(req, res, service, readiness, selected.repositoryPath, selected.repositorySelecting, (selection, run) => { selected.selection = selection; selected.run = run; });
      return;
    }
    if (method === "POST" && path === "/api/v1/journey") {
      handleJourneyPost(req, res, service, selected, journey);
      return;
    }
    const journeyArtifact = /^\/api\/v1\/journey\/([A-Za-z0-9_-]{1,128})\/artifacts\/(\d{1,2})$/.exec(path);
    if (method === "GET" && journeyArtifact) {
      void handleJourneyArtifactGet(res, service, req, selected, journeyArtifact[1], journeyArtifact[2]);
      return;
    }
    if (method === "GET" && path === "/api/v1/workflows") {
      if (!service.authenticateRequest(req)) writeRejection(res, 401);
      else if (selected.store === null) writeRejection(res, 409);
      else writeShowcaseJson(res, { schemaVersion: 1, workflows: listWorkflowShowcases() });
      return;
    }
    const report = /^\/api\/v1\/workflows\/([A-Za-z0-9][A-Za-z0-9.-]{0,63})\/report$/.exec(path);
    if (method === "GET" && report) {
      if (!service.authenticateRequest(req)) writeRejection(res, 401);
      else if (selected.store === null) writeRejection(res, 409);
      else {
        const html = renderWorkflowReport(report[1]);
        if (html === null) writeRejection(res, 404);
        else if (Buffer.byteLength(html) > MAX_SHOWCASE_REPORT) writeRejection(res, 500);
        else {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Disposition": `inline; filename="${report[1]}-evidence.html"`,
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(html);
        }
      }
      return;
    }
    const workflow = /^\/api\/v1\/workflows\/([A-Za-z0-9][A-Za-z0-9.-]{0,63})$/.exec(path);
    if (method === "GET" && workflow) {
      if (!service.authenticateRequest(req)) writeRejection(res, 401);
      else if (selected.store === null) writeRejection(res, 409);
      else {
        const projection = projectWorkflowShowcase(workflow[1]);
        if (projection === null) writeRejection(res, 404);
        else writeShowcaseJson(res, projection);
      }
      return;
    }
    const command = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/commands$/.exec(path);
    if (method === "POST" && command) {
      if (selected.gateway === null) writeRejection(res, 409);
      else selected.gateway.handle(req, res, command[1]);
      return;
    }
    const run = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (method === "GET" && run) {
      if (!service.authenticateRequest(req)) writeRejection(res, 401);
      else if (selected.gateway === null) writeRejection(res, 409);
      else selected.gateway.read(req, res, run[1]);
      return;
    }
    const events = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/events$/.exec(path);
    if (method === "GET" && events) {
      if (selected.sse === null) writeRejection(res, 409);
      else selected.sse.handle(req, res, events[1]);
      return;
    }
    writeRejection(res, 404);
  };
}
