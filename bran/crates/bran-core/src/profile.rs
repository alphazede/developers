//! Profile validation for OKF v0.1 compatibility and BRAN Strict readiness (Slice 1.2).
//!
//! One call to ProfileValidator produces independent outcomes for both profiles.
//! The selected profile alone governs success/exit; both results remain visible.
//! No source mutation. No link target resolution. Unknown fields and broken links tolerated
//! per the OKF v0.1 floor and approved BRAN contract.

use crate::bundle::{Bundle, DocKind, ParseStatus};
use crate::schema::YamlValue;
use std::collections::BTreeMap;

/// Stable identifier for the OKF v0.1 compatibility profile.
pub const OKF_V0_1: &str = "okf-v0.1";

/// Stable identifier for the BRAN Strict readiness profile.
pub const BRAN_STRICT: &str = "bran-strict";

/// A single deterministic diagnostic entry.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct Diagnostic {
    pub path: String,
    pub code: String,
    pub message: String,
}

/// Pass or Fail status for a profile outcome.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum ValidationStatus {
    Pass,
    Fail,
}

/// Outcome for one profile. Diagnostics are always in deterministic order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileOutcome {
    pub profile: String,
    pub status: ValidationStatus,
    pub diagnostics: Vec<Diagnostic>,
}

/// Dual-profile validation result. Both outcomes are always computed.
/// Only `selected_profile` decides `selected_passed` and `exit_code`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationResult {
    pub okf_compatibility: ProfileOutcome,
    pub bran_strict: ProfileOutcome,
    pub selected_profile: String,
    /// Explicit selection failure, if the caller named an unsupported profile.
    /// Profile outcomes are still present so callers can inspect both results.
    pub selected_profile_error: Option<Diagnostic>,
}

impl ValidationResult {
    /// True only when the selected profile reports Pass.
    /// Unknown selected profile yields false (no panic).
    pub fn selected_passed(&self) -> bool {
        let outcome = match self.selected_profile.as_str() {
            OKF_V0_1 => &self.okf_compatibility,
            BRAN_STRICT => &self.bran_strict,
            _ => return false,
        };
        outcome.status == ValidationStatus::Pass
    }

    /// Explicit exit code for selected profile: 0 on pass, 1 on fail.
    /// Suitable for future CLI integration. Never panics.
    pub fn exit_code(&self) -> i32 {
        if self.selected_passed() {
            0
        } else {
            1
        }
    }
}

/// Owns all profile validation. Stateless.
pub struct ProfileValidator;

impl ProfileValidator {
    /// Validates the bundle for both profiles independently.
    ///
    /// - OKF v0.1 compatibility: requires parseable frontmatter + non-blank string `type`
    ///   only on concept documents. Reserved index.md / log.md carry no such requirement.
    ///   Unknown fields, unknown types, and broken links are tolerated.
    ///
    /// - BRAN Strict: additive field-shape and readiness diagnostics across
    ///   title/status/tag, freshness/authority, citation/source, relationship,
    ///   and public-boundary categories. No source is rewritten. Link targets
    ///   are never validated (permitted broken links from upstream).
    ///
    /// The returned structure always contains both outcomes. Only the
    /// supplied selected_profile controls the overall pass/exit decision.
    pub fn validate(bundle: &Bundle, selected_profile: &str) -> ValidationResult {
        let okf = Self::validate_okf_compatibility(bundle);
        let strict = Self::validate_bran_strict(bundle);
        ValidationResult {
            okf_compatibility: okf,
            bran_strict: strict,
            selected_profile: selected_profile.to_owned(),
            selected_profile_error: match selected_profile {
                OKF_V0_1 | BRAN_STRICT => None,
                _ => Some(Diagnostic {
                    path: "<selection>".to_owned(),
                    code: "unknown-profile".to_owned(),
                    message: format!("unknown validation profile: {selected_profile}"),
                }),
            },
        }
    }

    fn validate_okf_compatibility(bundle: &Bundle) -> ProfileOutcome {
        let mut diagnostics: Vec<Diagnostic> = Vec::new();

        // Iteration over BTreeMap yields lexical path order -> deterministic.
        for (path, doc) in bundle.docs() {
            if matches!(doc.kind(), DocKind::Index | DocKind::Log) {
                continue;
            }
            let fm = doc.frontmatter();
            if let Some(diagnostic) = okf_diagnostic(path, fm.status(), fm.parsed()) {
                diagnostics.push(diagnostic);
            }
        }

        let status = if diagnostics.is_empty() {
            ValidationStatus::Pass
        } else {
            ValidationStatus::Fail
        };
        ProfileOutcome {
            profile: OKF_V0_1.to_owned(),
            status,
            diagnostics,
        }
    }

    fn validate_bran_strict(bundle: &Bundle) -> ProfileOutcome {
        let mut diagnostics: Vec<Diagnostic> = Vec::new();

        for (path, doc) in bundle.docs() {
            if matches!(doc.kind(), DocKind::Index | DocKind::Log) {
                continue;
            }
            let fm = doc.frontmatter();
            if let Some(diagnostic) = okf_diagnostic(path, fm.status(), fm.parsed()) {
                diagnostics.push(diagnostic);
            }
            let map = match fm.parsed() {
                Some(m) => m,
                None => continue,
            };

            // title (shape)
            if !has_nonblank_string(map, "title") {
                diagnostics.push(Diagnostic {
                    path: path.clone(),
                    code: "title".to_owned(),
                    message: "title must be a non-blank string for BRAN strict".to_owned(),
                });
            }

            // status (okf_status values)
            if !has_valid_okf_status(map) {
                diagnostics.push(Diagnostic {
                    path: path.clone(),
                    code: "status".to_owned(),
                    message: "okf_status must be one of draft/active/deprecated for BRAN strict"
                        .to_owned(),
                });
            }

            // tag
            if !has_tags_sequence(map) {
                diagnostics.push(Diagnostic {
                    path: path.clone(),
                    code: "tag".to_owned(),
                    message: "tags must be a YAML sequence for BRAN strict".to_owned(),
                });
            }

            // freshness
            if !has_nonblank_string(map, "timestamp") && !has_nonblank_string(map, "freshness") {
                diagnostics.push(Diagnostic {
                    path: path.clone(),
                    code: "freshness".to_owned(),
                    message: "freshness requires timestamp or freshness field (non-blank string)"
                        .to_owned(),
                });
            }

            // authority/source (resource field)
            if !has_nonblank_string(map, "resource") {
                diagnostics.push(Diagnostic {
                    path: path.clone(),
                    code: "authority".to_owned(),
                    message: "authority/source requires resource field (non-blank string)"
                        .to_owned(),
                });
            }

            // citation/source
            let has_citation = doc.body().contains("# Citations")
                || doc.body().contains("Citations:")
                || doc.body().contains("[1]");
            if !has_nonblank_string(map, "resource") && !has_citation {
                diagnostics.push(Diagnostic {
                    path: path.clone(),
                    code: "citation-source".to_owned(),
                    message: "citation/source requires resource or # Citations evidence".to_owned(),
                });
            }

            // relationship (presence of link syntax; targets never validated)
            if !has_relationship_links(doc.body()) {
                diagnostics.push(Diagnostic {
                    path: path.clone(),
                    code: "relationship".to_owned(),
                    message:
                        "relationship requires at least one markdown link (targets unvalidated)"
                            .to_owned(),
                });
            }

            // public-boundary
            if !has_nonblank_string(map, "public_boundary") {
                diagnostics.push(Diagnostic {
                    path: path.clone(),
                    code: "public-boundary".to_owned(),
                    message: "public-boundary requires public_boundary field (non-blank string)"
                        .to_owned(),
                });
            }
        }

        let status = if diagnostics.is_empty() {
            ValidationStatus::Pass
        } else {
            ValidationStatus::Fail
        };
        ProfileOutcome {
            profile: BRAN_STRICT.to_owned(),
            status,
            diagnostics,
        }
    }
}

fn okf_diagnostic(
    path: &str,
    status: &ParseStatus,
    map: Option<&BTreeMap<String, YamlValue>>,
) -> Option<Diagnostic> {
    if !status.is_ok() {
        let reason = match status {
            ParseStatus::Malformed { reason } => reason,
            ParseStatus::Ok => unreachable!("successful status already returned"),
        };
        return Some(Diagnostic {
            path: path.to_owned(),
            code: "malformed-frontmatter".to_owned(),
            message: if reason.is_empty() {
                "malformed concept frontmatter".to_owned()
            } else {
                format!("malformed concept frontmatter: {reason}")
            },
        });
    }

    match map.and_then(|frontmatter| frontmatter.get("type")) {
        Some(YamlValue::String(value)) if !value.trim().is_empty() => None,
        Some(YamlValue::String(_)) => Some(Diagnostic {
            path: path.to_owned(),
            code: "blank-type".to_owned(),
            message: "type must be a non-blank string".to_owned(),
        }),
        Some(_) => Some(Diagnostic {
            path: path.to_owned(),
            code: "non-string-type".to_owned(),
            message: "type must be a string".to_owned(),
        }),
        None => Some(Diagnostic {
            path: path.to_owned(),
            code: "missing-type".to_owned(),
            message: "frontmatter must contain a non-empty type field".to_owned(),
        }),
    }
}

fn has_nonblank_string(map: &BTreeMap<String, YamlValue>, key: &str) -> bool {
    matches!(map.get(key), Some(YamlValue::String(s)) if !s.trim().is_empty())
}

fn has_valid_okf_status(map: &BTreeMap<String, YamlValue>) -> bool {
    matches!(
        map.get("okf_status"),
        Some(YamlValue::String(s)) if matches!(s.as_str(), "draft" | "active" | "deprecated")
    )
}

fn has_tags_sequence(map: &BTreeMap<String, YamlValue>) -> bool {
    matches!(map.get("tags"), Some(YamlValue::Sequence(_)))
}

fn has_relationship_links(body: &str) -> bool {
    // Detect link syntax expressing relationships. Explicitly do not resolve or
    // validate targets: upstream OKF tolerates broken links; graph scope is later.
    body.contains("](")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::{Bundle, Doc, Frontmatter};
    use crate::schema::YamlValue;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;

    fn concept(path: &str, fm: Frontmatter, body: &str) -> Doc {
        let src = format!("---\nxx\n---\n{}", body);
        Doc::new(path, src, body.to_owned(), fm)
    }

    fn idx(path: &str) -> Doc {
        Doc::new(path, "idx-body", "", Frontmatter::empty())
    }

    fn log(path: &str) -> Doc {
        Doc::new(path, "log-body", "", Frontmatter::empty())
    }

    #[test]
    fn upstream_minimal_okf_pass_strict_fail() {
        let mut m = BTreeMap::new();
        m.insert(
            "type".to_owned(),
            YamlValue::String("BigQuery Dataset".to_owned()),
        );
        let fm = Frontmatter::from_parsed("---\ntype: BigQuery Dataset\n---", m);
        let doc = concept("datasets/foo.md", fm, "Minimal body text.");
        let bundle = Bundle::from_documents([doc]).expect("bundle");

        let r = ProfileValidator::validate(&bundle, OKF_V0_1);
        assert_eq!(r.okf_compatibility.status, ValidationStatus::Pass);
        assert!(r.okf_compatibility.diagnostics.is_empty());
        assert_eq!(r.bran_strict.status, ValidationStatus::Fail);
        assert!(!r.bran_strict.diagnostics.is_empty());
        assert!(r.bran_strict.diagnostics.iter().any(|d| d.code == "title"));
        assert!(r.bran_strict.diagnostics.iter().any(|d| d.code == "status"));
        assert!(r.bran_strict.diagnostics.iter().any(|d| d.code == "tag"));
        assert!(r.selected_passed());
        assert_eq!(r.exit_code(), 0);

        // dual visible
        assert_eq!(r.okf_compatibility.profile, OKF_V0_1);
        assert_eq!(r.bran_strict.profile, BRAN_STRICT);

        let r_strict_sel = ProfileValidator::validate(&bundle, BRAN_STRICT);
        assert!(!r_strict_sel.selected_passed());
        assert_eq!(r_strict_sel.exit_code(), 1);
        // non-selected still visible and unchanged
        assert_eq!(
            r_strict_sel.okf_compatibility.status,
            ValidationStatus::Pass
        );
    }

    #[test]
    fn fully_strict_ready_pass_both_profiles() {
        let mut m = BTreeMap::new();
        m.insert("type".to_owned(), YamlValue::String("Metric".to_owned()));
        m.insert(
            "title".to_owned(),
            YamlValue::String("Foo Metric".to_owned()),
        );
        m.insert(
            "okf_status".to_owned(),
            YamlValue::String("active".to_owned()),
        );
        m.insert(
            "tags".to_owned(),
            YamlValue::Sequence(vec![YamlValue::String("metrics".to_owned())]),
        );
        m.insert(
            "timestamp".to_owned(),
            YamlValue::String("2026-07-18T12:00:00Z".to_owned()),
        );
        m.insert(
            "resource".to_owned(),
            YamlValue::String("https://example.com/metric/foo".to_owned()),
        );
        m.insert(
            "public_boundary".to_owned(),
            YamlValue::String("public".to_owned()),
        );
        let body = "Intro.\n\nSee [related](/concepts/bar.md).\n\n# Citations\n\n[1] Source data.";
        let fm = Frontmatter::from_parsed("raw", m);
        let doc = concept("metrics/foo.md", fm, body);
        let bundle = Bundle::from_documents([doc]).expect("bundle");

        let r = ProfileValidator::validate(&bundle, BRAN_STRICT);
        assert_eq!(r.bran_strict.status, ValidationStatus::Pass);
        assert!(r.bran_strict.diagnostics.is_empty());
        assert!(r.selected_passed());
        assert_eq!(r.exit_code(), 0);

        // also okf passes
        assert_eq!(r.okf_compatibility.status, ValidationStatus::Pass);
    }

    #[test]
    fn malformed_frontmatter_rejected_for_okf_on_concepts() {
        let fm = Frontmatter::malformed("---\n: bad\n---", "unexpected token");
        let doc = concept("bad.md", fm, "body");
        let bundle = Bundle::from_documents([doc]).expect("bundle");

        let r = ProfileValidator::validate(&bundle, OKF_V0_1);
        assert_eq!(r.okf_compatibility.status, ValidationStatus::Fail);
        assert_eq!(r.okf_compatibility.diagnostics.len(), 1);
        assert_eq!(
            r.okf_compatibility.diagnostics[0].code,
            "malformed-frontmatter"
        );
        assert!(r.okf_compatibility.diagnostics[0]
            .message
            .contains("malformed"));
    }

    #[test]
    fn unknown_fields_preserved_and_non_mutating() {
        let mut inner = BTreeMap::new();
        inner.insert("deep".to_owned(), YamlValue::Bool(true));
        let mut m = BTreeMap::new();
        m.insert("type".to_owned(), YamlValue::String("x".to_owned()));
        m.insert("title".to_owned(), YamlValue::String("T".to_owned()));
        m.insert(
            "okf_status".to_owned(),
            YamlValue::String("draft".to_owned()),
        );
        m.insert(
            "tags".to_owned(),
            YamlValue::Sequence(vec![YamlValue::String("t".to_owned())]),
        );
        m.insert(
            "timestamp".to_owned(),
            YamlValue::String("2026-01-01".to_owned()),
        );
        m.insert("resource".to_owned(), YamlValue::String("r".to_owned()));
        m.insert(
            "public_boundary".to_owned(),
            YamlValue::String("internal".to_owned()),
        );
        m.insert("unknown_extra".to_owned(), YamlValue::Mapping(inner));
        let fm = Frontmatter::from_parsed("raw", m);
        let doc = concept("u.md", fm, "[l](/p.md)\n# Citations");
        let bundle = Bundle::from_documents([doc]).expect("bundle");

        // Before
        let before = bundle
            .get("u.md")
            .unwrap()
            .frontmatter()
            .parsed()
            .unwrap()
            .clone();
        let source_before = bundle.get("u.md").unwrap().source().to_owned();
        let raw_before = bundle.get("u.md").unwrap().frontmatter().raw().to_owned();

        let _r = ProfileValidator::validate(&bundle, BRAN_STRICT);

        // After validate call, source evidence and parsed map unchanged (no mutation)
        let after = bundle.get("u.md").unwrap().frontmatter().parsed().unwrap();
        assert!(after.contains_key("unknown_extra"));
        assert_eq!(before, *after);
        assert_eq!(source_before, bundle.get("u.md").unwrap().source());
        assert_eq!(raw_before, bundle.get("u.md").unwrap().frontmatter().raw());
        assert_eq!(bundle.len(), 1);
    }

    #[test]
    fn broken_links_tolerated() {
        let mut m = BTreeMap::new();
        m.insert("type".to_owned(), YamlValue::String("Playbook".to_owned()));
        let fm = Frontmatter::from_parsed("", m);
        // broken link + still ok for okf
        let doc = concept("p.md", fm, "See [missing](/does/not/exist.md).");
        let bundle = Bundle::from_documents([doc]).expect("bundle");

        let r = ProfileValidator::validate(&bundle, OKF_V0_1);
        assert_eq!(r.okf_compatibility.status, ValidationStatus::Pass);
        // strict will fail for other missing fields, but broken link itself is not a rejection reason
        assert!(r.okf_compatibility.diagnostics.is_empty());
    }

    #[test]
    fn reserved_index_and_log_require_no_concept_frontmatter() {
        let bundle =
            Bundle::from_documents([idx("index.md"), log("nested/log.md")]).expect("bundle");

        let r = ProfileValidator::validate(&bundle, OKF_V0_1);
        assert_eq!(r.okf_compatibility.status, ValidationStatus::Pass);
        assert!(r.okf_compatibility.diagnostics.is_empty());

        let r2 = ProfileValidator::validate(&bundle, BRAN_STRICT);
        // No concepts -> no strict diags
        assert_eq!(r2.bran_strict.status, ValidationStatus::Pass);
        assert!(r2.bran_strict.diagnostics.is_empty());
    }

    #[test]
    fn non_string_and_blank_type_rejected() {
        // non-string
        let mut m1 = BTreeMap::new();
        m1.insert("type".to_owned(), YamlValue::Number("123".to_owned()));
        let fm1 = Frontmatter::from_parsed("", m1);
        let d1 = Doc::new("n.md", "", "", fm1);
        // blank
        let mut m2 = BTreeMap::new();
        m2.insert("type".to_owned(), YamlValue::String("   ".to_owned()));
        let fm2 = Frontmatter::from_parsed("", m2);
        let d2 = concept("b.md", fm2, "");
        let bundle = Bundle::from_documents([d1, d2]).expect("bundle");

        let r = ProfileValidator::validate(&bundle, OKF_V0_1);
        assert_eq!(r.okf_compatibility.status, ValidationStatus::Fail);
        let codes: Vec<_> = r
            .okf_compatibility
            .diagnostics
            .iter()
            .map(|d| d.code.as_str())
            .collect();
        assert!(codes.contains(&"non-string-type"));
        assert!(codes.contains(&"blank-type"));
    }

    #[test]
    fn independent_selected_profile_exits() {
        // Build a bundle that is OKF-pass + Strict-fail
        let mut m = BTreeMap::new();
        m.insert("type".to_owned(), YamlValue::String("C".to_owned()));
        let fm = Frontmatter::from_parsed("", m);
        let doc = concept("c.md", fm, "no links");
        let bundle = Bundle::from_documents([doc]).expect("bundle");

        let rokf = ProfileValidator::validate(&bundle, OKF_V0_1);
        assert!(rokf.selected_passed());
        assert_eq!(rokf.exit_code(), 0);
        assert_eq!(rokf.okf_compatibility.status, ValidationStatus::Pass);
        assert_eq!(rokf.bran_strict.status, ValidationStatus::Fail);

        let rstrict = ProfileValidator::validate(&bundle, BRAN_STRICT);
        assert!(!rstrict.selected_passed());
        assert_eq!(rstrict.exit_code(), 1);
        // both results always present
        assert_eq!(rstrict.okf_compatibility.status, ValidationStatus::Pass);
        assert_eq!(rstrict.bran_strict.status, ValidationStatus::Fail);
    }

    #[test]
    fn deterministic_diagnostic_order_and_repeated_results() {
        // Two concepts, lexical path order a before b. Omit type so OKF emits missing-type diags.
        let ma = BTreeMap::new();
        let fma = Frontmatter::from_parsed("", ma);
        let da = concept("a.md", fma, "");

        let mb = BTreeMap::new();
        let fmb = Frontmatter::from_parsed("", mb);
        let db = concept("b.md", fmb, "");

        let bundle = Bundle::from_documents([db.clone(), da.clone()]).expect("order insen");

        let r1 = ProfileValidator::validate(&bundle, OKF_V0_1);
        let r2 = ProfileValidator::validate(&bundle, OKF_V0_1);
        assert_eq!(r1, r2);

        // Diagnostics must appear in path order: a.md then b.md
        let paths: Vec<_> = r1
            .okf_compatibility
            .diagnostics
            .iter()
            .map(|d| d.path.as_str())
            .collect();
        assert_eq!(paths, vec!["a.md", "b.md"]);

        // Strict diags also stable
        let rs = ProfileValidator::validate(&bundle, BRAN_STRICT);
        let rs2 = ProfileValidator::validate(&bundle, BRAN_STRICT);
        assert_eq!(rs, rs2);
        let scodes: Vec<_> = rs
            .bran_strict
            .diagnostics
            .iter()
            .map(|d| d.code.as_str())
            .collect();
        // Within first doc (a.md), codes appear in check order
        assert!(scodes.contains(&"title"));
        assert!(scodes.contains(&"status"));
    }

    #[test]
    fn unknown_profile_selected_yields_failure_no_panic() {
        let mut m = BTreeMap::new();
        m.insert("type".to_owned(), YamlValue::String("X".to_owned()));
        let fm = Frontmatter::from_parsed("", m);
        let doc = concept("x.md", fm, "body");
        let bundle = Bundle::from_documents([doc]).expect("bundle");

        let r = ProfileValidator::validate(&bundle, "future-profile-v9");
        assert!(!r.selected_passed());
        assert_eq!(r.exit_code(), 1);
        assert_eq!(
            r.selected_profile_error,
            Some(Diagnostic {
                path: "<selection>".to_owned(),
                code: "unknown-profile".to_owned(),
                message: "unknown validation profile: future-profile-v9".to_owned(),
            })
        );
        // outcomes still computed
        assert_eq!(r.okf_compatibility.status, ValidationStatus::Pass);
    }

    #[test]
    fn strict_includes_the_okf_compatibility_floor() {
        let mut m = BTreeMap::new();
        m.insert(
            "title".to_owned(),
            YamlValue::String("Ready title".to_owned()),
        );
        m.insert(
            "okf_status".to_owned(),
            YamlValue::String("active".to_owned()),
        );
        m.insert(
            "tags".to_owned(),
            YamlValue::Sequence(vec![YamlValue::String("tag".to_owned())]),
        );
        m.insert(
            "timestamp".to_owned(),
            YamlValue::String("2026-07-18T12:00:00Z".to_owned()),
        );
        m.insert(
            "resource".to_owned(),
            YamlValue::String("https://example.com/source".to_owned()),
        );
        m.insert(
            "public_boundary".to_owned(),
            YamlValue::String("public".to_owned()),
        );
        let doc = concept(
            "missing-type.md",
            Frontmatter::from_parsed("raw", m),
            "[related](/x)",
        );
        let bundle = Bundle::from_documents([doc]).expect("bundle");

        let result = ProfileValidator::validate(&bundle, BRAN_STRICT);
        assert_eq!(result.okf_compatibility.status, ValidationStatus::Fail);
        assert_eq!(result.bran_strict.status, ValidationStatus::Fail);
        assert!(result
            .bran_strict
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "missing-type"));
    }

    #[test]
    fn strict_ready_body_evidence_satisfies_relationship_and_citation() {
        let mut m = BTreeMap::new();
        m.insert("type".to_owned(), YamlValue::String("Ref".to_owned()));
        m.insert("title".to_owned(), YamlValue::String("R".to_owned()));
        m.insert(
            "okf_status".to_owned(),
            YamlValue::String("active".to_owned()),
        );
        m.insert(
            "tags".to_owned(),
            YamlValue::Sequence(vec![YamlValue::String("r".to_owned())]),
        );
        m.insert("timestamp".to_owned(), YamlValue::String("t".to_owned()));
        m.insert("resource".to_owned(), YamlValue::String("res".to_owned()));
        m.insert(
            "public_boundary".to_owned(),
            YamlValue::String("public".to_owned()),
        );
        let body = "Link: [here](/other.md) and # Citations present.";
        let fm = Frontmatter::from_parsed("", m);
        let doc = concept("r.md", fm, body);
        let bundle = Bundle::from_documents([doc]).expect("bundle");

        let r = ProfileValidator::validate(&bundle, BRAN_STRICT);
        assert_eq!(r.bran_strict.status, ValidationStatus::Pass);
        assert!(r.bran_strict.diagnostics.is_empty());
    }

    #[derive(Debug)]
    struct FrozenConformanceFixture {
        name: String,
        selected_profile: String,
        doc: Doc,
        okf_status: ValidationStatus,
        okf_codes: Vec<String>,
        strict_status: ValidationStatus,
        strict_codes: Vec<String>,
        selected_exit: i32,
        selection_code: Option<String>,
    }

    fn conformance_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures/conformance")
            .join(format!("{name}.fixture"))
    }

    fn schema_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("schemas")
            .join(name)
    }

    // This intentionally handles only the fixed `key=value` fixture grammar below.
    // It is test-only normalized input, not a Markdown or YAML parser.
    fn load_frozen_conformance_fixture(name: &str) -> FrozenConformanceFixture {
        let contents = fs::read_to_string(conformance_path(name)).expect("read frozen fixture");
        let mut fields = BTreeMap::new();
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (key, value) = line
                .split_once('=')
                .unwrap_or_else(|| panic!("invalid fixture line in {name}: {line}"));
            assert!(
                fields
                    .insert(key.to_owned(), unescape_fixture(value))
                    .is_none(),
                "duplicate fixture key {key} in {name}"
            );
        }

        let status = required_fixture_field(&fields, "frontmatter.status", name);
        let mut frontmatter = BTreeMap::new();
        for (key, value) in &fields {
            if let Some(field_path) = key.strip_prefix("frontmatter.") {
                if field_path != "raw" && field_path != "status" {
                    insert_fixture_field(
                        &mut frontmatter,
                        field_path.split('.').collect::<Vec<_>>().as_slice(),
                        parse_fixture_value(value, name),
                    );
                }
            }
        }

        let raw = required_fixture_field(&fields, "frontmatter.raw", name);
        let parsed_frontmatter = match status.as_str() {
            "ok" => Frontmatter::from_parsed(raw, frontmatter),
            _ => {
                let reason = status
                    .strip_prefix("malformed:")
                    .unwrap_or_else(|| panic!("invalid frontmatter status in {name}: {status}"));
                Frontmatter::malformed(raw, reason)
            }
        };

        FrozenConformanceFixture {
            name: required_fixture_field(&fields, "name", name),
            selected_profile: required_fixture_field(&fields, "selected_profile", name),
            doc: Doc::new(
                required_fixture_field(&fields, "doc.path", name),
                required_fixture_field(&fields, "doc.source", name),
                required_fixture_field(&fields, "doc.body", name),
                parsed_frontmatter,
            ),
            okf_status: parse_fixture_status(&required_fixture_field(
                &fields,
                "expected.okf.status",
                name,
            )),
            okf_codes: parse_fixture_codes(&required_fixture_field(
                &fields,
                "expected.okf.codes",
                name,
            )),
            strict_status: parse_fixture_status(&required_fixture_field(
                &fields,
                "expected.strict.status",
                name,
            )),
            strict_codes: parse_fixture_codes(&required_fixture_field(
                &fields,
                "expected.strict.codes",
                name,
            )),
            selected_exit: required_fixture_field(&fields, "expected.selected_exit", name)
                .parse()
                .expect("fixture selected exit must be an integer"),
            selection_code: match required_fixture_field(&fields, "expected.selection_code", name)
                .as_str()
            {
                "" => None,
                value => Some(value.to_owned()),
            },
        }
    }

    fn required_fixture_field(
        fields: &BTreeMap<String, String>,
        key: &str,
        fixture_name: &str,
    ) -> String {
        fields
            .get(key)
            .unwrap_or_else(|| panic!("missing fixture key {key} in {fixture_name}"))
            .to_owned()
    }

    fn unescape_fixture(value: &str) -> String {
        let mut result = String::new();
        let mut escaped = false;
        for character in value.chars() {
            if escaped {
                match character {
                    'n' => result.push('\n'),
                    'r' => result.push('\r'),
                    't' => result.push('\t'),
                    '\\' => result.push('\\'),
                    _ => panic!("unsupported fixture escape: \\{character}"),
                }
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else {
                result.push(character);
            }
        }
        assert!(!escaped, "fixture value ends in an escape");
        result
    }

    fn parse_fixture_value(value: &str, fixture_name: &str) -> YamlValue {
        if value == "null" {
            return YamlValue::Null;
        }
        if let Some(value) = value.strip_prefix("string:") {
            return YamlValue::String(value.to_owned());
        }
        if let Some(value) = value.strip_prefix("number:") {
            return YamlValue::Number(value.to_owned());
        }
        if let Some(value) = value.strip_prefix("bool:") {
            return match value {
                "true" => YamlValue::Bool(true),
                "false" => YamlValue::Bool(false),
                _ => panic!("invalid bool fixture value in {fixture_name}: {value}"),
            };
        }
        if let Some(values) = value.strip_prefix("sequence:") {
            return YamlValue::Sequence(
                values
                    .split(',')
                    .map(|entry| parse_fixture_value(entry, fixture_name))
                    .collect(),
            );
        }
        panic!("unsupported fixture value in {fixture_name}: {value}");
    }

    fn insert_fixture_field(
        map: &mut BTreeMap<String, YamlValue>,
        path: &[&str],
        value: YamlValue,
    ) {
        let (key, remainder) = path
            .split_first()
            .expect("frontmatter fixture field must not be empty");
        if remainder.is_empty() {
            assert!(
                map.insert((*key).to_owned(), value).is_none(),
                "duplicate fixture field"
            );
            return;
        }
        let nested = map
            .entry((*key).to_owned())
            .or_insert_with(|| YamlValue::Mapping(BTreeMap::new()));
        let nested = match nested {
            YamlValue::Mapping(nested) => nested,
            _ => panic!("fixture field conflicts with non-mapping parent: {key}"),
        };
        insert_fixture_field(nested, remainder, value);
    }

    fn parse_fixture_status(value: &str) -> ValidationStatus {
        match value {
            "pass" => ValidationStatus::Pass,
            "fail" => ValidationStatus::Fail,
            _ => panic!("invalid expected status: {value}"),
        }
    }

    fn parse_fixture_codes(value: &str) -> Vec<String> {
        match value {
            "" => Vec::new(),
            values => values.split(',').map(str::to_owned).collect(),
        }
    }

    fn diagnostic_codes(outcome: &ProfileOutcome) -> Vec<String> {
        outcome
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.clone())
            .collect()
    }

    #[test]
    fn conformance_frozen_dual_profile_corpus_matches_goldens() {
        // Fixed lexical order makes fixture execution and its assertion failures deterministic.
        const CASES: [&str; 7] = [
            "broken-link-tolerance",
            "malformed-frontmatter",
            "minimal-upstream-valid",
            "strict-gap-okf-selected",
            "strict-gap-strict-selected",
            "strict-ready-valid",
            "unknown-nested-field-preservation",
        ];

        let mut executed = Vec::new();
        for case_name in CASES {
            let fixture = load_frozen_conformance_fixture(case_name);
            assert_eq!(fixture.name, case_name);
            executed.push(fixture.name.clone());

            let bundle = Bundle::from_documents([fixture.doc]).expect("fixture bundle");
            let source_before = bundle.docs().values().next().unwrap().source().to_owned();
            let raw_before = bundle
                .docs()
                .values()
                .next()
                .unwrap()
                .frontmatter()
                .raw()
                .to_owned();
            let parsed_before = bundle
                .docs()
                .values()
                .next()
                .unwrap()
                .frontmatter()
                .parsed()
                .cloned();

            let result = ProfileValidator::validate(&bundle, &fixture.selected_profile);
            assert_eq!(
                result.okf_compatibility.status, fixture.okf_status,
                "{case_name}"
            );
            assert_eq!(
                diagnostic_codes(&result.okf_compatibility),
                fixture.okf_codes,
                "{case_name}"
            );
            assert_eq!(
                result.bran_strict.status, fixture.strict_status,
                "{case_name}"
            );
            assert_eq!(
                diagnostic_codes(&result.bran_strict),
                fixture.strict_codes,
                "{case_name}"
            );
            assert_eq!(result.exit_code(), fixture.selected_exit, "{case_name}");
            assert_eq!(
                result
                    .selected_profile_error
                    .as_ref()
                    .map(|diagnostic| diagnostic.code.clone()),
                fixture.selection_code,
                "{case_name}"
            );

            if case_name == "unknown-nested-field-preservation" {
                let canonical_once = bundle.to_canonical_form();
                let canonical_twice = bundle.to_canonical_form();
                assert_eq!(
                    canonical_once, canonical_twice,
                    "canonical output must repeat exactly"
                );
                assert!(canonical_once
                    .contains(r#""producer_extension":{"deep":true,"label":"keep-me"}"#));
                let preserved = bundle.docs().values().next().unwrap();
                assert_eq!(preserved.source(), source_before);
                assert_eq!(preserved.frontmatter().raw(), raw_before);
                assert_eq!(preserved.frontmatter().parsed(), parsed_before.as_ref());
            }
        }
        assert_eq!(executed, CASES);
    }

    #[test]
    fn conformance_schema_contract_shapes_are_pinned() {
        let bundle_schema =
            fs::read_to_string(schema_path("okf-v0.1-normalized-bundle.schema.json"))
                .expect("read normalized bundle schema");
        for required_shape in [
            "\"schema_version\": { \"const\": \"1\" }",
            "\"source\": { \"type\": \"string\" }",
            "\"raw\": { \"type\": \"string\" }",
            "\"additionalProperties\": true",
            "does not resolve Markdown links",
        ] {
            assert!(
                bundle_schema.contains(required_shape),
                "missing bundle schema shape: {required_shape}"
            );
        }

        let result_schema = fs::read_to_string(schema_path("bran-profile-result.schema.json"))
            .expect("read profile result schema");
        for required_shape in [
            "\"okf_compatibility\"",
            "\"bran_strict\"",
            "\"exit_code\": { \"enum\": [0, 1] }",
            "\"const\": \"okf-v0.1\"",
            "\"const\": \"bran-strict\"",
            "Link targets remain unvalidated",
        ] {
            assert!(
                result_schema.contains(required_shape),
                "missing result schema shape: {required_shape}"
            );
        }
    }
}
