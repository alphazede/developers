use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::io::{IsTerminal, Write};
use std::path::Path;
use std::process::ExitCode;

use crossterm::cursor::{Hide, Show};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::{execute, queue};

use bran_core::agent::delegate::{DelegationOptions, DelegationRequest};
use bran_core::agent::receipt::DelegationReceipt;
use bran_core::agent::runtime::InvocationOutcome;
use bran_core::agent::{synthetic, synthetic_builtin_profiles, ReasoningLevel, ToolPolicy};
use bran_core::bundle::{Bundle, Doc, Frontmatter};
use bran_core::graph::{
    Confidence, GraphInput, GraphLimits, KnowledgeGraph, NodeId, NodeInput, NodeRole, Provenance,
};
use bran_core::metadata::{FactProvenance, MetadataFact};
use bran_core::packet::{
    DependencyClosureLimits, EvidenceContent, EvidencePriority, PacketAssembler,
    PacketAssemblyRequest, PacketLimits,
};
use bran_core::profile::BRAN_STRICT;
use bran_core::profile::{Diagnostic, ProfileValidator, ValidationStatus};
use bran_core::repair::{MaintainerAuthority, RepairCoordinator, RepairReceipt, RepairTerminal};
use bran_core::scan::{RepositoryScanner, ScanConfig, ScanSnapshot};
use bran_core::schema::YamlValue;
use bran_core::view::{
    Presentation, ViewCompiler, ViewField, ViewFilter, ViewGrouping, ViewSort, ViewSource, ViewSpec,
};
use bran_tui::{
    apply_settings, load_settings, render_app, OnboardingStep, TerminalCapabilities, TerminalGuard,
    TerminalPort, TuiAction, TuiApp, TuiEvent, DEFAULT_CONNECTED_AGENT_TASK_TOKEN_CEILING,
};

const SMOKE_OUTPUT: &str = r#"{"schema_version":"1.0.0","command":"smoke","status":"ok","data":{},"warnings":[],"failures":[],"provenance":{},"metrics":{}}"#;
const MISSING_COMMAND_ERROR: &str = r#"{"schema_version":"1.0.0","command":"","status":"error","data":null,"warnings":[],"failures":["missing_command"],"provenance":{},"metrics":{}}"#;
const UNKNOWN_COMMAND_ERROR: &str = r#"{"schema_version":"1.0.0","command":"","status":"error","data":null,"warnings":[],"failures":["unknown_command"],"provenance":{},"metrics":{}}"#;

/// Private typed exits (0 success, 1 validation, 2 usage, 3 operation).
#[derive(Clone, Copy)]
#[repr(u8)]
enum TypedExit {
    Success = 0,
    Validation = 1,
    Usage = 2,
    Operation = 3,
}

impl TypedExit {
    fn code(self) -> ExitCode {
        ExitCode::from(self as u8)
    }
}

fn main() -> ExitCode {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() == 1
        && arguments[0] == "tui"
        && std::io::stdin().is_terminal()
        && std::io::stdout().is_terminal()
    {
        return run_tui();
    }
    CliApp::run_for_terminal(
        arguments,
        std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
    )
    .write_to_stdio()
}

struct CliApp;

impl CliApp {
    #[cfg(test)]
    fn run<I>(arguments: I) -> CliResult
    where
        I: IntoIterator,
        I::Item: AsRef<OsStr>,
    {
        Self::run_for_terminal(arguments, false)
    }

    fn run_for_terminal<I>(arguments: I, is_terminal: bool) -> CliResult
    where
        I: IntoIterator,
        I::Item: AsRef<OsStr>,
    {
        let mut it = arguments.into_iter();
        let first = it.next();
        let cmd = match first.as_ref() {
            Some(os) => match os.as_ref().to_str() {
                Some(c) => c,
                None => return CliResult::usage(UNKNOWN_COMMAND_ERROR.to_owned()),
            },
            None => return CliResult::usage(MISSING_COMMAND_ERROR.to_owned()),
        };

        match cmd {
            "smoke" => {
                if it.next().is_some() {
                    return CliResult::usage(UNKNOWN_COMMAND_ERROR.to_owned());
                }
                CliResult::success(SMOKE_OUTPUT.to_owned())
            }
            "query" => {
                let root = match it
                    .next()
                    .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                {
                    Some(r) => r,
                    None => return CliResult::usage(make_query_error("missing_root")),
                };
                let mut parts = vec![];
                for a in it {
                    match a.as_ref().to_str() {
                        Some(s) => parts.push(s.to_owned()),
                        None => return CliResult::usage(make_query_error("invalid_utf8")),
                    }
                }
                let qtext = parts.join(" ");
                if qtext.trim().is_empty() {
                    return CliResult::usage(make_query_error("missing_query"));
                }
                match do_query(root, qtext) {
                    Ok((data, warns, fails, provenance, metrics)) => CliResult::success(
                        make_envelope("query", "ok", &data, &warns, &fails, &provenance, &metrics),
                    ),
                    Err(msg) => CliResult::operation(make_envelope(
                        "query",
                        "error",
                        "null",
                        &[],
                        &[msg],
                        "{}",
                        "{}",
                    )),
                }
            }
            "packet" => {
                let root = match it
                    .next()
                    .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                {
                    Some(r) => r,
                    None => return CliResult::usage(make_packet_error("missing_root")),
                };
                let mut parts = vec![];
                for a in it {
                    match a.as_ref().to_str() {
                        Some(s) => parts.push(s.to_owned()),
                        None => return CliResult::usage(make_packet_error("invalid_utf8")),
                    }
                }
                let qtext = parts.join(" ");
                if qtext.trim().is_empty() {
                    return CliResult::usage(make_packet_error("missing_query"));
                }
                match do_packet(root, qtext) {
                    Ok((data, warns, fails, provenance, metrics)) => CliResult::success(
                        make_envelope("packet", "ok", &data, &warns, &fails, &provenance, &metrics),
                    ),
                    Err(msg) => CliResult::operation(make_envelope(
                        "packet",
                        "error",
                        "null",
                        &[],
                        &[msg],
                        "{}",
                        "{}",
                    )),
                }
            }
            "check" => {
                let root = match it
                    .next()
                    .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                {
                    Some(r) => r,
                    None => return CliResult::usage(make_check_error("missing_root")),
                };
                let profile = match it
                    .next()
                    .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                {
                    Some(p) => p,
                    None => return CliResult::usage(make_check_error("missing_profile")),
                };
                if it.next().is_some() {
                    return CliResult::usage(make_check_error("too_many_args"));
                }
                match do_check(root, profile) {
                    Ok((data, warns, fails, exitc, status, provenance, metrics)) => {
                        let mut r = CliResult::success(make_envelope(
                            "check",
                            status,
                            &data,
                            &warns,
                            &fails,
                            &provenance,
                            &metrics,
                        ));
                        r.exit_code = exitc;
                        r.is_error = status == "error";
                        r
                    }
                    Err(msg) => CliResult::operation(make_envelope(
                        "check",
                        "error",
                        "null",
                        &[],
                        &[msg],
                        "{}",
                        "{}",
                    )),
                }
            }
            "maintain" => {
                // Smallest model-neutral headless maintainer adapter over bran_core::repair::RepairCoordinator.
                // Positional args per MVP contract. All responses use ordered envelope.
                let sub = match it
                    .next()
                    .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                {
                    Some(s) => s,
                    None => return CliResult::usage(make_maintain_error("", "missing_subcommand")),
                };
                match sub.as_str() {
                    "propose" => {
                        let root = match it
                            .next()
                            .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                        {
                            Some(r) => r,
                            None => {
                                return CliResult::usage(make_maintain_error(
                                    "propose",
                                    "missing_root",
                                ))
                            }
                        };
                        let target = match it
                            .next()
                            .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                        {
                            Some(t) => t,
                            None => {
                                return CliResult::usage(make_maintain_error(
                                    "propose",
                                    "missing_target",
                                ))
                            }
                        };
                        let replacement = match it
                            .next()
                            .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                        {
                            Some(r) => r,
                            None => {
                                return CliResult::usage(make_maintain_error(
                                    "propose",
                                    "missing_replacement",
                                ))
                            }
                        };
                        if it.next().is_some() {
                            return CliResult::usage(make_maintain_error(
                                "propose",
                                "too_many_args",
                            ));
                        }
                        do_maintain_propose(root, target, replacement)
                    }
                    "apply" => {
                        let root = match it
                            .next()
                            .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                        {
                            Some(r) => r,
                            None => {
                                return CliResult::usage(make_maintain_error(
                                    "apply",
                                    "missing_root",
                                ))
                            }
                        };
                        let target = match it
                            .next()
                            .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                        {
                            Some(t) => t,
                            None => {
                                return CliResult::usage(make_maintain_error(
                                    "apply",
                                    "missing_target",
                                ))
                            }
                        };
                        let replacement = match it
                            .next()
                            .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                        {
                            Some(r) => r,
                            None => {
                                return CliResult::usage(make_maintain_error(
                                    "apply",
                                    "missing_replacement",
                                ))
                            }
                        };
                        let digest = match it
                            .next()
                            .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                        {
                            Some(d) => d,
                            None => {
                                return CliResult::usage(make_maintain_error(
                                    "apply",
                                    "missing_digest",
                                ))
                            }
                        };
                        let authority = match it
                            .next()
                            .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                        {
                            Some(a) => a,
                            None => {
                                return CliResult::usage(make_maintain_error(
                                    "apply",
                                    "missing_authority",
                                ))
                            }
                        };
                        if it.next().is_some() {
                            return CliResult::usage(make_maintain_error("apply", "too_many_args"));
                        }
                        do_maintain_apply(root, target, replacement, digest, authority)
                    }
                    "revalidate" => {
                        let root = match it
                            .next()
                            .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                        {
                            Some(r) => r,
                            None => {
                                return CliResult::usage(make_maintain_error(
                                    "revalidate",
                                    "missing_root",
                                ))
                            }
                        };
                        if it.next().is_some() {
                            return CliResult::usage(make_maintain_error(
                                "revalidate",
                                "too_many_args",
                            ));
                        }
                        do_maintain_revalidate(root)
                    }
                    _ => CliResult::usage(make_maintain_error(&sub, "unknown_subcommand")),
                }
            }
            "tui" => {
                if it.next().is_some() {
                    return CliResult::usage(UNKNOWN_COMMAND_ERROR.to_owned());
                }
                if !is_terminal {
                    return CliResult::operation(make_envelope(
                        "tui",
                        "error",
                        "null",
                        &[],
                        &["tui_unavailable_non_tty".to_owned()],
                        "{}",
                        "{}",
                    ));
                }
                CliResult {
                    output: String::new(),
                    exit_code: TypedExit::Success.code(),
                    is_error: false,
                    is_interactive: true,
                }
            }
            "agents" => {
                // Slice 3.4 Packet D1: agents list only (headless, no auth/provider/network, no -p)
                let sub = match it
                    .next()
                    .and_then(|o| o.as_ref().to_str().map(|s| s.to_owned()))
                {
                    Some(s) => s,
                    None => return CliResult::usage(make_agents_error("", "missing_subcommand")),
                };
                match sub.as_str() {
                    "list" => {
                        if it.next().is_some() {
                            return CliResult::usage(make_agents_error("list", "too_many_args"));
                        }
                        do_agents_list()
                    }
                    _ => CliResult::usage(make_agents_error(&sub, "unknown_subcommand")),
                }
            }
            "doctor" => {
                let mode = match it
                    .next()
                    .and_then(|o| o.as_ref().to_str().map(str::to_owned))
                {
                    Some(mode) => mode,
                    None => return CliResult::usage(make_doctor_error("missing_mode")),
                };
                if it.next().is_some() {
                    return CliResult::usage(make_doctor_error("too_many_args"));
                }
                match mode.as_str() {
                    "--onboarding" | "--agent" => do_doctor(&mode),
                    _ => CliResult::usage(make_doctor_error("unknown_mode")),
                }
            }
            "-p" => {
                // Headless prompt surface: no transport or secrets.
                let mut rest: Vec<String> = vec![];
                for a in it {
                    match a.as_ref().to_str() {
                        Some(s) => rest.push(s.to_owned()),
                        None => return CliResult::usage(make_p_error("invalid_utf8")),
                    }
                }
                do_headless_p(rest)
            }
            _ => CliResult::usage(UNKNOWN_COMMAND_ERROR.to_owned()),
        }
    }
}

struct CrosstermPort;

impl TerminalPort for CrosstermPort {
    fn enter(&mut self) -> Result<(), String> {
        terminal::enable_raw_mode().map_err(|error| error.to_string())?;
        execute!(std::io::stdout(), EnterAlternateScreen, Hide).map_err(|error| error.to_string())
    }

    fn restore(&mut self) {
        let _ = execute!(std::io::stdout(), Show, LeaveAlternateScreen);
        let _ = terminal::disable_raw_mode();
    }
}

fn run_tui() -> ExitCode {
    let mut port = CrosstermPort;
    let result = (|| -> Result<(), String> {
        let _guard =
            TerminalGuard::enter(&mut port).map_err(|e| format!("tui terminal error: {e}"))?;
        let mut app = TuiApp::default();
        match load_settings(Path::new(".bran/settings.conf")) {
            Ok(Some(settings)) => {
                app.draft = settings;
                app.step = OnboardingStep::Complete;
                app.status = "resumed settings".to_owned();
                let req = bran_tui::AdvancedRequest::new(app.draft.clone());
                app.resolved = Some(bran_tui::resolve_advanced(req, app.capability, app.policy));
            }
            Ok(None) => {}
            Err(_) => app.status = "settings unavailable; onboarding".to_owned(),
        }
        loop {
            if let Err(error) = draw_tui(&app) {
                return Err(format!("tui render error: {error}"));
            }
            let event = match event::read() {
                Ok(event) => event,
                Err(error) => return Err(format!("tui input error: {error}")),
            };
            match event {
                Event::Resize(columns, _) => app.handle(TuiEvent::Resize { columns }),
                Event::Key(key)
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
                {
                    if let Some(event) = map_key(key, app.input.is_empty()) {
                        app.handle(event);
                    } else if key.code == KeyCode::Tab {
                        app.update_suggestions(tui_candidates(&app));
                    }
                }
                _ => continue,
            }
            if let Some(action) = app.take_action() {
                match action {
                    TuiAction::Query(query) => match do_query(".".to_owned(), query) {
                        Ok((data, warnings, failures, provenance, metrics)) => {
                            app.status = make_envelope(
                                "query",
                                "ok",
                                &data,
                                &warnings,
                                &failures,
                                &provenance,
                                &metrics,
                            )
                        }
                        Err(error) => {
                            app.status =
                                make_envelope("query", "error", "null", &[], &[error], "{}", "{}")
                        }
                    },
                    TuiAction::Apply => {
                        let path = Path::new(".bran/settings.conf");
                        let persisted = std::fs::create_dir_all(".bran")
                            .and_then(|_| apply_settings(path, &app.draft))
                            .is_ok();
                        app.handle(TuiEvent::ApplyFinished { persisted });
                    }
                    TuiAction::Quit => return Ok(()),
                }
            }
        }
    })();
    if let Err(error) = result {
        eprintln!("{}", error);
        return TypedExit::Operation.code();
    }
    ExitCode::SUCCESS
}

fn draw_tui(app: &TuiApp) -> std::io::Result<()> {
    let columns = terminal::size().map(|(columns, _)| columns).unwrap_or(80);
    let mut output = std::io::stdout();
    queue!(
        output,
        Clear(ClearType::All),
        crossterm::cursor::MoveTo(0, 0)
    )?;
    let no_color = std::env::var_os("NO_COLOR").is_some();
    write!(
        output,
        "{}",
        render_app(
            app,
            TerminalCapabilities {
                columns,
                unicode: true,
                no_color
            }
        )
    )?;
    output.flush()
}

fn map_key(key: KeyEvent, input_empty: bool) -> Option<TuiEvent> {
    match (key.code, key.modifiers) {
        (KeyCode::Char('c'), KeyModifiers::CONTROL) => Some(TuiEvent::Quit),
        (KeyCode::Char('s'), KeyModifiers::CONTROL) => Some(TuiEvent::CtrlS),
        (KeyCode::Char('q'), KeyModifiers::NONE) if input_empty => Some(TuiEvent::Quit),
        (KeyCode::Char(character), modifiers)
            if modifiers.is_empty() || modifiers == KeyModifiers::SHIFT =>
        {
            Some(TuiEvent::Input(character))
        }
        (KeyCode::Backspace, _) => Some(TuiEvent::Backspace),
        (KeyCode::Enter, _) => Some(TuiEvent::Enter),
        (KeyCode::Esc, _) => Some(TuiEvent::Escape),
        (KeyCode::Up, _) => Some(TuiEvent::Up),
        (KeyCode::Down, _) => Some(TuiEvent::Down),
        _ => None,
    }
}

fn tui_candidates(app: &TuiApp) -> &'static str {
    use bran_tui::OnboardingStep::*;
    match app.step {
        FlowChoice => "quick\nadvanced",
        OperatingProfile => "offline\ncore-sqz\nconnected",
        Guardrails => {
            "next\n+sqz\n-sqz\n+voice\n-voice\n+history\n-history\n+chat\n-chat\ntokens=8500"
        }
        Diagnose => "next\nrepair",
        Apply => "apply",
        Complete => "query\npacket\ncheck",
        _ => "back",
    }
}

fn make_envelope(
    command: &str,
    status: &str,
    data: &str,
    warnings: &[String],
    failures: &[String],
    provenance: &str,
    metrics: &str,
) -> String {
    let w = warnings
        .iter()
        .map(|s| format!("\"{}\"", json_escape(s)))
        .collect::<Vec<_>>()
        .join(",");
    let f = failures
        .iter()
        .map(|s| format!("\"{}\"", json_escape(s)))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"schema_version\":\"1.0.0\",\"command\":\"{}\",\"status\":\"{}\",\"data\":{},\"warnings\":[{}],\"failures\":[{}],\"provenance\":{},\"metrics\":{}}}",
        json_escape(command),
        json_escape(status),
        data,
        w,
        f,
        provenance,
        metrics
    )
}

fn make_query_error(detail: &str) -> String {
    make_envelope(
        "query",
        "error",
        "null",
        &[],
        &[detail.to_owned()],
        "{}",
        "{}",
    )
}

fn make_packet_error(detail: &str) -> String {
    make_envelope(
        "packet",
        "error",
        "null",
        &[],
        &[detail.to_owned()],
        "{}",
        "{}",
    )
}

fn make_check_error(detail: &str) -> String {
    make_envelope(
        "check",
        "error",
        "null",
        &[],
        &[detail.to_owned()],
        "{}",
        "{}",
    )
}

fn make_maintain_error(sub: &str, detail: &str) -> String {
    let command = if sub.is_empty() {
        "maintain".to_owned()
    } else {
        format!("maintain.{}", sub)
    };
    make_envelope(
        &command,
        "error",
        "null",
        &[],
        &[detail.to_owned()],
        "{}",
        "{}",
    )
}

fn make_agents_error(sub: &str, detail: &str) -> String {
    let command = if sub.is_empty() {
        "agents".to_owned()
    } else {
        format!("agents.{}", sub)
    };
    make_envelope(
        &command,
        "error",
        "null",
        &[],
        &[detail.to_owned()],
        "{}",
        "{}",
    )
}

fn make_p_error(detail: &str) -> String {
    make_envelope("p", "error", "null", &[], &[detail.to_owned()], "{}", "{}")
}

fn make_doctor_error(detail: &str) -> String {
    make_envelope(
        "doctor",
        "error",
        "null",
        &[],
        &[detail.to_owned()],
        "{}",
        "{}",
    )
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            _ => out.push(c),
        }
    }
    out
}

/// Small type aliases to keep return signatures readable (addresses clippy::type-complexity).
type QueryPacketResult = Result<(String, Vec<String>, Vec<String>, String, String), String>;
type CheckResult = Result<
    (
        String,
        Vec<String>,
        Vec<String>,
        ExitCode,
        &'static str,
        String,
        String,
    ),
    String,
>;

fn do_query(root: String, query_text: String) -> QueryPacketResult {
    let root_path: &Path = Path::new(&root);
    let scanner = RepositoryScanner::new(root_path, ScanConfig::default())
        .map_err(|e| format!("scan_error: {:?}", e))?;
    let snapshot = scanner.scan().map_err(|e| format!("scan_error: {:?}", e))?;
    let graph_input = snapshot
        .graph_input()
        .map_err(|e| format!("graph_input_error: {:?}", e))?;
    let node_count = graph_input.nodes().len().max(1);
    let edge_count = graph_input.edges().len().max(1);
    let limits =
        GraphLimits::new(node_count, edge_count).map_err(|e| format!("limits_error: {:?}", e))?;
    let graph =
        KnowledgeGraph::build(graph_input, limits).map_err(|e| format!("graph_error: {:?}", e))?;

    let locator_filter = if query_text.trim().is_empty() {
        ViewFilter::All
    } else {
        ViewFilter::ProvenanceLocatorContains(query_text.clone())
    };
    let spec = ViewSpec {
        source: ViewSource::Roles(vec![NodeRole::Document]),
        filter: locator_filter,
        sort: ViewSort::NodeId,
        grouping: ViewGrouping::None,
        fields: vec![ViewField::ProvenanceLocator, ViewField::NodeId],
        presentation: Presentation::Json,
        max_items: 1024,
        max_bytes: 1_048_576,
    };
    let compiled = ViewCompiler::new()
        .compile(&spec, &graph)
        .map_err(|e| format!("view_error: {:?}", e))?;

    let selected_locators: Vec<String> = compiled
        .items()
        .iter()
        .map(|it| it.provenance.locator().to_string())
        .collect();

    let mut selected_bytes: usize = 0;
    for loc in &selected_locators {
        if let Some(ent) = snapshot.entries.get(loc) {
            selected_bytes += ent.source.len();
        }
    }
    let candidate_bytes = snapshot.total_bytes;
    let estimated = selected_bytes / 4 + usize::from(!selected_bytes.is_multiple_of(4));
    let context_bytes_avoided = candidate_bytes.saturating_sub(selected_bytes);

    let warns: Vec<String> = snapshot
        .diagnostics
        .iter()
        .map(|d| format!("{:?}", d))
        .collect();

    let locs_json = selected_locators
        .iter()
        .map(|l| format!("\"{}\"", json_escape(l)))
        .collect::<Vec<_>>()
        .join(",");
    let data = format!(
        "{{\"root\":\"{}\",\"query\":\"{}\",\"selected_locators\":[{}],\"candidate_source_bytes\":{},\"selected_source_bytes\":{},\"context_bytes_avoided\":{},\"estimated_tokens\":{},\"token_estimate_method\":\"bytes-divided-by-four-ceiling\"}}",
        json_escape(&root),
        json_escape(&query_text),
        locs_json,
        candidate_bytes,
        selected_bytes,
        context_bytes_avoided,
        estimated
    );
    let provenance = if locs_json.is_empty() {
        "{\"sources\":[\"repository-scanner\",\"bran-core\"]}".to_owned()
    } else {
        format!(
            "{{\"sources\":[\"repository-scanner\",\"bran-core\"],\"selected_locators\":[{}]}}",
            locs_json
        )
    };
    let metrics = format!(
        "{{\"candidate_source_bytes\":{},\"selected_source_bytes\":{},\"context_bytes_avoided\":{},\"estimated_tokens\":{},\"token_estimate_method\":\"bytes-divided-by-four-ceiling\"}}",
        candidate_bytes, selected_bytes, context_bytes_avoided, estimated
    );
    Ok((data, warns, vec![], provenance, metrics))
}

fn do_packet(root: String, query_text: String) -> QueryPacketResult {
    let root_path: &Path = Path::new(&root);
    let scanner = RepositoryScanner::new(root_path, ScanConfig::default())
        .map_err(|e| format!("scan_error: {:?}", e))?;
    let snapshot = scanner.scan().map_err(|e| format!("scan_error: {:?}", e))?;
    let graph_input = snapshot
        .graph_input()
        .map_err(|e| format!("graph_input_error: {:?}", e))?;
    let node_count = graph_input.nodes().len().max(1);
    let edge_count = graph_input.edges().len().max(1);
    let limits =
        GraphLimits::new(node_count, edge_count).map_err(|e| format!("limits_error: {:?}", e))?;
    let mut evidence = vec![];
    for graph_node in graph_input.nodes() {
        let node_id = graph_node.id().clone();
        let locator = graph_node.provenance().locator().to_string();
        let content = snapshot
            .entries
            .get(&locator)
            .map(|scan_entry| String::from_utf8_lossy(&scan_entry.source).into_owned())
            .unwrap_or_default();
        evidence.push(EvidenceContent::new(
            node_id,
            content,
            EvidencePriority::Recommended,
            100,
            1,
            vec![],
        ));
    }
    let graph =
        KnowledgeGraph::build(graph_input, limits).map_err(|e| format!("graph_error: {:?}", e))?;

    let locator_filter = if query_text.trim().is_empty() {
        ViewFilter::All
    } else {
        ViewFilter::ProvenanceLocatorContains(query_text.clone())
    };
    let spec = ViewSpec {
        source: ViewSource::Roles(vec![NodeRole::Document]),
        filter: locator_filter,
        sort: ViewSort::NodeId,
        grouping: ViewGrouping::None,
        fields: vec![ViewField::ProvenanceLocator, ViewField::NodeId],
        presentation: Presentation::Json,
        max_items: 1024,
        max_bytes: 1_048_576,
    };
    let compiled = ViewCompiler::new()
        .compile(&spec, &graph)
        .map_err(|e| format!("view_error: {:?}", e))?;

    let mut selected_locators: Vec<String> = vec![];
    for it in compiled.items() {
        selected_locators.push(it.provenance.locator().to_string());
    }

    let mut selected_source_bytes: usize = 0;
    for loc in &selected_locators {
        if let Some(ent) = snapshot.entries.get(loc) {
            selected_source_bytes += ent.source.len();
        }
    }
    let candidate_bytes = snapshot.total_bytes;
    let context_bytes_avoided = candidate_bytes.saturating_sub(selected_source_bytes);

    let pkt_limits = PacketLimits::new(256, 4 * 1024 * 1024, None);
    let dep_limits =
        DependencyClosureLimits::new(4, 256).map_err(|e| format!("dep_limits: {:?}", e))?;
    let req = PacketAssemblyRequest {
        view: &compiled,
        graph: &graph,
        evidence: &evidence,
        limits: pkt_limits,
        dependency_limits: dep_limits,
    };
    let pkt = PacketAssembler::new()
        .assemble(&req)
        .map_err(|e| format!("packet_error: {:?}", e))?;

    let selected_locators_json = selected_locators
        .iter()
        .map(|l| format!("\"{}\"", json_escape(l)))
        .collect::<Vec<_>>()
        .join(",");
    let seed_ids_json = pkt
        .receipt
        .seed_ids
        .iter()
        .map(|id| format!("\"{}\"", json_escape(id.as_str())))
        .collect::<Vec<_>>()
        .join(",");
    let admitted_dependency_ids_json = pkt
        .receipt
        .admitted_dependency_ids
        .iter()
        .map(|id| format!("\"{}\"", json_escape(id.as_str())))
        .collect::<Vec<_>>()
        .join(",");
    let selected_ids_json = pkt
        .receipt
        .selected_ids
        .iter()
        .map(|id| format!("\"{}\"", json_escape(id.as_str())))
        .collect::<Vec<_>>()
        .join(",");
    let raw_b = pkt.receipt.raw_bytes;
    let est = pkt.receipt.estimated_tokens;
    let tr = pkt.receipt.truncated;

    let warns: Vec<String> = snapshot
        .diagnostics
        .iter()
        .map(|d| format!("{:?}", d))
        .collect();

    let data = format!(
        "{{\"root\":\"{}\",\"query\":\"{}\",\"selected_locators\":[{}],\"seed_ids\":[{}],\"admitted_dependency_ids\":[{}],\"selected_ids\":[{}],\"candidate_source_bytes\":{},\"selected_source_bytes\":{},\"context_bytes_avoided\":{},\"raw_bytes\":{},\"estimated_tokens\":{},\"token_estimate_method\":\"bytes-divided-by-four-ceiling\",\"actual_model_input_tokens\":\"unavailable\",\"truncated\":{}}}",
        json_escape(&root),
        json_escape(&query_text),
        selected_locators_json,
        seed_ids_json,
        admitted_dependency_ids_json,
        selected_ids_json,
        candidate_bytes,
        selected_source_bytes,
        context_bytes_avoided,
        raw_b,
        est,
        tr
    );
    let provenance = if selected_locators_json.is_empty() {
        "{\"sources\":[\"repository-scanner\",\"bran-core\"]}".to_owned()
    } else {
        format!(
            "{{\"sources\":[\"repository-scanner\",\"bran-core\"],\"selected_locators\":[{}]}}",
            selected_locators_json
        )
    };
    let metrics = format!(
        "{{\"candidate_source_bytes\":{},\"selected_source_bytes\":{},\"context_bytes_avoided\":{},\"encoded_packet_bytes\":{},\"estimated_tokens\":{},\"token_estimate_method\":\"bytes-divided-by-four-ceiling\",\"actual_model_input_tokens\":\"unavailable\"}}",
        candidate_bytes, selected_source_bytes, context_bytes_avoided, raw_b, est
    );
    Ok((data, warns, vec![], provenance, metrics))
}

fn do_check(root: String, selected_profile: String) -> CheckResult {
    let root_path: &Path = Path::new(&root);
    let scanner = RepositoryScanner::new(root_path, ScanConfig::default())
        .map_err(|e| format!("scan_error: {:?}", e))?;
    let snapshot = scanner.scan().map_err(|e| format!("scan_error: {:?}", e))?;
    let bundle = derive_bundle_from_snapshot(&snapshot)?;

    let vres = ProfileValidator::validate(&bundle, &selected_profile);

    let okf = &vres.okf_compatibility;
    let strict = &vres.bran_strict;
    let okf_diags = format_diagnostics(&okf.diagnostics);
    let strict_diags = format_diagnostics(&strict.diagnostics);
    let sel_err_json = match &vres.selected_profile_error {
        Some(d) => format!(
            "{{\"path\":\"{}\",\"code\":\"{}\",\"message\":\"{}\"}}",
            json_escape(&d.path),
            json_escape(&d.code),
            json_escape(&d.message)
        ),
        None => "null".to_owned(),
    };

    let status = if vres.selected_profile_error.is_some() {
        "error"
    } else if vres.selected_passed() {
        "ok"
    } else {
        "failed"
    };
    let exitc = if status == "ok" {
        TypedExit::Success.code()
    } else if status == "failed" {
        TypedExit::Validation.code()
    } else {
        TypedExit::Usage.code()
    };

    let data = format!(
        "{{\"root\":\"{}\",\"selected_profile\":\"{}\",\"okf_compatibility\":{{\"profile\":\"{}\",\"status\":\"{}\",\"diagnostics\":[{}]}},\"bran_strict\":{{\"profile\":\"{}\",\"status\":\"{}\",\"diagnostics\":[{}]}},\"selected_profile_error\":{},\"selected_passed\":{},\"exit_code\":{}}}",
        json_escape(&root),
        json_escape(&selected_profile),
        json_escape(&okf.profile),
        status_str(&okf.status),
        okf_diags,
        json_escape(&strict.profile),
        status_str(&strict.status),
        strict_diags,
        sel_err_json,
        vres.selected_passed(),
        vres.exit_code()
    );

    let warns: Vec<String> = snapshot
        .diagnostics
        .iter()
        .map(|d| format!("{:?}", d))
        .collect();
    let mut fails: Vec<String> = vec![];
    if vres.selected_profile_error.is_some() {
        fails.push(format!("unknown-profile:{}", selected_profile));
    }

    let provenance = "{\"sources\":[\"repository-scanner\",\"bran-core\"]}".to_owned();
    let metrics = format!(
        "{{\"selected_passed\":{},\"exit_code\":{}}}",
        vres.selected_passed(),
        vres.exit_code()
    );
    Ok((data, warns, fails, exitc, status, provenance, metrics))
}

fn derive_bundle_from_snapshot(snapshot: &ScanSnapshot) -> Result<Bundle, String> {
    let mut docs = vec![];
    for (path, entry) in &snapshot.entries {
        if !(path.ends_with(".md") || path.ends_with(".markdown")) {
            continue;
        }
        let source = match std::str::from_utf8(entry.source.as_ref()) {
            Ok(s) => s.to_string(),
            Err(_) => continue,
        };
        let (raw, body) = split_frontmatter(&source);
        let fm_map = build_map_from_facts(&entry.metadata.facts);
        let fm = if let Some(reason) = entry
            .metadata
            .warnings
            .iter()
            .find_map(|warning| warning.strip_prefix("malformed-metadata: "))
        {
            Frontmatter::malformed(raw, reason)
        } else if fm_map.is_empty() && raw.is_empty() {
            Frontmatter::empty()
        } else {
            Frontmatter::from_parsed(raw, fm_map)
        };
        docs.push(Doc::new(path.clone(), source, body, fm));
    }
    Bundle::from_documents(docs).map_err(|e| format!("duplicate_path: {}", e.path))
}

fn split_frontmatter(source: &str) -> (String, String) {
    let lines: Vec<&str> = source.lines().collect();
    if lines.is_empty() {
        return (String::new(), source.to_string());
    }
    let first = lines[0].trim_start_matches('\u{feff}').trim();
    if first != "---" {
        return (String::new(), source.to_string());
    }
    let mut fm_lines = vec![lines[0].to_string()];
    let mut i = 1usize;
    let mut found = false;
    while i < lines.len() {
        let l = lines[i];
        fm_lines.push(l.to_string());
        if l.trim() == "---" {
            found = true;
            i += 1;
            break;
        }
        i += 1;
    }
    let body = if found && i <= lines.len() {
        lines[i..].join("\n")
    } else {
        return (source.to_string(), String::new());
    };
    let raw = fm_lines.join("\n") + "\n";
    (raw, body)
}

fn build_map_from_facts(facts: &[MetadataFact]) -> BTreeMap<String, YamlValue> {
    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in facts {
        if f.provenance == FactProvenance::MarkdownFrontmatter {
            grouped
                .entry(f.key.clone())
                .or_default()
                .push(f.value.clone());
        }
    }
    let mut map = BTreeMap::new();
    for (k, vs) in grouped {
        if vs.len() == 1 {
            map.insert(k, YamlValue::String(vs[0].clone()));
        } else {
            map.insert(
                k,
                YamlValue::Sequence(vs.into_iter().map(YamlValue::String).collect()),
            );
        }
    }
    map
}

fn status_str(s: &ValidationStatus) -> &'static str {
    match s {
        ValidationStatus::Pass => "pass",
        ValidationStatus::Fail => "fail",
    }
}

fn format_diagnostics(diags: &[Diagnostic]) -> String {
    diags
        .iter()
        .map(|d| {
            format!(
                "{{\"path\":\"{}\",\"code\":\"{}\",\"message\":\"{}\"}}",
                json_escape(&d.path),
                json_escape(&d.code),
                json_escape(&d.message)
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

// --- Slice 3.1 Packet B: headless maintainer adapter (ponytail-minimal) ---

const FIXTURE_MARKER_NAME: &str = ".bran-fixture-authority";
const FIXTURE_MARKER_BYTES: &[u8] = b"bran-cli-fixture-v1\n";

fn has_exact_fixture_marker(root: &Path) -> bool {
    std::fs::read(root.join(FIXTURE_MARKER_NAME))
        .map(|b| b == FIXTURE_MARKER_BYTES)
        .unwrap_or(false)
}

fn cli_maintainer_validator(root: &Path) -> Result<(), String> {
    if !has_exact_fixture_marker(root) {
        return Err("missing_fixture_authority_marker".to_owned());
    }
    let scanner = RepositoryScanner::new(root, ScanConfig::default())
        .map_err(|e| format!("scan_error: {:?}", e))?;
    let snapshot = scanner.scan().map_err(|e| format!("scan_error: {:?}", e))?;
    let bundle = derive_bundle_from_snapshot(&snapshot)?;
    let vres = ProfileValidator::validate(&bundle, BRAN_STRICT);
    if vres.selected_passed() {
        Ok(())
    } else {
        Err("bran_strict_failed".to_owned())
    }
}

fn receipt_data(r: &RepairReceipt) -> String {
    format!(
        "{{\"schema_version\":\"{}\",\"proposal_digest\":\"{}\",\"applied_target\":\"{}\",\"authority_tag\":\"{}\",\"revalidation\":\"{}\"}}",
        json_escape(r.schema_version),
        json_escape(&r.proposal_digest),
        json_escape(&r.applied_target),
        json_escape(&r.authority_tag),
        json_escape(&r.revalidation)
    )
}

fn do_maintain_propose(root: String, target: String, replacement: String) -> CliResult {
    let root_path: &Path = Path::new(&root);
    // Propose is read-only; pass the strict validator (not invoked until apply)
    let coord = match RepairCoordinator::new(root_path, cli_maintainer_validator) {
        Ok(c) => c,
        Err(RepairTerminal::IoPartialWrite { reason, .. }) => {
            return CliResult::operation(make_envelope(
                "maintain.propose",
                "error",
                "null",
                &[],
                &[format!("io_error:{}", reason)],
                "{}",
                "{}",
            ));
        }
        Err(RepairTerminal::UnsafePath { path }) => {
            return CliResult::operation(make_envelope(
                "maintain.propose",
                "error",
                "null",
                &[],
                &[format!("unsafe_path:{}", path)],
                "{}",
                "{}",
            ));
        }
        Err(_) => {
            return CliResult::operation(make_envelope(
                "maintain.propose",
                "error",
                "null",
                &[],
                &["coord_error".to_owned()],
                "{}",
                "{}",
            ))
        }
    };
    let repl = replacement.into_bytes();
    match coord.propose(target, repl) {
        RepairTerminal::Proposed(p) => {
            let data = format!(
                "{{\"digest\":\"{}\",\"target\":\"{}\",\"original_present\":{}}}",
                json_escape(p.digest()),
                json_escape(p.target()),
                if p.original_bytes().is_some() {
                    "true"
                } else {
                    "false"
                }
            );
            CliResult::success(make_envelope(
                "maintain.propose",
                "ok",
                &data,
                &[],
                &[],
                "{}",
                "{}",
            ))
        }
        RepairTerminal::UnsafePath { path } => CliResult::operation(make_envelope(
            "maintain.propose",
            "error",
            "null",
            &[],
            &[format!("unsafe_path:{}", path)],
            "{}",
            "{}",
        )),
        RepairTerminal::IoPartialWrite { reason, .. } => CliResult::operation(make_envelope(
            "maintain.propose",
            "error",
            "null",
            &[],
            &[format!("io_error:{}", reason)],
            "{}",
            "{}",
        )),
        _ => CliResult::operation(make_envelope(
            "maintain.propose",
            "error",
            "null",
            &[],
            &["unexpected".to_owned()],
            "{}",
            "{}",
        )),
    }
}

fn do_maintain_apply(
    root: String,
    target: String,
    replacement: String,
    digest: String,
    authority: String,
) -> CliResult {
    let root_path: &Path = Path::new(&root);
    if !has_exact_fixture_marker(root_path) {
        return CliResult::usage(make_envelope(
            "maintain.apply",
            "error",
            "null",
            &[],
            &["missing_fixture_authority_marker".to_owned()],
            "{}",
            "{}",
        ));
    }
    if digest.trim().is_empty() {
        return CliResult::usage(make_envelope(
            "maintain.apply",
            "error",
            "null",
            &[],
            &["missing_digest".to_owned()],
            "{}",
            "{}",
        ));
    }
    if authority.trim().is_empty() {
        return CliResult::usage(make_envelope(
            "maintain.apply",
            "error",
            "null",
            &[],
            &["blank_authority".to_owned()],
            "{}",
            "{}",
        ));
    }
    let coord = match RepairCoordinator::new(root_path, cli_maintainer_validator) {
        Ok(c) => c,
        Err(RepairTerminal::IoPartialWrite { reason, .. }) => {
            return CliResult::operation(make_envelope(
                "maintain.apply",
                "error",
                "null",
                &[],
                &[format!("io_error:{}", reason)],
                "{}",
                "{}",
            ));
        }
        Err(RepairTerminal::UnsafePath { path }) => {
            return CliResult::operation(make_envelope(
                "maintain.apply",
                "error",
                "null",
                &[],
                &[format!("unsafe_path:{}", path)],
                "{}",
                "{}",
            ));
        }
        Err(_) => {
            return CliResult::operation(make_envelope(
                "maintain.apply",
                "error",
                "null",
                &[],
                &["coord_error".to_owned()],
                "{}",
                "{}",
            ))
        }
    };
    // Reconstruct proposal via coordinator (per contract)
    let repl = replacement.into_bytes();
    let prop = match coord.propose(target.clone(), repl) {
        RepairTerminal::Proposed(p) => p,
        RepairTerminal::UnsafePath { path } => {
            return CliResult::operation(make_envelope(
                "maintain.apply",
                "error",
                "null",
                &[],
                &[format!("unsafe_path:{}", path)],
                "{}",
                "{}",
            ));
        }
        RepairTerminal::IoPartialWrite { reason, .. } => {
            return CliResult::operation(make_envelope(
                "maintain.apply",
                "error",
                "null",
                &[],
                &[format!("io_error:{}", reason)],
                "{}",
                "{}",
            ));
        }
        _ => {
            return CliResult::operation(make_envelope(
                "maintain.apply",
                "error",
                "null",
                &[],
                &["unexpected".to_owned()],
                "{}",
                "{}",
            ))
        }
    };
    let auth = MaintainerAuthority::new(authority);
    match coord.apply(Some(auth), prop, &digest) {
        RepairTerminal::ValidationPassed(receipt) => {
            let data = receipt_data(&receipt);
            let prov = "{\"sources\":[\"repair-coordinator\",\"bran-core\"]}".to_owned();
            CliResult::success(make_envelope(
                "maintain.apply",
                "ok",
                &data,
                &[],
                &[],
                &prov,
                "{}",
            ))
        }
        RepairTerminal::ValidationFailed { reason, .. } => CliResult {
            output: make_envelope(
                "maintain.apply",
                "error",
                "null",
                &[],
                &[reason],
                "{}",
                "{}",
            ),
            exit_code: TypedExit::Validation.code(),
            is_error: true,
            is_interactive: false,
        },
        RepairTerminal::AuthorizationFailure => CliResult::usage(make_envelope(
            "maintain.apply",
            "error",
            "null",
            &[],
            &["authorization_failure".to_owned()],
            "{}",
            "{}",
        )),
        RepairTerminal::DigestMismatch { expected, actual } => {
            let canonical_source = |source: &str| {
                if source == "missing" {
                    return true;
                }
                let Some((byte_len, lanes)) = source
                    .strip_prefix("present:")
                    .and_then(|source| source.split_once(':'))
                else {
                    return false;
                };
                byte_len
                    .parse::<usize>()
                    .is_ok_and(|parsed_len| parsed_len.to_string() == byte_len)
                    && lanes.split('-').count() == 3
                    && lanes.split('-').all(|lane| {
                        lane.len() == 16
                            && lane
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
                    })
            };
            let actual_digest_parts = actual.rsplit_once("|s:");
            let expected_digest_parts = expected.rsplit_once("|s:");
            let stale_source = match (actual_digest_parts, expected_digest_parts) {
                (Some((actual_plan, actual_source)), Some((expected_plan, expected_source))) => {
                    actual_plan
                        .strip_prefix("p:")
                        .is_some_and(|plan| !plan.is_empty())
                        && expected_plan
                            .strip_prefix("p:")
                            .is_some_and(|plan| !plan.is_empty())
                        && canonical_source(actual_source)
                        && canonical_source(expected_source)
                        && actual_plan == expected_plan
                        && actual_source != expected_source
                }
                _ => false,
            };
            if stale_source {
                CliResult::operation(make_envelope(
                    "maintain.apply",
                    "error",
                    "null",
                    &[],
                    &["stale_source".to_owned()],
                    "{}",
                    "{}",
                ))
            } else {
                CliResult::usage(make_envelope(
                    "maintain.apply",
                    "error",
                    "null",
                    &[],
                    &[format!(
                        "digest_mismatch:expected={},actual={}",
                        json_escape(&expected),
                        json_escape(&actual)
                    )],
                    "{}",
                    "{}",
                ))
            }
        }
        RepairTerminal::StaleSource => CliResult::operation(make_envelope(
            "maintain.apply",
            "error",
            "null",
            &[],
            &["stale_source".to_owned()],
            "{}",
            "{}",
        )),
        RepairTerminal::UnsafePath { path } => CliResult::operation(make_envelope(
            "maintain.apply",
            "error",
            "null",
            &[],
            &[format!("unsafe_path:{}", path)],
            "{}",
            "{}",
        )),
        RepairTerminal::IoPartialWrite { reason, .. } => CliResult::operation(make_envelope(
            "maintain.apply",
            "error",
            "null",
            &[],
            &[format!("io_partial:{}", reason)],
            "{}",
            "{}",
        )),
        _ => CliResult::operation(make_envelope(
            "maintain.apply",
            "error",
            "null",
            &[],
            &["unexpected".to_owned()],
            "{}",
            "{}",
        )),
    }
}

fn do_maintain_revalidate(root: String) -> CliResult {
    let root_path: &Path = Path::new(&root);
    match cli_maintainer_validator(root_path) {
        Ok(()) => CliResult::success(make_envelope(
            "maintain.revalidate",
            "ok",
            "{}",
            &[],
            &[],
            "{}",
            "{}",
        )),
        Err(reason) => CliResult {
            output: make_envelope(
                "maintain.revalidate",
                "error",
                "null",
                &[],
                &[reason],
                "{}",
                "{}",
            ),
            exit_code: TypedExit::Validation.code(),
            is_error: true,
            is_interactive: false,
        },
    }
}

fn do_agents_list() -> CliResult {
    let apr = synthetic_builtin_profiles();
    let mut agent_strs = vec![];
    for p in apr.profiles() {
        let name = json_escape(p.name());
        let provider = json_escape(p.provider());
        let model = json_escape(p.model());
        let account = json_escape(p.account_handle());
        let reasoning = p.default_reasoning_level().as_str();
        let tp = p.tool_policy();
        let allow = tp
            .allowed()
            .map(|t| format!("\"{}\"", json_escape(t)))
            .collect::<Vec<_>>()
            .join(",");
        let deny = tp
            .denied()
            .map(|t| format!("\"{}\"", json_escape(t)))
            .collect::<Vec<_>>()
            .join(",");
        agent_strs.push(format!(
            "{{\"name\":\"{}\",\"provider\":\"{}\",\"model\":\"{}\",\"account_handle\":\"{}\",\"default_reasoning\":\"{}\",\"tool_policy\":{{\"allow\":[{}],\"deny\":[{}]}}}}",
            name, provider, model, account, reasoning, allow, deny
        ));
    }
    let data = format!("{{\"agents\":[{}]}}", agent_strs.join(","));
    CliResult::success(make_envelope(
        "agents.list",
        "ok",
        &data,
        &[],
        &[],
        "{}",
        "{}",
    ))
}

/// Read-only setup diagnostics. Capability probes report `unavailable` instead
/// of initializing auth, network, or a provider to discover them.
fn do_doctor(mode: &str) -> CliResult {
    do_doctor_at(mode, Path::new(".bran/settings.conf"), None)
}

fn do_doctor_at(mode: &str, settings_path: &Path, skill_path: Option<&Path>) -> CliResult {
    let settings = load_settings(settings_path);
    let configured = settings.as_ref().ok().and_then(Option::as_ref);
    let settings_status = match &settings {
        Ok(Some(_)) => "complete",
        Ok(None) => "not_configured",
        Err(_) => "unavailable",
    };
    let token_ceiling = configured
        .map(|value| value.connected_agent_task_token_ceiling)
        .unwrap_or(DEFAULT_CONNECTED_AGENT_TASK_TOKEN_CEILING);

    let onboarding_ready = configured.is_some();
    let agent_mode = mode == "--agent";
    let skill_available = !agent_mode || agent_skill_available(skill_path);
    let packet_available = !agent_mode || packet_round_trip_available();
    let local_setup_ready = onboarding_ready && skill_available && packet_available;
    // This build intentionally owns no connected adapter or host-attestation
    // probe. Do not turn local setup success into connected execution success.
    let connected_execution_ready = false;
    let ready = if agent_mode {
        local_setup_ready && connected_execution_ready
    } else {
        local_setup_ready
    };

    let mut warnings = Vec::new();
    if !onboarding_ready {
        warnings.push("onboarding_settings_unavailable".to_owned());
    }
    if agent_mode && !skill_available {
        warnings.push("agent_skill_unavailable".to_owned());
    }
    if agent_mode && !packet_available {
        warnings.push("packet_round_trip_unavailable".to_owned());
    }
    if agent_mode {
        warnings.push("connected_agent_runtime_unavailable".to_owned());
        warnings.push("host_attestation_unavailable".to_owned());
        warnings.push("sqz_capability_unavailable".to_owned());
    }

    let capability = |available: bool| {
        if available {
            "available"
        } else {
            "unavailable"
        }
    };
    let data = format!(
        "{{\"mode\":\"{}\",\"ready\":{},\"local_setup_ready\":{},\"connected_execution_ready\":false,\"connected_execution_status\":\"unavailable\",\"settings_status\":\"{}\",\"connected_task_total_token_ceiling\":{},\"capabilities\":{{\"cli_discovery\":\"available\",\"skill_discovery\":\"{}\",\"workspace_policy\":\"{}\",\"sqz\":\"unavailable\",\"packet_round_trip\":\"{}\",\"connected_agent_runtime\":\"unavailable\",\"host_attestation\":\"unavailable\"}},\"offline_return\":{{\"status\":\"available\",\"network_initialized\":false,\"auth_initialized\":false,\"provider_initialized\":false,\"conversation_retained\":false}}}}",
        if agent_mode { "agent" } else { "onboarding" },
        ready,
        local_setup_ready,
        settings_status,
        token_ceiling,
        if agent_mode { capability(skill_available) } else { "unavailable" },
        capability(onboarding_ready),
        if agent_mode { capability(packet_available) } else { "unavailable" },
    );
    let status = if ready { "ok" } else { "warning" };
    let output = make_envelope(
        "doctor",
        status,
        &data,
        &warnings,
        &[],
        "{\"sources\":[\"local-settings\",\"local-skill\",\"bran-core\"]}",
        "{\"provider_calls\":0,\"auth_calls\":0,\"network_calls\":0}",
    );
    CliResult {
        output,
        exit_code: if ready {
            TypedExit::Success.code()
        } else {
            TypedExit::Validation.code()
        },
        is_error: false,
        is_interactive: false,
    }
}

fn agent_skill_available(explicit: Option<&Path>) -> bool {
    explicit.is_some_and(Path::is_file)
        || std::env::var_os("BRAN_SKILL_PATH").is_some_and(|path| Path::new(&path).is_file())
        || [
            ".agents/skills/use-bran/SKILL.md",
            ".codex/skills/use-bran/SKILL.md",
            "skill/use-bran/SKILL.md",
            "bran/skill/use-bran/SKILL.md",
        ]
        .iter()
        .any(|path| Path::new(path).is_file())
}

fn packet_round_trip_available() -> bool {
    (|| -> Option<()> {
        let id = NodeId::parse("doctor.packet").ok()?;
        let node = NodeInput::new(
            id.clone(),
            NodeRole::Document,
            Provenance::new("bran-doctor", "builtin://packet").ok()?,
            Confidence::new(100).ok()?,
        );
        let graph = KnowledgeGraph::build(
            GraphInput::new(vec![node], vec![]),
            GraphLimits::new(1, 1).ok()?,
        )
        .ok()?;
        let view = ViewCompiler::new()
            .compile(
                &ViewSpec {
                    source: ViewSource::Roles(vec![NodeRole::Document]),
                    filter: ViewFilter::All,
                    sort: ViewSort::NodeId,
                    grouping: ViewGrouping::None,
                    fields: vec![ViewField::ProvenanceLocator, ViewField::NodeId],
                    presentation: Presentation::Json,
                    max_items: 1,
                    max_bytes: 4_096,
                },
                &graph,
            )
            .ok()?;
        let evidence = [EvidenceContent::new(
            id,
            "doctor packet round trip",
            EvidencePriority::Recommended,
            100,
            1,
            vec![],
        )];
        let request = PacketAssemblyRequest {
            view: &view,
            graph: &graph,
            evidence: &evidence,
            limits: PacketLimits::new(1, 4_096, None),
            dependency_limits: DependencyClosureLimits::new(1, 1).ok()?,
        };
        let packet = PacketAssembler::new().assemble(&request).ok()?;
        (packet.receipt.selected_ids.len() == 1).then_some(())
    })()
    .is_some()
}

fn parse_tools(s: &str) -> Result<ToolPolicy, String> {
    let parts: Vec<&str> = s.split(',').map(|x| x.trim()).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return Err("empty_tools".to_owned());
    }
    let mut members: Vec<String> = vec![];
    for p in parts {
        members.push(p.to_owned());
    }
    if members.is_empty() {
        return Err("empty_tools".to_owned());
    }
    if members.len() > 32 {
        return Err("too_many_tools".to_owned());
    }
    let mut seen = BTreeSet::<String>::new();
    for m in &members {
        if !seen.insert(m.clone()) {
            return Err("duplicate_tool".to_owned());
        }
        if m != "read" && m != "search" {
            return Err("denied_tool".to_owned());
        }
    }
    let deny = vec![
        "write".to_owned(),
        "edit".to_owned(),
        "shell".to_owned(),
        "network".to_owned(),
    ];
    ToolPolicy::new(members, deny).map_err(|_| "invalid_tool".to_owned())
}

fn do_headless_p(args: Vec<String>) -> CliResult {
    do_headless_p_with(args, synthetic::headless_incomplete_receipt_for)
}

fn do_headless_p_with(
    args: Vec<String>,
    execute: impl FnOnce(&DelegationRequest, bool) -> DelegationReceipt,
) -> CliResult {
    // Reject any literal credential/key flags with typed usage (no env, no secret reflection)
    for arg in &args {
        if matches!(
            arg.as_str(),
            "--api-key" | "--apikey" | "--key" | "--credential" | "--credentials"
        ) {
            return CliResult::usage(make_p_error("forbidden_credential_flag"));
        }
    }

    let mut agent: Option<String> = None;
    let mut reasoning: Option<String> = None;
    let mut tools_str: Option<String> = None;
    let mut provider: Option<String> = None;
    let mut model: Option<String> = None;
    let mut no_session = false;
    let mut offline = false;
    let mut positionals: Vec<String> = vec![];
    let mut prompt_seen = false;
    let mut i = 0usize;
    while i < args.len() {
        let arg = &args[i];
        if arg.starts_with("--") {
            if prompt_seen {
                return CliResult::usage(make_p_error("unknown_option"));
            }
            match arg.as_str() {
                "--agent" => {
                    if agent.is_some() {
                        return CliResult::usage(make_p_error("duplicate_option"));
                    }
                    i += 1;
                    if i >= args.len() || args[i].starts_with("--") {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    let val = args[i].clone();
                    if val.trim().is_empty() {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    agent = Some(val);
                }
                "--reasoning" => {
                    if reasoning.is_some() {
                        return CliResult::usage(make_p_error("duplicate_option"));
                    }
                    i += 1;
                    if i >= args.len() || args[i].starts_with("--") {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    let val = args[i].clone();
                    if val.trim().is_empty() {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    reasoning = Some(val);
                }
                "--tools" => {
                    if tools_str.is_some() {
                        return CliResult::usage(make_p_error("duplicate_option"));
                    }
                    i += 1;
                    if i >= args.len() || args[i].starts_with("--") {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    let val = args[i].clone();
                    if val.trim().is_empty() {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    tools_str = Some(val);
                }
                "--provider" => {
                    if provider.is_some() {
                        return CliResult::usage(make_p_error("duplicate_option"));
                    }
                    i += 1;
                    if i >= args.len() || args[i].starts_with("--") {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    let val = args[i].clone();
                    if val.trim().is_empty() {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    provider = Some(val);
                }
                "--model" => {
                    if model.is_some() {
                        return CliResult::usage(make_p_error("duplicate_option"));
                    }
                    i += 1;
                    if i >= args.len() || args[i].starts_with("--") {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    let val = args[i].clone();
                    if val.trim().is_empty() {
                        return CliResult::usage(make_p_error("missing_value"));
                    }
                    model = Some(val);
                }
                "--no-session" => {
                    if no_session {
                        return CliResult::usage(make_p_error("duplicate_option"));
                    }
                    no_session = true;
                }
                "--offline" => {
                    if offline {
                        return CliResult::usage(make_p_error("duplicate_option"));
                    }
                    offline = true;
                }
                _ => {
                    return CliResult::usage(make_p_error("unknown_option"));
                }
            }
        } else {
            if prompt_seen {
                return CliResult::usage(make_p_error("too_many_positional"));
            }
            positionals.push(arg.clone());
            prompt_seen = true;
        }
        i += 1;
    }

    if positionals.len() != 1 {
        return CliResult::usage(make_p_error(if positionals.is_empty() {
            "missing_prompt"
        } else {
            "too_many_positional"
        }));
    }
    let prompt = positionals.into_iter().next().unwrap();
    if prompt.trim().is_empty() {
        return CliResult::usage(make_p_error("missing_prompt"));
    }

    let agent = match agent {
        Some(a) if !a.trim().is_empty() => a,
        _ => return CliResult::usage(make_p_error("missing_agent")),
    };

    let reasoning_level = match reasoning {
        Some(r) => match ReasoningLevel::parse(&r) {
            Ok(rl) => Some(rl),
            Err(_) => return CliResult::usage(make_p_error("invalid_reasoning")),
        },
        None => None,
    };

    let tool_policy = if let Some(ts) = tools_str {
        match parse_tools(&ts) {
            Ok(p) => p,
            Err(detail) => return CliResult::usage(make_p_error(&detail)),
        }
    } else {
        ToolPolicy::read_only_default()
    };

    // Validate identities via existing core ctor.
    let mut del_opts = DelegationOptions::new();
    del_opts.provider_override = provider;
    del_opts.model_override = model;
    del_opts.reasoning_override = reasoning_level;
    del_opts.tool_policy = tool_policy;
    del_opts.no_session = no_session;

    // Validate identities via the synthetic registries (no silent fallback).
    let apr = synthetic_builtin_profiles();
    let profile = match apr.get(&agent) {
        Ok(p) => p,
        Err(_) => return CliResult::usage(make_p_error("unknown_profile")),
    };
    if del_opts
        .provider_override
        .as_deref()
        .is_some_and(|value| !apr.provider_registry().contains(value))
    {
        return CliResult::usage(make_p_error("unknown_provider"));
    }
    if let Some(model) = del_opts.model_override.as_deref() {
        let provider = del_opts
            .provider_override
            .as_deref()
            .unwrap_or(profile.provider());
        if apr
            .model_registry()
            .require_for_provider(provider, model)
            .is_err()
        {
            return CliResult::usage(make_p_error("unknown_model"));
        }
    }

    let del_req = match DelegationRequest::new(agent, prompt, del_opts) {
        Ok(request) => request,
        Err(_) => return CliResult::usage(make_p_error("invalid_identity")),
    };
    let receipt = execute(&del_req, offline);
    let receipt_json = receipt.to_json();
    let data = format!("{{\"receipt\":{}}}", receipt_json);

    if matches!(receipt.outcome(), InvocationOutcome::Complete { .. }) {
        CliResult::success(make_envelope("p", "ok", &data, &[], &[], "{}", "{}"))
    } else {
        CliResult::operation(make_envelope(
            "p",
            "error",
            &data,
            &[],
            &["runtime_incomplete".to_owned()],
            "{}",
            "{}",
        ))
    }
}

struct CliResult {
    output: String,
    exit_code: ExitCode,
    is_error: bool,
    #[cfg_attr(not(test), allow(dead_code))]
    is_interactive: bool,
}

impl CliResult {
    fn success(output: String) -> Self {
        Self {
            output,
            exit_code: TypedExit::Success.code(),
            is_error: false,
            is_interactive: false,
        }
    }

    fn usage(output: String) -> Self {
        Self {
            output,
            exit_code: TypedExit::Usage.code(),
            is_error: true,
            is_interactive: false,
        }
    }

    fn operation(output: String) -> Self {
        Self {
            output,
            exit_code: TypedExit::Operation.code(),
            is_error: true,
            is_interactive: false,
        }
    }

    fn write_to_stdio(self) -> ExitCode {
        if self.is_error {
            eprintln!("{}", self.output);
        } else {
            println!("{}", self.output);
        }
        self.exit_code
    }
}

#[cfg(test)]
mod tests {
    use super::{
        derive_bundle_from_snapshot, CliApp, ExitCode, TypedExit, MISSING_COMMAND_ERROR,
        SMOKE_OUTPUT, UNKNOWN_COMMAND_ERROR,
    };
    use bran_core::bundle::ParseStatus;
    use bran_core::metadata::MetadataReport;
    use bran_core::scan::{ContentIdentity, ScanEntry, ScanSnapshot};
    use std::sync::Arc;

    #[test]
    fn p1_cli() {
        let smoke = CliApp::run(["smoke".to_owned()]);
        assert_eq!(smoke.output, SMOKE_OUTPUT);
        assert_eq!(smoke.exit_code, ExitCode::SUCCESS);
        assert!(!smoke.is_error);

        let missing = CliApp::run(Vec::<String>::new());
        assert_eq!(missing.output, MISSING_COMMAND_ERROR);
        assert_eq!(missing.exit_code, TypedExit::Usage.code());
        assert!(missing.is_error);

        let unknown = CliApp::run(["other".to_owned()]);
        assert_eq!(unknown.output, UNKNOWN_COMMAND_ERROR);
        assert_eq!(unknown.exit_code, TypedExit::Usage.code());
        assert!(unknown.is_error);

        let extra = CliApp::run(["smoke".to_owned(), "extra".to_owned()]);
        assert_eq!(extra.output, UNKNOWN_COMMAND_ERROR);
        assert_eq!(extra.exit_code, TypedExit::Usage.code());
        assert!(extra.is_error);

        let missing_query1 = CliApp::run(vec!["query".to_owned(), "ROOT".to_owned()]);
        assert_eq!(
            missing_query1.output,
            super::make_query_error("missing_query")
        );
        assert_eq!(missing_query1.exit_code, TypedExit::Usage.code());
        assert!(missing_query1.is_error);

        let missing_query2 = CliApp::run(vec![
            "query".to_owned(),
            "ROOT".to_owned(),
            " \t".to_owned(),
        ]);
        assert_eq!(
            missing_query2.output,
            super::make_query_error("missing_query")
        );
        assert_eq!(missing_query2.exit_code, TypedExit::Usage.code());
        assert!(missing_query2.is_error);

        let missing_packet1 = CliApp::run(vec!["packet".to_owned(), "ROOT".to_owned()]);
        assert_eq!(
            missing_packet1.output,
            super::make_packet_error("missing_query")
        );
        assert_eq!(missing_packet1.exit_code, TypedExit::Usage.code());
        assert!(missing_packet1.is_error);

        let missing_packet2 = CliApp::run(vec![
            "packet".to_owned(),
            "ROOT".to_owned(),
            " \t".to_owned(),
        ]);
        assert_eq!(
            missing_packet2.output,
            super::make_packet_error("missing_query")
        );
        assert_eq!(missing_packet2.exit_code, TypedExit::Usage.code());
        assert!(missing_packet2.is_error);

        let source = "---\ntype: [\n---\nbody\n";
        let mut snapshot = ScanSnapshot::default();
        snapshot.entries.insert(
            "doc.md".to_owned(),
            Arc::new(ScanEntry {
                identity: ContentIdentity::from_bytes(source.as_bytes()),
                source: Arc::from(source.as_bytes()),
                metadata: MetadataReport {
                    warnings: vec!["malformed-metadata: invalid yaml".to_owned()],
                    ..MetadataReport::default()
                },
            }),
        );
        let bundle = derive_bundle_from_snapshot(&snapshot).expect("valid bundle");
        let frontmatter = bundle.docs().get("doc.md").expect("document").frontmatter();
        assert_eq!(frontmatter.raw(), "---\ntype: [\n---\n");
        assert!(
            matches!(frontmatter.status(), ParseStatus::Malformed { reason } if reason == "invalid yaml")
        );
        assert_eq!(frontmatter.parsed(), None);

        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let non_utf8 = CliApp::run([std::ffi::OsString::from_vec(vec![0xff])]);
            assert_eq!(non_utf8.output, UNKNOWN_COMMAND_ERROR);
            assert_eq!(non_utf8.exit_code, TypedExit::Usage.code());
            assert!(non_utf8.is_error);
        }
    }

    #[test]
    fn p3_headless_cli() {
        // One sequential stdlib-temp-dir journey. No tables, no other names.
        let base = std::env::temp_dir();
        let unique = format!(
            "bran-p3-headless-cli-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = base.join(&unique);
        std::fs::create_dir_all(&root).expect("temp root");

        let tgt = "repl.txt".to_owned();
        let rep = "p3-replacement-bytes-exact\n".to_owned();
        let proot = root.to_string_lossy().into_owned();

        let seed_document = "---\ntype: concept\ntitle: Seed\nokf_status: active\ntags: p3\ntags: packet\ntimestamp: 2026-07-19T00:00:00Z\nresource: test://seed\npublic_boundary: safe\ndependency: dep.md\n---\nseed [dependency](dep.md)\n# Citations\nref\n";
        let dependency_document = "---\ntype: concept\ntitle: Dep\nokf_status: active\ntags: p3\ntags: packet\ntimestamp: 2026-07-19T00:00:00Z\nresource: test://dep\npublic_boundary: safe\n---\ndep [reference](x)\n# Citations\nref\n";
        std::fs::write(root.join("seed.md"), seed_document.as_bytes()).unwrap();
        std::fs::write(root.join("dep.md"), dependency_document.as_bytes()).unwrap();

        // Slice 5.4 extends this existing setup journey: both doctors are
        // read-only, and agent readiness is based on a real packet result.
        let settings_path = base.join(format!("{unique}-settings.conf"));
        bran_tui::apply_settings(&settings_path, &bran_tui::quick_safe_config()).unwrap();
        let skill_path = base.join(format!("{unique}-SKILL.md"));
        std::fs::write(&skill_path, "# local agent skill\n").unwrap();
        let onboarding_doctor =
            super::do_doctor_at("--onboarding", &settings_path, Some(&skill_path));
        assert_eq!(onboarding_doctor.exit_code, ExitCode::SUCCESS);
        assert!(onboarding_doctor.output.contains("\"ready\":true"));
        assert!(onboarding_doctor
            .output
            .contains("\"connected_task_total_token_ceiling\":8500"));
        let agent_doctor = super::do_doctor_at("--agent", &settings_path, Some(&skill_path));
        assert_eq!(agent_doctor.exit_code, TypedExit::Validation.code());
        assert!(agent_doctor.output.contains("\"ready\":false"));
        assert!(agent_doctor.output.contains("\"local_setup_ready\":true"));
        assert!(agent_doctor
            .output
            .contains("\"connected_execution_status\":\"unavailable\""));
        assert!(agent_doctor
            .output
            .contains("\"packet_round_trip\":\"available\""));
        assert!(agent_doctor
            .output
            .contains("\"host_attestation\":\"unavailable\""));
        assert!(agent_doctor.output.contains("\"provider_calls\":0"));

        let packet_result =
            CliApp::run(vec!["packet".to_owned(), proot.clone(), "seed".to_owned()]);
        assert_eq!(packet_result.exit_code, ExitCode::SUCCESS);
        assert!(!packet_result.is_error);
        assert!(
            packet_result.output.contains("\"command\":\"packet\"")
                && packet_result.output.contains("\"status\":\"ok\"")
        );
        assert!(packet_result
            .output
            .contains("\"selected_locators\":[\"seed.md\"]"));
        assert!(packet_result
            .output
            .contains("\"seed_ids\":[\"n:7:a346da01e22eda4be56ecdeffc2f0bb4ce2004c4de8549ed\"]"));
        assert!(packet_result
            .output
            .contains("\"admitted_dependency_ids\":[\"n:6:64eee9fc1a415ae7ee3cea2af4c15b15206bc0d26c8ca9fb\"]"));
        assert!(packet_result
            .output
            .contains("\"selected_ids\":[\"n:6:64eee9fc1a415ae7ee3cea2af4c15b15206bc0d26c8ca9fb\",\"n:7:a346da01e22eda4be56ecdeffc2f0bb4ce2004c4de8549ed\"]"));

        // proposal zero mutation
        let pres = CliApp::run(vec![
            "maintain".to_owned(),
            "propose".to_owned(),
            proot.clone(),
            tgt.clone(),
            rep.clone(),
        ]);
        assert!(pres.output.contains("\"command\":\"maintain.propose\""));
        assert!(pres.output.contains("\"status\":\"ok\""));
        assert_eq!(pres.exit_code, ExitCode::SUCCESS);
        assert!(!pres.is_error);
        assert!(!root.join(&tgt).exists(), "propose must zero-mutate");
        let key = "\"digest\":\"";
        let start = pres.output.find(key).expect("propose returns digest") + key.len();
        let dig = pres.output[start..]
            .split('"')
            .next()
            .expect("digest terminator")
            .to_owned();

        // missing marker refusal (code 2, no mutation)
        let miss = CliApp::run(vec![
            "maintain".to_owned(),
            "apply".to_owned(),
            proot.clone(),
            tgt.clone(),
            rep.clone(),
            dig.clone(),
            "auth".to_owned(),
        ]);
        assert!(miss.output.contains("missing_fixture_authority_marker"));
        assert_eq!(miss.exit_code, TypedExit::Usage.code());
        assert!(miss.is_error);
        assert!(!root.join(&tgt).exists());

        // prepare marker + valid strict doc (one dir sequential)
        std::fs::write(
            root.join(".bran-fixture-authority"),
            b"bran-cli-fixture-v1\n",
        )
        .unwrap();
        let valid_doc = "---\ntype: concept\ntitle: P3 Headless\nokf_status: active\ntags: p3\ntags: headless\ntimestamp: 2026-07-19T00:00:00Z\nresource: test://p3\npublic_boundary: safe\n---\nBody [link](x).\n# Citations\nref\n";
        std::fs::write(root.join("p3.md"), valid_doc.as_bytes()).unwrap();

        let stale_target = "stale.txt".to_owned();
        std::fs::write(root.join(&stale_target), b"initial-source-at-propose\n").unwrap();
        let stale_proposal = CliApp::run(vec![
            "maintain".to_owned(),
            "propose".to_owned(),
            proot.clone(),
            stale_target.clone(),
            "stale-replacement\n".to_owned(),
        ]);
        assert!(stale_proposal.output.contains("\"status\":\"ok\""));
        let digest_key = "\"digest\":\"";
        let stale_digest_start = stale_proposal
            .output
            .find(digest_key)
            .expect("stale propose digest")
            + digest_key.len();
        let stale_digest = stale_proposal.output[stale_digest_start..]
            .split('"')
            .next()
            .expect("digest terminator")
            .to_owned();
        std::fs::write(root.join(&stale_target), b"changed-source-after-propose\n").unwrap();
        let stale_apply = CliApp::run(vec![
            "maintain".to_owned(),
            "apply".to_owned(),
            proot.clone(),
            stale_target.clone(),
            "stale-replacement\n".to_owned(),
            stale_digest.clone(),
            "bran-cli-fixture-v1".to_owned(),
        ]);
        assert!(stale_apply.output.contains("stale_source"));
        assert!(!stale_apply.output.contains("digest_mismatch"));
        assert_eq!(stale_apply.exit_code, TypedExit::Operation.code());
        assert!(stale_apply.is_error);
        assert_eq!(
            std::fs::read(root.join(&stale_target)).unwrap(),
            b"changed-source-after-propose\n"
        );

        let malformed_digest = format!("{}|s:", stale_digest.rsplit_once("|s:").unwrap().0);
        let malformed_apply = CliApp::run(vec![
            "maintain".to_owned(),
            "apply".to_owned(),
            proot.clone(),
            stale_target,
            "stale-replacement\n".to_owned(),
            malformed_digest,
            "bran-cli-fixture-v1".to_owned(),
        ]);
        assert!(malformed_apply.output.contains("digest_mismatch"));
        assert!(!malformed_apply.output.contains("stale_source"));
        assert_eq!(malformed_apply.exit_code, TypedExit::Usage.code());

        let malformed_nonempty_digest =
            format!("{}|s:junk", stale_digest.rsplit_once("|s:").unwrap().0);
        let malformed_nonempty_apply = CliApp::run(vec![
            "maintain".to_owned(),
            "apply".to_owned(),
            proot.clone(),
            "stale.txt".to_owned(),
            "stale-replacement\n".to_owned(),
            malformed_nonempty_digest,
            "bran-cli-fixture-v1".to_owned(),
        ]);
        assert!(malformed_nonempty_apply.output.contains("digest_mismatch"));
        assert!(!malformed_nonempty_apply.output.contains("stale_source"));
        assert_eq!(malformed_nonempty_apply.exit_code, TypedExit::Usage.code());

        // bad digest refusal (code 2, no mutation)
        let badd = CliApp::run(vec![
            "maintain".to_owned(),
            "apply".to_owned(),
            proot.clone(),
            tgt.clone(),
            rep.clone(),
            "bad-digest-not-match".to_owned(),
            "auth".to_owned(),
        ]);
        assert!(badd.output.contains("digest_mismatch"));
        assert_eq!(badd.exit_code, TypedExit::Usage.code());
        assert!(badd.is_error);
        assert!(!root.join(&tgt).exists());

        // authorized exact-digest apply writes and returns validation-passed receipt (0)
        let app = CliApp::run(vec![
            "maintain".to_owned(),
            "apply".to_owned(),
            proot.clone(),
            tgt.clone(),
            rep.clone(),
            dig.clone(),
            "bran-cli-fixture-v1".to_owned(),
        ]);
        assert_eq!(app.exit_code, ExitCode::SUCCESS);
        assert!(!app.is_error);
        assert!(app.output.contains("\"command\":\"maintain.apply\""));
        assert!(app.output.contains("\"status\":\"ok\""));
        assert!(app
            .output
            .contains("proposed -> applied -> validation-passed"));
        assert!(app
            .output
            .contains(&format!("\"proposal_digest\":\"{}\"", dig)));
        assert!(root.join(&tgt).exists());
        let ondisk = std::fs::read(root.join(&tgt)).unwrap();
        assert_eq!(ondisk, rep.as_bytes());

        // revalidate succeeds
        let rev = CliApp::run(vec![
            "maintain".to_owned(),
            "revalidate".to_owned(),
            proot.clone(),
        ]);
        assert_eq!(rev.exit_code, ExitCode::SUCCESS);
        assert!(!rev.is_error);
        assert!(rev.output.contains("\"command\":\"maintain.revalidate\""));
        assert!(rev.output.contains("\"status\":\"ok\""));

        // p3_headless_cli extension only (no new test/table): headless identical under t/f;
        // exact tui interactive success; non-tty tui unavailable; usage remains noninteractive.
        let s1 = super::CliApp::run_for_terminal(vec!["smoke".to_owned()], true);
        let s2 = super::CliApp::run_for_terminal(vec!["smoke".to_owned()], false);
        assert_eq!(s1.output, s2.output);
        assert_eq!(s1.exit_code, s2.exit_code);
        assert_eq!(s1.is_error, s2.is_error);
        assert!(!s1.is_interactive && !s2.is_interactive);
        let tu = super::CliApp::run_for_terminal(vec!["tui".to_owned()], true);
        assert!(tu.output.is_empty());
        assert!(tu.is_interactive);
        assert_eq!(tu.exit_code, ExitCode::SUCCESS);
        assert!(!tu.is_error);
        let tui_non_tty = super::CliApp::run_for_terminal(vec!["tui".to_owned()], false);
        assert!(tui_non_tty.output.contains("\"command\":\"tui\""));
        assert!(tui_non_tty.output.contains("\"status\":\"error\""));
        assert!(tui_non_tty.output.contains("tui_unavailable_non_tty"));
        assert_eq!(tui_non_tty.exit_code, TypedExit::Operation.code());
        assert!(tui_non_tty.is_error);
        assert!(!tui_non_tty.is_interactive);
        let tui_extra =
            super::CliApp::run_for_terminal(vec!["tui".to_owned(), "extra".to_owned()], true);
        assert_eq!(tui_extra.exit_code, TypedExit::Usage.code());
        assert!(tui_extra.is_error);
        assert!(!tui_extra.is_interactive);
        assert!(matches!(
            super::map_key(
                crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Char('q'),
                    crossterm::event::KeyModifiers::NONE
                ),
                true
            ),
            Some(bran_tui::TuiEvent::Quit)
        ));
        assert!(matches!(
            super::map_key(
                crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Char('q'),
                    crossterm::event::KeyModifiers::NONE
                ),
                false
            ),
            Some(bran_tui::TuiEvent::Input('q'))
        ));
        let mut tui_app = bran_tui::TuiApp::default();
        tui_app.update_suggestions(super::tui_candidates(&tui_app));
        assert!(!tui_app.suggestions.is_empty());
        tui_app.step = bran_tui::OnboardingStep::Guardrails;
        tui_app.input = "tokens=".to_owned();
        tui_app.update_suggestions(super::tui_candidates(&tui_app));
        assert!(tui_app.suggestions.contains(&"tokens=8500".to_owned()));
        tui_app.handle(bran_tui::TuiEvent::Resize { columns: 40 });
        assert_eq!(tui_app.columns, Some(40));
        let r1 = super::CliApp::run_for_terminal(
            vec![
                "maintain".to_owned(),
                "revalidate".to_owned(),
                proot.clone(),
            ],
            true,
        );
        let r2 = super::CliApp::run_for_terminal(
            vec![
                "maintain".to_owned(),
                "revalidate".to_owned(),
                proot.clone(),
            ],
            false,
        );
        assert_eq!(r1.output, r2.output);
        assert!(!r1.is_interactive && !r2.is_interactive);

        let skill = include_str!("../../../skill/use-bran/SKILL.md");
        let readme = include_str!("../../../examples/headless/README.md");
        let pins_forms = |artifact: &str| {
            artifact.contains("bran packet <repo-root> \"<request>\"")
                && artifact.contains("bran query <repo-root> \"<request>\"")
                && artifact.contains("bran check <repo-root> <profile>")
                && artifact.contains("bran maintain propose <repo-root> <target> <replacement>")
                && artifact.contains(
                    "bran maintain apply <repo-root> <target> <replacement> <digest> <authority>",
                )
                && artifact.contains("bran maintain revalidate <repo-root>")
        };
        let is_public = |artifact: &str| {
            let lower = artifact.to_ascii_lowercase();
            !lower.contains("openai")
                && !lower.contains("codex")
                && !lower.contains("devpost")
                && !lower.contains("gpt")
                && !lower.contains("grok")
                && !lower.contains("terra")
                && !lower.contains("luna")
                && !lower.contains("sol")
                && !lower.contains("alphazede")
        };
        assert!(pins_forms(skill) && pins_forms(readme));
        assert!(is_public(skill) && is_public(readme));
        assert!(skill.contains("Run the packet command before broad repository search"));
        assert!(skill.contains("retain and report `provenance`, and report `metrics`"));
        assert!(
            skill.contains("actual model tokens as unavailable")
                && skill.contains("bytes-divided-by-four-ceiling` count as an estimate")
                && skill.contains("current `packet` command does not invoke SQZ")
        );
        assert!(skill.contains("bounded `git`, `rg`, or language-tool evidence")
            && skill.contains("Never fabricate BRAN results, provenance, metrics, compression, savings, or token counts"));

        // Slice 3.4 p-headless asserts only (compact, inside existing test, zero new test names)
        let ex1 = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "tell me about bran".to_owned(),
        ]);
        assert!(
            ex1.output.contains("\"command\":\"p\"") && ex1.output.contains("\"status\":\"error\"")
        );
        assert!(
            ex1.output.contains("runtime_incomplete")
                && ex1.output.contains("bran-agent-receipt-v1")
        );
        assert!(ex1.output.contains("\"profile_name\":\"sol\""));
        // real runtime disabled path yields unavailable in non-overridden requested; overrides preserved when passed
        assert!(ex1.output.contains("unavailable"));
        assert!(
            ex1.output.contains("\"effective\"")
                && ex1.output.contains("unavailable")
                && ex1.output.contains("\"receipt\":")
        );
        assert_eq!(ex1.exit_code, TypedExit::Operation.code());
        assert!(ex1.is_error);
        let ex2 = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "luna".to_owned(),
            "--reasoning".to_owned(),
            "medium".to_owned(),
            "--tools".to_owned(),
            "read,search".to_owned(),
            "--no-session".to_owned(),
            "--provider".to_owned(),
            "fixture-provider".to_owned(),
            "--model".to_owned(),
            "fixture-luna".to_owned(),
            "q".to_owned(),
        ]);
        assert!(ex2.output.contains("\"no_session\":true") && ex2.output.contains("medium"));
        assert!(
            ex2.output.contains("\"profile_name\":\"luna\"")
                && ex2.output.contains("runtime_incomplete")
        );
        // exact reasoning rejection
        let bad_r = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--reasoning".to_owned(),
            "Medium".to_owned(),
            "hi".to_owned(),
        ]);
        assert!(bad_r.output.contains("invalid_reasoning"));
        assert_eq!(bad_r.exit_code, TypedExit::Usage.code());
        // denied tool rejection
        let bad_t = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--tools".to_owned(),
            "read,write".to_owned(),
            "hi".to_owned(),
        ]);
        assert!(bad_t.output.contains("denied_tool"));
        assert_eq!(bad_t.exit_code, TypedExit::Usage.code());
        let empty_t = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--tools".to_owned(),
            "read,,search".to_owned(),
            "hi".to_owned(),
        ]);
        assert!(empty_t.output.contains("empty_tools"));
        assert_eq!(empty_t.exit_code, TypedExit::Usage.code());
        let bad_profile = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "nova".to_owned(),
            "hi".to_owned(),
        ]);
        assert!(bad_profile.output.contains("unknown_profile"));
        let bad_provider = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--provider".to_owned(),
            "other-provider".to_owned(),
            "hi".to_owned(),
        ]);
        assert!(bad_provider.output.contains("unknown_provider"));
        let bad_model = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--model".to_owned(),
            "other-model".to_owned(),
            "hi".to_owned(),
        ]);
        assert!(bad_model.output.contains("unknown_model"));
        // missing agent/prompt
        let miss_a = CliApp::run(vec!["-p".to_owned(), "justprompt".to_owned()]);
        assert!(miss_a.output.contains("missing_agent"));
        let miss_p = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
        ]);
        assert!(miss_p.output.contains("missing_prompt"));
        // unknown/duplicate option
        let unk = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--xyz".to_owned(),
            "hi".to_owned(),
        ]);
        assert!(unk.output.contains("unknown_option"));
        let dup = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--agent".to_owned(),
            "luna".to_owned(),
            "hi".to_owned(),
        ]);
        assert!(dup.output.contains("duplicate_option"));
        // no-session receipt + missing value
        let ns = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--no-session".to_owned(),
            "q".to_owned(),
        ]);
        assert!(ns.output.contains("\"no_session\":true"));
        let mv = CliApp::run(vec!["-p".to_owned(), "--agent".to_owned()]);
        assert!(mv.output.contains("missing_value"));

        let conn = super::do_headless_p_with(
            vec![
                "--agent".to_owned(),
                "sol".to_owned(),
                "sol-connected-exact".to_owned(),
            ],
            |request, _| bran_core::agent::synthetic::connected_receipt_for(request, true),
        );
        assert!(
            conn.output.contains("\"command\":\"p\"") && conn.output.contains("\"status\":\"ok\"")
        );
        assert_eq!(conn.exit_code, TypedExit::Success.code());
        assert!(!conn.is_error);
        assert!(conn.output.contains("\"state\":\"complete\""));
        assert!(conn.output.contains("\"profile_name\":\"sol\""));
        assert!(conn.output.contains("\"value\":\"fixture-sol\""));
        assert!(!conn.output.contains("sol-connected-exact")); // canonical omits original prompt

        let unatt = super::do_headless_p_with(
            vec![
                "--agent".to_owned(),
                "luna".to_owned(),
                "--provider".to_owned(),
                "fixture-provider".to_owned(),
                "--model".to_owned(),
                "fixture-luna".to_owned(),
                "--reasoning".to_owned(),
                "medium".to_owned(),
                "luna-unatt".to_owned(),
            ],
            |request, _| bran_core::agent::synthetic::connected_receipt_for(request, false),
        );
        assert!(unatt.output.contains("\"status\":\"ok\""));
        assert_eq!(unatt.exit_code, TypedExit::Success.code());
        assert!(unatt.output.contains("\"profile_name\":\"luna\""));
        assert!(unatt.output.contains("\"value\":\"fixture-luna\""));
        assert!(unatt.output.contains("\"value\":\"medium\""));
        assert!(unatt.output.contains("unavailable"));
        assert!(!unatt.output.contains("luna-unatt"));

        let off = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--offline".to_owned(),
            "off-prompt".to_owned(),
        ]);
        assert!(off.output.contains("explicit_offline"));
        assert_eq!(off.exit_code, TypedExit::Operation.code());
        assert!(off.is_error);
        assert!(!off.output.contains("off-prompt"));

        // absence of secret material (and no credential reflection)
        let sec = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "secret api-key credential".to_owned(),
        ]);
        let slow = sec.output.to_ascii_lowercase();
        assert!(
            !slow.contains("key")
                && !slow.contains("credential")
                && !slow.contains("secret")
                && !slow.contains("api-key")
        );
        let forbidden = CliApp::run(vec![
            "-p".to_owned(),
            "--agent".to_owned(),
            "sol".to_owned(),
            "--credentials".to_owned(),
            "hi".to_owned(),
        ]);
        assert!(forbidden.output.contains("forbidden_credential_flag"));
        std::fs::remove_file(settings_path).unwrap();
        std::fs::remove_file(skill_path).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
