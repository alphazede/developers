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

    fn strict_gap_document(path: &str) -> Doc {
        let mut fields = BTreeMap::new();
        fields.insert("type".to_owned(), YamlValue::String("Concept".to_owned()));
        let raw = "---\ntype: Concept\n---\n";
        let body = "No strict readiness evidence.\n";
        Doc::new(
            path,
            format!("{raw}{body}"),
            body,
            Frontmatter::from_parsed(raw, fields),
        )
    }

    #[test]
    fn p1_profiles() {
        let bundle = Bundle::from_documents([strict_gap_document("concepts/profile-gap.md")])
            .expect("single profile document");
        let result = ProfileValidator::validate(&bundle, BRAN_STRICT);
        let diagnostics = &result.bran_strict.diagnostics;

        assert_eq!(result.okf_compatibility.profile, OKF_V0_1);
        assert_eq!(result.okf_compatibility.status, ValidationStatus::Pass);
        assert!(result.okf_compatibility.diagnostics.is_empty());
        assert_eq!(result.bran_strict.profile, BRAN_STRICT);
        assert_eq!(result.bran_strict.status, ValidationStatus::Fail);
        assert_eq!(diagnostics.len(), 8);
        assert_eq!(diagnostics[0].code, "title");
        assert_eq!(diagnostics[1].code, "status");
        assert_eq!(diagnostics[2].code, "tag");
        assert_eq!(diagnostics[3].code, "freshness");
        assert_eq!(diagnostics[4].code, "authority");
        assert_eq!(diagnostics[5].code, "citation-source");
        assert_eq!(diagnostics[6].code, "relationship");
        assert_eq!(diagnostics[7].code, "public-boundary");
        assert!(!result.selected_passed());
        assert_eq!(result.exit_code(), 1);
    }

    #[test]
    fn p1_conformance() {
        let fixture =
            include_str!("../../../fixtures/conformance/strict-gap-strict-selected.fixture");
        assert_eq!(
            fixture,
            concat!(
                "# Frozen normalized fixture syntax consumed only by profile.rs conformance tests.\n",
                "name=strict-gap-strict-selected\n",
                "selected_profile=bran-strict\n",
                "doc.path=concepts/strict-gap.md\n",
                "doc.source=---\\ntype: Concept\\n---\\nNo strict readiness evidence.\\n\n",
                "doc.body=No strict readiness evidence.\\n\n",
                "frontmatter.raw=---\\ntype: Concept\\n---\\n\n",
                "frontmatter.status=ok\n",
                "frontmatter.type=string:Concept\n",
                "expected.okf.status=pass\n",
                "expected.okf.codes=\n",
                "expected.strict.status=fail\n",
                "expected.strict.codes=title,status,tag,freshness,authority,citation-source,relationship,public-boundary\n",
                "expected.selected_exit=1\n",
                "expected.selection_code=\n"
            )
        );

        let bundle = Bundle::from_documents([strict_gap_document("concepts/strict-gap.md")])
            .expect("single frozen conformance document");
        let result = ProfileValidator::validate(&bundle, BRAN_STRICT);
        let diagnostics = &result.bran_strict.diagnostics;

        assert_eq!(result.okf_compatibility.status, ValidationStatus::Pass);
        assert_eq!(result.bran_strict.status, ValidationStatus::Fail);
        assert_eq!(result.exit_code(), 1);
        assert_eq!(diagnostics.len(), 8);
        assert_eq!(diagnostics[0].code, "title");
        assert_eq!(diagnostics[1].code, "status");
        assert_eq!(diagnostics[2].code, "tag");
        assert_eq!(diagnostics[3].code, "freshness");
        assert_eq!(diagnostics[4].code, "authority");
        assert_eq!(diagnostics[5].code, "citation-source");
        assert_eq!(diagnostics[6].code, "relationship");
        assert_eq!(diagnostics[7].code, "public-boundary");
    }
}
