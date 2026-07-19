import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { RepositoryBootstrap } from "../repository/bootstrap.js";
import { RepositoryChoiceService, type RepositoryChoiceResult, type RepositoryOptions } from "../repository/choice.js";
import type { ProcessRunner } from "../adapters/adapters.js";
import { BearingStore } from "../store/bearing-store.js";
import { AdapterVerification, ReadinessService, REASONING_LEVELS, type RouteInspectionPort, type VerificationPort } from "../onboarding/readiness.js";
import type { RunOverrides, Selection } from "../profile/profile.js";
import { MAX_RECOMMENDATION_CREWMATES, MAX_RECOMMENDATION_TOKENS, MAX_RECOMMENDATION_WORK_ITEMS } from "../contracts/run.js";
import { CommandGateway } from "./command-gateway.js";
import { SseProjection } from "./sse.js";
import { MAX_SHOWCASE_JSON, MAX_SHOWCASE_REPORT, listWorkflowShowcases, projectWorkflowShowcase, renderWorkflowReport } from "../workflows/showcase.js";

// ponytail: 32-byte (256-bit) tokens give 2^256 entropy; hex is URL-fragment-safe.
const CAPABILITY_BYTES = 32;
const SESSION_BYTES = 32;
const MAX_SESSION_BODY = 8 * 1024;
const MAX_REPOSITORY_BODY = 8 * 1024;
const MAX_READINESS_BODY = 4 * 1024;
const MAX_OWNER_BODY = 512;
const SIGNATURE_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-office.png", import.meta.url)));
const EXPEDITION_IMAGE = readFileSync(fileURLToPath(new URL("../../assets/bearing-expedition.png", import.meta.url)));

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
  "</head>\n" +
  "<body>\n" +
  '<header><div class="brand"><span class="brand-mark" aria-hidden="true"></span>Bearing</div><nav class="nav-state" aria-label="Runtime status"><span class="badge">LOCAL</span><span class="badge">OWNER CONTROLLED</span></nav></header>\n' +
  "<main>\n" +
  '<div class="intro"><div><p class="eyebrow">Local agent control room</p><h1>Set bearings.</h1></div><div class="status-wrap"><span class="status-label">Current status</span><p class="status" id="status" role="status" aria-live="polite">Establishing local session\u2026</p></div></div>\n' +
  '<section class="panel" id="repository-panel" hidden aria-labelledby="repository-heading"><div class="panel-head"><h2 id="repository-heading">Repository</h2><span class="step">01 / SELECT</span></div><div class="panel-body"><p class="platform"><span id="platform-name" class="badge"></span><span id="distro-name" class="badge" hidden></span><span id="picker-state" class="badge"></span></p><div class="repo-grid"><button class="repo-card" id="current-repository" type="button" disabled><span class="source" id="repository-source">Detected current repository</span><strong id="repository-name">Loading\u2026</strong><span id="repository-path"></span></button><button class="browse" id="browse-repository" type="button" disabled>Browse for repository</button><a class="signature-link" href="https://github.com/alphazede/developers/tree/main/bearing" target="_blank" rel="noopener noreferrer" aria-label="Open Bearing on GitHub"><figure class="signature"><img src="/assets/bearing-office.png" alt="A bear in sunglasses working at a tidy office desk."><figcaption>Local work. Clear evidence. Owner control.</figcaption></figure></a></div></div></section>\n' +
  '<form class="panel" id="route-form" hidden><div class="panel-head"><h2>Agent route</h2><span class="step">02 / VERIFY</span></div><div class="panel-body"><fieldset class="route-fieldset"><legend>Choose one agent route</legend><p id="detected-routes">Checking CLI availability\u2026</p><div class="route-options" id="route-options"></div></fieldset><div class="route-details"><div><label for="owner-name">What should we call you?</label><input id="owner-name" type="text" required autocomplete="name" maxlength="80"></div><div><label for="reasoning">Reasoning</label><select id="reasoning" required><option value="" selected disabled>Choose reasoning</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></div></div><div class="actions"><button class="primary">Check readiness</button></div></div></form>\n' +
  `  <form class="panel" id="work-form" hidden><div class="panel-head"><h2>Work request</h2><span class="step">03 / PLAN</span></div><div class="panel-body"><div class="form-grid"><div><label for="run-id">Run id</label><input id="run-id" required maxlength="128" pattern="[A-Za-z0-9_\\-]+"></div><div><label for="work-items">Work items</label><input id="work-items" type="number" required min="1" max="${MAX_RECOMMENDATION_WORK_ITEMS}"></div><div><label for="crew-limit">Crewmates per Explorer</label><input id="crew-limit" type="number" required min="1" max="${MAX_RECOMMENDATION_CREWMATES}"></div><div class="wide"><label for="work-title">Work request title</label><input id="work-title" required maxlength="4096"></div><div class="wide"><label for="work-goal">Work request goal</label><textarea id="work-goal" required maxlength="4096"></textarea></div><div><label for="agent-tokens">Estimated tokens per agent</label><input id="agent-tokens" type="number" required min="1" max="${MAX_RECOMMENDATION_TOKENS}"></div></div><div class="actions"><button class="primary">Request recommendation</button></div></div></form>\n` +
  '<section class="panel" id="recommendation" hidden aria-live="polite"><div class="panel-head"><h2>Execution recommendation</h2><span class="step">OWNER DECISION</span></div><div class="metric-grid"><p id="recommended-mode"></p><p id="estimated-agents"></p><p id="estimated-tokens"></p></div><div class="panel-body"><p id="token-warning"></p><p id="token-tradeoff"></p><p id="coordination-tradeoff"></p><p id="approval-state"></p><div class="actions" id="recommendation-actions" hidden><button class="primary" id="approve-mode" type="button">Approve recommendation</button><button id="override-mode" type="button">Override to alternate mode</button></div></div></section>\n' +
  '<section class="panel" id="showcase" hidden aria-labelledby="showcase-heading"><div class="panel-head"><h2 id="showcase-heading">Workflow evidence</h2><span class="step">DETERMINISTIC / PROVIDERS OFF</span></div><div class="panel-body workflow-grid"><div><p>This showcase projects evidence without launching work.</p><label for="workflow-select">Workflow</label><select id="workflow-select" required><option value="" selected disabled>Choose workflow</option></select></div><article id="workflow-details" hidden aria-labelledby="workflow-name">\n' +
  '    <h3 id="workflow-name"></h3><dl><dt>Purpose</dt><dd id="workflow-purpose"></dd><dt>Execution mode</dt><dd id="workflow-mode"></dd><dt>Authority roles</dt><dd id="workflow-roles"></dd></dl>\n' +
  '    <h4>Decision stops</h4><ul id="workflow-stops"></ul>\n' +
  '    <h4>Expected artifacts</h4><ul id="workflow-artifacts"></ul>\n' +
  '    <h4>Outcome classes</h4><ul id="workflow-outcomes"></ul>\n' +
  '    <h4>Survey and Resurvey history</h4><ul id="workflow-surveys"></ul>\n' +
  '    <h4>Evidence-backed preview</h4><ul id="workflow-evidence"></ul>\n' +
  '    <p><a id="open-report" target="_blank" rel="noopener">Open offline evidence report</a> <a id="save-report" download>Save offline evidence report</a></p>\n' +
  "  </article></div>\n" +
  "</section>\n" +
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
  '  var recommendation = document.getElementById("recommendation");\n' +
  '  var recommendationActions = document.getElementById("recommendation-actions");\n' +
  '  var showcase = document.getElementById("showcase");\n' +
  '  var workflowSelect = document.getElementById("workflow-select");\n' +
  '  var runState = null;\n' +
  '  var browseAvailable = false;\n' +
  '  var selectedRoute = null;\n' +
  '  var rememberedName = "";\n' +
  '  var rememberedGreeting = "";\n' +
  '  function fail(msg) { status.textContent = "Session could not start: " + msg; }\n' +
  '  function requestError(label, r) { throw new Error(label + " (" + r.status + "). Refresh the run state and try again."); }\n' +
  '  function runId() { return document.getElementById("run-id").value; }\n' +
  '  function readRun(id) { return fetch("/api/v1/runs/" + encodeURIComponent(id), { credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("Run could not be read", r); return r.json(); }); }\n' +
  '  function postCommand(id, state, type, payload) { var commandId = crypto.randomUUID(); return fetch("/api/v1/runs/" + encodeURIComponent(id) + "/commands", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ schemaVersion: 1, commandId: commandId, runId: id, expectedRevision: state.revision, session: { sessionId: "browser", actor: "owner" }, correlationId: commandId, type: type, payload: payload }) }).then(function (r) { if (!r.ok) requestError("Command was rejected", r); return r.json(); }); }\n' +
  '  function showRun(state) { var r = state.recommendation; runState = state; if (!r) return; recommendation.hidden = false; document.getElementById("recommended-mode").textContent = "Recommended mode: " + r.recommendedMode; document.getElementById("estimated-agents").textContent = "Estimated agents: " + r.estimatedAgents; document.getElementById("estimated-tokens").textContent = "Estimated token use: " + r.estimatedTokens; document.getElementById("token-warning").textContent = "Token-cost warning: this recommendation may use " + r.estimatedTokens + " tokens."; document.getElementById("token-tradeoff").textContent = "Token tradeoff: " + r.tradeoffs.tokens; document.getElementById("coordination-tradeoff").textContent = "Coordination tradeoff: " + r.tradeoffs.coordination; document.getElementById("approval-state").textContent = state.approval ? "Owner action recorded: " + state.approval.selectedMode + ". This does not launch work." : "Owner approval required. No work has been launched."; recommendationActions.hidden = !!state.approval; }\n' +
  '  function showError(error) { status.textContent = error instanceof Error ? error.message : "Request failed."; }\n' +
  '  function fillList(id, values) { var list = document.getElementById(id); list.replaceChildren(); values.forEach(function (value) { var item = document.createElement("li"); item.textContent = value; list.appendChild(item); }); }\n' +
  '  function showWorkflow(body) { document.getElementById("workflow-details").hidden = false; document.getElementById("workflow-name").textContent = body.name; document.getElementById("workflow-purpose").textContent = body.purpose; document.getElementById("workflow-mode").textContent = body.executionMode + "; deterministic; providers disabled; no implicit launch"; document.getElementById("workflow-roles").textContent = body.authorityRoles.join(", "); fillList("workflow-stops", body.decisionStops.map(function (stop) { return stop.authorityRole + ": " + stop.decision + " before " + stop.beforeTaskId + "; requires " + stop.requires.join(", "); })); fillList("workflow-artifacts", body.expectedArtifacts.map(function (artifact) { return artifact.id + ": " + artifact.path; })); fillList("workflow-outcomes", body.outcomeExpectations.map(function (outcome) { return outcome.id + ": " + outcome.status + (outcome.unresolvedOwner ? "; unresolved owner " + outcome.unresolvedOwner : ""); })); fillList("workflow-surveys", body.evidence.surveys.map(function (survey) { return survey.id + ": " + survey.outcome + (survey.remediationId ? " after " + survey.remediationId : "") + "; " + survey.summary; }).concat(body.evidence.decisions.map(function (decision) { return decision.id + ": owner " + decision.decision + "; " + decision.summary; }), body.evidence.remediations.map(function (remediation) { return remediation.id + ": " + remediation.summary; }))); fillList("workflow-evidence", body.evidence.artifacts.map(function (artifact) { return artifact.name + ": " + artifact.textEquivalent; }).concat(body.evidence.findings.map(function (finding) { return finding.id + ": " + finding.outcome + "; " + finding.summary; }))); var reportPath = "/api/v1/workflows/" + encodeURIComponent(body.id) + "/report"; document.getElementById("open-report").href = reportPath; var save = document.getElementById("save-report"); save.href = reportPath; save.download = body.id + "-evidence.html"; status.textContent = body.name + " demonstration loaded. No work was launched."; }\n' +
  '  function loadWorkflow(id) { status.textContent = "Loading deterministic demonstration..."; fetch("/api/v1/workflows/" + encodeURIComponent(id), { credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("Workflow could not be loaded", r); return r.json(); }).then(showWorkflow, showError); }\n' +
  '  function loadWorkflowCatalog() { fetch("/api/v1/workflows", { credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("Workflow catalog could not be loaded", r); return r.json(); }).then(function (body) { body.workflows.forEach(function (workflow) { var option = document.createElement("option"); option.value = workflow.id; option.textContent = workflow.name; workflowSelect.appendChild(option); }); showcase.hidden = false; }, showError); }\n' +
  '  function renderRoutes(routes) { var names = { "codex": "Codex — configured model", "grok-safe": "Grok Build", "pi-zai-glm-5.2": "GLM 5.2", "pi-deepseek-deepseek-v4-pro": "DeepSeek V4 Pro" }; var firstAvailable = null; selectedRoute = null; routeOptions.replaceChildren(); routes.forEach(function (route, index) { var label = document.createElement("label"); label.className = "route-card" + (route.detected ? "" : " unavailable"); var input = document.createElement("input"); input.type = "radio"; input.name = "route"; input.id = "route-option-" + index; input.required = true; input.disabled = !route.detected; input.addEventListener("change", function () { selectedRoute = route; }); var copy = document.createElement("span"); var title = document.createElement("strong"); title.textContent = names[route.id] || route.id; var statusText = document.createElement("span"); statusText.className = "route-status"; statusText.id = input.id + "-status"; statusText.textContent = route.detected ? "CLI detected" : "CLI unavailable"; input.setAttribute("aria-describedby", statusText.id); var modelText = document.createElement("span"); modelText.className = "route-model"; modelText.textContent = route.model === "*" ? "Uses your configured Codex model (*)" : route.provider + " / " + route.model; copy.append(title, statusText, modelText); label.append(input, copy); routeOptions.appendChild(label); if (!firstAvailable && route.detected) firstAvailable = input; }); var detected = routes.filter(function (route) { return route.detected; }).length; detectedRoutes.textContent = "CLI detection only; Check readiness verifies the selected route. " + detected + " of " + routes.length + " CLIs detected."; if (firstAvailable) firstAvailable.focus(); }\n' +
  '  function revealWork(greeting) { routeForm.hidden = true; workForm.hidden = false; loadWorkflowCatalog(); status.textContent = greeting; }\n' +
  '  function finishReady(name) { if (rememberedName === name && rememberedGreeting) { revealWork(rememberedGreeting); return; } fetch("/api/v1/owner", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ name: name }) }).then(function (r) { if (!r.ok) throw new Error("owner"); return r.json(); }).then(function (body) { rememberedName = body.name; rememberedGreeting = body.greeting; revealWork(body.greeting); }, function () { status.textContent = "Your name could not be remembered. Try again."; }); }\n' +
  '  function restoreRepositoryControls() { currentRepository.disabled = false; browseRepository.disabled = !browseAvailable; currentRepository.focus(); }\n' +
  '  function loadRepositoryOptions() { fetch("/api/v1/repository-options", { credentials: "same-origin" }).then(function (r) { if (!r.ok) requestError("Repository options could not be loaded", r); return r.json(); }).then(function (body) { browseAvailable = body.browse.available; document.getElementById("platform-name").textContent = body.platform; var distro = document.getElementById("distro-name"); if (body.linuxDistro) { distro.textContent = body.linuxDistro; distro.hidden = false; } document.getElementById("picker-state").textContent = browseAvailable ? "BROWSE READY" : "BROWSE UNAVAILABLE"; document.getElementById("repository-source").textContent = body.current.source === "git-root" ? "Detected launch Git root" : "Detected launch directory"; document.getElementById("repository-name").textContent = body.current.source === "git-root" ? "Use current repository" : "Use current directory"; document.getElementById("repository-path").textContent = body.current.path; restoreRepositoryControls(); }, function () { browseAvailable = false; status.textContent = "Repository options unavailable. Current repository remains available."; restoreRepositoryControls(); }); }\n' +
  '  function chooseRepository(choice) { currentRepository.disabled = true; browseRepository.disabled = true; status.textContent = choice === "browse" ? "Opening system repository picker..." : "Validating current repository..."; fetch("/api/v1/repository", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ choice: choice }) }).then(function (r) { return r.text().then(function (text) { var body = {}; try { body = JSON.parse(text); } catch (_) {} return { ok: r.ok, status: r.status, body: body }; }); }).then(function (result) { if (!result.ok) { var code = result.body.code || "repository_selection_failed"; if (code === "repository_picker_unavailable") browseAvailable = false; status.textContent = code === "repository_picker_cancelled" ? "Browse cancelled. Current repository is still available." : code === "repository_picker_unavailable" ? "System picker unavailable. Use the current repository." : code === "repository_picker_timeout" ? "System picker timed out. Try again or use current." : code === "repository_picker_invalid" ? "Picker returned an invalid repository. Nothing changed." : "Repository could not be chosen (" + result.status + ")."; restoreRepositoryControls(); return; } rememberedName = result.body.ownerName || ""; rememberedGreeting = result.body.greeting || ""; document.getElementById("owner-name").value = rememberedName; status.textContent = rememberedGreeting || (result.body.status === "resumed" ? "Repository resumed." : "Repository initialized."); repositoryPanel.hidden = true; routeForm.hidden = false; fetch("/api/v1/routes", { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error("routes"); return r.json(); }).then(function (routesBody) { renderRoutes(routesBody.routes); }, function () { detectedRoutes.textContent = "CLI detection unavailable; no route has been selected or verified."; }); }, function () { status.textContent = "Repository request failed. Try again."; restoreRepositoryControls(); }); }\n' +
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
  '      status.textContent = "Choose a repository.";\n' +
  "      repositoryPanel.hidden = false; loadRepositoryOptions();\n" +
  "    } else {\n" +
  '      fail("server rejected (" + r.status + ").");\n' +
  "    }\n" +
  '  }, function () { capability = null; fail("network error."); });\n' +
  '  currentRepository.addEventListener("click", function () { chooseRepository("current"); });\n' +
  '  browseRepository.addEventListener("click", function () { chooseRepository("browse"); });\n' +
  '  document.getElementById("owner-name").addEventListener("input", function () { this.setCustomValidity(""); });\n' +
  '  routeForm.addEventListener("submit", function (ev) {\n' +
  "    ev.preventDefault();\n" +
  '    var ownerName = document.getElementById("owner-name"); var name = ownerName.value.trim(); if (!name) { ownerName.setCustomValidity("Tell us what to call you."); ownerName.reportValidity(); return; } ownerName.setCustomValidity(""); if (!routeForm.reportValidity() || !selectedRoute) return; fetch("/api/v1/readiness", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ provider: selectedRoute.provider, model: selectedRoute.model, reasoning: document.getElementById("reasoning").value }) }).then(function (r) { return r.json(); }).then(function (body) { status.textContent = body.status === "detected" ? "CLI detected; provider verification required." : body.status === "blocked" ? "Route unavailable." : status.textContent; if (body.status === "ready") finishReady(name); }, function () { status.textContent = "Readiness check failed."; });\n' +
  "  });\n" +
  '  workForm.addEventListener("submit", function (ev) {\n' +
  '    ev.preventDefault(); if (!workForm.reportValidity()) return; var id = runId(); var values = { workItems: Number(document.getElementById("work-items").value), maxCrewmatesPerExplorer: Number(document.getElementById("crew-limit").value), perAgentTokenEstimate: Number(document.getElementById("agent-tokens").value) }; status.textContent = "Requesting durable recommendation..."; readRun(id).then(function (state) { if (state.recommendation) return state; if (state.workRequestCreated) return state; return postCommand(id, state, "createWorkRequest", { title: document.getElementById("work-title").value, goal: document.getElementById("work-goal").value }).then(function () { return readRun(id); }); }).then(function (state) { if (state.recommendation) return state; return postCommand(id, state, "recommendExecutionMode", values).then(function () { return readRun(id); }); }).then(function (state) { showRun(state); status.textContent = state.recommendation ? "Recommendation recorded. Choose an owner action." : "Recommendation unavailable."; }, showError);\n' +
  "  });\n" +
  '  document.getElementById("approve-mode").addEventListener("click", function () { if (!runState || !runState.recommendation || runState.approval) return; postCommand(runId(), runState, "approveExecutionMode", { recommendationEventId: runState.recommendation.eventId }).then(function () { return readRun(runId()); }).then(function (state) { showRun(state); status.textContent = "Recommendation approved; no work was launched."; }, showError); });\n' +
  '  document.getElementById("override-mode").addEventListener("click", function () { if (!runState || !runState.recommendation || runState.approval) return; var alternate = runState.recommendation.recommendedMode === "explorer" ? "expedition" : "explorer"; postCommand(runId(), runState, "overrideExecutionMode", { recommendationEventId: runState.recommendation.eventId, selectedMode: alternate }).then(function () { return readRun(runId()); }).then(function (state) { showRun(state); status.textContent = "Alternate mode recorded; no work was launched."; }, showError); });\n' +
  '  workflowSelect.addEventListener("change", function () { if (workflowSelect.value) loadWorkflow(workflowSelect.value); });\n' +
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
  selected: { store: BearingStore | null; gateway: CommandGateway | null; sse: SseProjection | null; repositoryPath: string | null; repositorySelecting: boolean },
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
    if (selected.repositorySelecting || selected.repositoryPath !== null) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "blocked", code: "repository_already_selected" }));
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
    res.writeHead(result.status === "blocked" ? 409 : 200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
  }, (error: unknown) => writeRejection(res, error instanceof RangeError ? 413 : 400));
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
  const selected: { store: BearingStore | null; gateway: CommandGateway | null; sse: SseProjection | null; repositoryPath: string | null; repositorySelecting: boolean } = {
    store: null, gateway: null, sse: null, repositoryPath: null, repositorySelecting: false,
  };
  const readiness = new ReadinessService(
    options.routeInspection ?? options.processRunner ?? { executableAvailable: () => false },
    options.verification ?? (options.processRunner ? new AdapterVerification(options.processRunner) : undefined),
    options.startupOverrides,
  );
  const repositoryChoice = options.repositoryChoice ?? new RepositoryChoiceService();
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
      handleReadinessPost(req, res, service, readiness, selected.repositoryPath, selected.repositorySelecting);
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
