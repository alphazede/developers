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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn yaml_value_unknown_nested_fields_survive_construction_and_serialization() {
        // Producer can emit arbitrary nested unknown metadata.
        let mut inner = BTreeMap::new();
        inner.insert("x".to_owned(), YamlValue::String("y".to_owned()));
        inner.insert(
            "nested".to_owned(),
            YamlValue::Mapping({
                let mut m = BTreeMap::new();
                m.insert("deep".to_owned(), YamlValue::Bool(true));
                m.insert("arr".to_owned(), YamlValue::Sequence(vec![YamlValue::Null]));
                m
            }),
        );
        let mut map = BTreeMap::new();
        map.insert("type".to_owned(), YamlValue::String("concept".to_owned()));
        map.insert("unknown".to_owned(), YamlValue::Mapping(inner));
        map.insert(
            "weird_num".to_owned(),
            YamlValue::Number("1.2e3".to_owned()),
        );

        let v = YamlValue::Mapping(map);

        let mut s = String::new();
        write_canonical_yaml_value(&mut s, &v);

        // Should round-trip stably and contain the unknown keys verbatim.
        assert!(s.contains("\"unknown\""));
        assert!(s.contains("\"x\""));
        assert!(s.contains("\"deep\""));
        assert!(s.contains("true"));
        // Numbers use deterministic tagged JSON form to guarantee valid JSON and exact lexical.
        assert!(s.contains("\"__yaml_number__\""));
        assert!(s.contains("1.2e3"));
        assert!(s.contains("\"weird_num\""));

        // Re-serialize must be identical.
        let mut s2 = String::new();
        write_canonical_yaml_value(&mut s2, &v);
        assert_eq!(s, s2);
    }

    #[test]
    fn yaml_value_btree_order_is_stable_across_builds() {
        // Build two mappings with different logical insertion but same keys.
        let mut m1 = BTreeMap::new();
        m1.insert("b".to_owned(), YamlValue::Number("2".to_owned()));
        m1.insert("a".to_owned(), YamlValue::Number("1".to_owned()));

        let mut m2 = BTreeMap::new();
        m2.insert("a".to_owned(), YamlValue::Number("1".to_owned()));
        m2.insert("b".to_owned(), YamlValue::Number("2".to_owned()));

        let v1 = YamlValue::Mapping(m1);
        let v2 = YamlValue::Mapping(m2);

        let mut s1 = String::new();
        let mut s2 = String::new();
        write_canonical_yaml_value(&mut s1, &v1);
        write_canonical_yaml_value(&mut s2, &v2);
        assert_eq!(s1, s2);
        // Keys must appear in sorted order: a before b.
        let a_pos = s1.find("\"a\"").unwrap();
        let b_pos = s1.find("\"b\"").unwrap();
        assert!(a_pos < b_pos);
    }

    #[test]
    fn yaml_value_schema_version_constant_is_present() {
        // Must be the stable "1" for the initial canonical bundle envelope.
        assert_eq!(BUNDLE_SCHEMA_VERSION, "1");
    }

    #[test]
    fn yaml_numbers_use_tagged_form_for_arbitrary_lexical_values_and_escaping() {
        // Any lexical form from YAML Number (including ones JSON cannot represent as number)
        // must produce valid deterministic JSON via tagged representation.
        let lexical_cases: &[&str] = &[
            "42",
            "01",
            "0x10",
            ".nan",
            "NaN",
            "+inf",
            "-Infinity",
            "1.2e3",
            "with\"quotes\\and\\esc",
        ];

        for lex in lexical_cases {
            let v = YamlValue::Number((*lex).to_owned());
            let mut s = String::new();
            write_canonical_yaml_value(&mut s, &v);
            let mut s2 = String::new();
            write_canonical_yaml_value(&mut s2, &v);
            assert_eq!(s, s2, "must be deterministic for {}", lex);

            // Must be valid tagged JSON shape: {"__yaml_number__":"..."}
            assert!(
                s.starts_with("{\"__yaml_number__\":\""),
                "expected tagged start, got: {}",
                s
            );
            assert!(s.ends_with("\"}"), "expected tagged end, got: {}", s);
            // The exact lexical (escaped inside) must be present
            if lex.contains('"') || lex.contains('\\') {
                // escaping exercised
                assert!(s.contains("\\\"") || s.contains("\\\\"));
            }
        }
    }
}
