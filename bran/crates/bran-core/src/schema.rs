//! Normalized value types for BRAN bundles (Slice 1.2 Packet A).
//!
//! Models YAML scalar/sequence/mapping shapes without serde dependency.
//! All types are immutable value objects using BTree collections for
//! stable deterministic ordering.

use std::collections::BTreeMap;

/// Bundle schema version for Slice 1.2 Packet A normalization layer.
/// Used in canonical serialization to ensure forward compatibility checks.
pub const BUNDLE_SCHEMA_VERSION: &str = "1";

/// A YAML-normalized value shape.
/// Scalars, sequences, and mappings are modeled for frontmatter preservation.
/// Numbers are stored lexically to avoid float drift and ensure exact roundtrips
/// in canonical form. All collections use BTree for stable ordering.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum YamlValue {
    Null,
    Bool(bool),
    /// Lexical number form as provided by producer (no normalization of 1 vs 1.0).
    Number(String),
    String(String),
    Sequence(Vec<YamlValue>),
    Mapping(BTreeMap<String, YamlValue>),
}

impl YamlValue {
    /// Returns true if this value is a mapping.
    pub fn is_mapping(&self) -> bool {
        matches!(self, YamlValue::Mapping(_))
    }

    /// Returns true if this value is a sequence.
    pub fn is_sequence(&self) -> bool {
        matches!(self, YamlValue::Sequence(_))
    }

    /// Returns the mapping if this is a Mapping, else None.
    pub fn as_mapping(&self) -> Option<&BTreeMap<String, YamlValue>> {
        match self {
            YamlValue::Mapping(m) => Some(m),
            _ => None,
        }
    }

    /// Returns the sequence if this is a Sequence, else None.
    pub fn as_sequence(&self) -> Option<&Vec<YamlValue>> {
        match self {
            YamlValue::Sequence(s) => Some(s),
            _ => None,
        }
    }
}

/// Writes a YamlValue in deterministic canonical form.
/// Ordering is always BTree-derived; insertion order in source does not matter.
/// This is a stable, byte-identical encoding (no serde).
pub fn write_canonical_yaml_value(out: &mut String, v: &YamlValue) {
    match v {
        YamlValue::Null => out.push_str("null"),
        YamlValue::Bool(true) => out.push_str("true"),
        YamlValue::Bool(false) => out.push_str("false"),
        YamlValue::Number(s) => {
            // Preserve exact lexical form (including non-JSON-representable like .nan, 0x10, 01)
            // using a deterministic tagged JSON object so the overall canonical form is always
            // valid JSON. Raw emission would produce invalid JSON for some YAML lexical numbers.
            out.push_str("{\"__yaml_number__\":");
            write_escaped_string(out, s);
            out.push('}');
        }
        YamlValue::String(s) => {
            write_escaped_string(out, s);
        }
        YamlValue::Sequence(seq) => {
            out.push('[');
            for (i, item) in seq.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical_yaml_value(out, item);
            }
            out.push(']');
        }
        YamlValue::Mapping(map) => {
            out.push('{');
            for (i, (k, val)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_escaped_string(out, k);
                out.push(':');
                write_canonical_yaml_value(out, val);
            }
            out.push('}');
        }
    }
}

fn write_escaped_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_ascii_control() => {
                // Other control chars as \u00XX
                let code = c as u32;
                let _ = core::fmt::Write::write_fmt(out, format_args!("\\u{:04x}", code));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Escapes a string for canonical bundle serialization (JSON-style).
/// Shared so bundle.rs can produce identical escaping without duplication.
pub(crate) fn write_escaped_string_for_bundle(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_ascii_control() => {
                let code = c as u32;
                let _ = core::fmt::Write::write_fmt(out, format_args!("\\u{:04x}", code));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
