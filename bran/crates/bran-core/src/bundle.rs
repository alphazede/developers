//! Immutable normalized bundle and document types for BRAN (Slice 1.2 Packet A).
//!
//! A bundle is a hierarchical collection of Markdown documents.
//! Concept documents carry YAML frontmatter. Only a non-empty `type` field is
//! required by the OKF v0.1 contract; unknown fields are tolerated and preserved.
//!
//! Parsing of Markdown/YAML is explicitly out of scope for this slice.
//! Parse success/failure is modeled explicitly via ParseStatus so that
//! profile validation can evaluate malformed fixtures without pretending
//! to parse YAML.
//!
//! All collections use BTree types. Normalization retains original source
//! evidence (source, body, raw frontmatter). Canonical serialization is
//! deterministic and byte-identical regardless of construction order.

use crate::schema::{write_canonical_yaml_value, YamlValue, BUNDLE_SCHEMA_VERSION};
use std::collections::BTreeMap;

/// Explicit parse status for a document's frontmatter.
/// Parsing is not performed by this slice; later adapters produce these states.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum ParseStatus {
    /// Frontmatter parsed successfully (or was absent and treated as empty success).
    Ok,
    /// Frontmatter was malformed; reason is producer- or adapter-supplied and preserved.
    Malformed { reason: String },
}

impl ParseStatus {
    /// Returns true if this status indicates successful parse (or absence).
    pub fn is_ok(&self) -> bool {
        matches!(self, ParseStatus::Ok)
    }
}

/// Normalized frontmatter evidence.
/// Raw text is retained exactly to prove no silent rewrite occurred.
/// Parsed map is present only on successful parse; unknown keys are preserved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frontmatter {
    /// Exact original raw frontmatter block text (including delimiters if present),
    /// or empty string when no frontmatter block existed in source.
    raw: String,
    /// Normalized mapping when parse succeeded. None when absent or malformed.
    /// Keys and nested structures preserve every producer-defined field.
    parsed: Option<BTreeMap<String, YamlValue>>,
    /// Explicit parse outcome. Malformed keeps its reason for diagnostics.
    status: ParseStatus,
}

impl Frontmatter {
    /// Constructs an empty frontmatter (no block present, successful absence).
    pub fn empty() -> Self {
        Self {
            raw: String::new(),
            parsed: Some(BTreeMap::new()),
            status: ParseStatus::Ok,
        }
    }

    /// Constructs frontmatter from raw text and a successfully parsed map.
    /// The map may be empty or contain only unknown fields; `type` is not enforced here.
    pub fn from_parsed(raw: impl Into<String>, parsed: BTreeMap<String, YamlValue>) -> Self {
        Self {
            raw: raw.into(),
            parsed: Some(parsed),
            status: ParseStatus::Ok,
        }
    }

    /// Constructs an explicitly malformed frontmatter.
    /// Raw is retained for evidence; parsed is None.
    pub fn malformed(raw: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            raw: raw.into(),
            parsed: None,
            status: ParseStatus::Malformed {
                reason: reason.into(),
            },
        }
    }

    /// Raw frontmatter bytes exactly as in source (byte-for-byte, including delimiters).
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// Parsed map if parse was successful; None for absent (empty) or malformed.
    pub fn parsed(&self) -> Option<&BTreeMap<String, YamlValue>> {
        self.parsed.as_ref()
    }

    /// Parse status (Ok or Malformed with reason).
    pub fn status(&self) -> &ParseStatus {
        &self.status
    }
}

/// A single document inside a bundle.
/// Source and body are retained verbatim. Frontmatter evidence is preserved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Doc {
    /// Relative path within the bundle, e.g. "concepts/foo.md" or "index.md".
    path: String,
    /// Full original source including any frontmatter delimiters and body.
    source: String,
    /// Markdown body after stripping any frontmatter block. May be empty.
    body: String,
    /// Frontmatter with raw + normalized evidence.
    frontmatter: Frontmatter,
}

impl Doc {
    /// Creates a new Doc. Callers supply already-separated source/body and frontmatter.
    /// This constructor does not parse; it models a normalized result.
    pub fn new(
        path: impl Into<String>,
        source: impl Into<String>,
        body: impl Into<String>,
        frontmatter: Frontmatter,
    ) -> Self {
        Self {
            path: path.into(),
            source: source.into(),
            body: body.into(),
            frontmatter,
        }
    }

    /// Relative path within the bundle.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Full original source (byte-for-byte).
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Body after frontmatter (byte-for-byte).
    pub fn body(&self) -> &str {
        &self.body
    }

    /// Frontmatter evidence (raw preserved exactly; no parsing performed here).
    pub fn frontmatter(&self) -> &Frontmatter {
        &self.frontmatter
    }

    /// Returns the kind of this document based on its path.
    /// Concept identity is the relative path with the trailing ".md" removed.
    /// index.md and log.md are reserved and distinguishable from concepts (at any hierarchy level).
    pub fn kind(&self) -> DocKind {
        let base = self.path.rsplit('/').next().unwrap_or(&self.path);
        if base == "index.md" {
            DocKind::Index
        } else if base == "log.md" {
            DocKind::Log
        } else {
            // Concept identity: strip a single trailing .md if present (keeps directory prefix).
            let identity = if let Some(stripped) = self.path.strip_suffix(".md") {
                stripped.to_owned()
            } else {
                self.path.clone()
            };
            DocKind::Concept { identity }
        }
    }

    /// Returns the concept identity if this doc is a concept, else None.
    pub fn concept_identity(&self) -> Option<&str> {
        let base = self.path.rsplit('/').next().unwrap_or(&self.path);
        if base == "index.md" || base == "log.md" {
            return None;
        }
        // Concept identity is relative path without trailing .md
        if let Some(stripped) = self.path.strip_suffix(".md") {
            Some(stripped)
        } else {
            Some(self.path.as_str())
        }
    }
}

/// Distinguishes document roles inside a bundle.
/// Concepts are identified by relative path without the ".md" suffix.
/// index.md and log.md are reserved kinds.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum DocKind {
    /// A concept document. Identity is the relative path without ".md".
    Concept { identity: String },
    /// Reserved root index document.
    Index,
    /// Reserved root log document.
    Log,
}

/// An immutable normalized bundle of documents.
/// Docs are stored under their path in a BTreeMap for stable canonical order.
/// Schema version is carried for deterministic serialization compatibility.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bundle {
    /// Normalization schema version. Serialized into canonical form.
    schema_version: String,
    /// Documents keyed by their relative path. BTreeMap guarantees order stability.
    docs: BTreeMap<String, Doc>,
}

impl Bundle {
    /// Creates an empty bundle with the stable schema version "1".
    pub fn new() -> Self {
        Self {
            schema_version: BUNDLE_SCHEMA_VERSION.to_owned(),
            docs: BTreeMap::new(),
        }
    }

    /// Constructs a bundle from documents.
    ///
    /// Duplicate paths are rejected with a typed error (deterministic: first duplicate
    /// encountered during iteration is reported). No public mutation after construction.
    /// A local BTreeMap is used only during construction.
    pub fn from_documents<I>(docs: I) -> Result<Self, DuplicatePathError>
    where
        I: IntoIterator<Item = Doc>,
    {
        let mut map: BTreeMap<String, Doc> = BTreeMap::new();
        for doc in docs {
            let p = doc.path.clone();
            if map.contains_key(&p) {
                return Err(DuplicatePathError { path: p });
            }
            map.insert(p, doc);
        }
        Ok(Self {
            schema_version: BUNDLE_SCHEMA_VERSION.to_owned(),
            docs: map,
        })
    }

    /// Returns a reference to a doc by path.
    pub fn get(&self, path: &str) -> Option<&Doc> {
        self.docs.get(path)
    }

    /// Returns the number of documents.
    pub fn len(&self) -> usize {
        self.docs.len()
    }

    /// Returns true if the bundle contains no documents.
    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    /// Stable schema version for this canonical bundle envelope (always "1").
    pub fn schema_version(&self) -> &str {
        &self.schema_version
    }

    /// Read-only access to the documents (BTreeMap for deterministic order).
    pub fn docs(&self) -> &BTreeMap<String, Doc> {
        &self.docs
    }

    /// Produces a deterministic canonical serialization.
    /// Output is byte-identical on repeated calls and independent of
    /// any prior insertion/Hash order because internal storage is BTree.
    /// Schema version is included. Unknown fields and raw evidence are preserved.
    pub fn to_canonical_form(&self) -> String {
        let mut out = String::new();
        out.push('{');
        // schema_version first for stable header shape
        out.push_str("\"schema_version\":");
        crate::schema::write_escaped_string_for_bundle(&mut out, &self.schema_version);
        out.push_str(",\"docs\":{");
        for (i, (path, doc)) in self.docs.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            crate::schema::write_escaped_string_for_bundle(&mut out, path);
            out.push(':');
            write_doc_canonical(&mut out, doc);
        }
        out.push_str("}}");
        out
    }
}

/// Typed rejection for duplicate document paths during Bundle construction.
/// Behavior is deterministic (reports the path of the first duplicate seen in iterator order).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DuplicatePathError {
    pub path: String,
}

impl Default for Bundle {
    fn default() -> Self {
        Self::new()
    }
}

fn write_doc_canonical(out: &mut String, doc: &Doc) {
    out.push('{');
    // Emit in fixed key order for determinism: body, frontmatter, path, source
    out.push_str("\"body\":");
    crate::schema::write_escaped_string_for_bundle(out, &doc.body);
    out.push_str(",\"frontmatter\":");
    write_frontmatter_canonical(out, &doc.frontmatter);
    out.push_str(",\"path\":");
    crate::schema::write_escaped_string_for_bundle(out, &doc.path);
    out.push_str(",\"source\":");
    crate::schema::write_escaped_string_for_bundle(out, &doc.source);
    out.push('}');
}

fn write_frontmatter_canonical(out: &mut String, fm: &Frontmatter) {
    out.push('{');
    out.push_str("\"raw\":");
    crate::schema::write_escaped_string_for_bundle(out, &fm.raw);
    out.push_str(",\"parsed\":");
    match &fm.parsed {
        Some(map) => {
            // Serialize as object using canonical value writer for values.
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                crate::schema::write_escaped_string_for_bundle(out, k);
                out.push(':');
                write_canonical_yaml_value(out, v);
            }
            out.push('}');
        }
        None => out.push_str("null"),
    }
    out.push_str(",\"status\":");
    match &fm.status {
        ParseStatus::Ok => out.push_str("\"ok\""),
        ParseStatus::Malformed { reason } => {
            out.push_str("{\"malformed\":");
            crate::schema::write_escaped_string_for_bundle(out, reason);
            out.push('}');
        }
    }
    out.push('}');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::YamlValue;
    use std::collections::BTreeMap;

    fn make_simple_frontmatter() -> Frontmatter {
        let mut m = BTreeMap::new();
        m.insert("type".to_owned(), YamlValue::String("concept".to_owned()));
        Frontmatter::from_parsed("---\ntype: concept\n---\n", m)
    }

    fn make_doc(path: &str, body: &str) -> Doc {
        let src = format!("---\ntype: concept\n---\n{body}");
        Doc::new(path, src, body, make_simple_frontmatter())
    }

    #[test]
    fn unknown_nested_fields_survive_construction_and_canonical_serialization() {
        let mut inner = BTreeMap::new();
        inner.insert("alpha".to_owned(), YamlValue::Number("42".to_owned()));
        inner.insert(
            "beta".to_owned(),
            YamlValue::Sequence(vec![YamlValue::String("x".to_owned())]),
        );
        let mut parsed = BTreeMap::new();
        parsed.insert("type".to_owned(), YamlValue::String("weird".to_owned()));
        parsed.insert("unknown".to_owned(), YamlValue::Mapping(inner));

        let fm = Frontmatter::from_parsed("raw-front", parsed);
        let doc = Doc::new("c.md", "src", "body", fm);
        let b = Bundle::from_documents([doc]).expect("no duplicate path");

        let s1 = b.to_canonical_form();
        let s2 = b.to_canonical_form();
        assert_eq!(s1, s2);
        assert!(s1.contains("\"unknown\""));
        assert!(s1.contains("\"alpha\""));
        // lexical number preserved via deterministic tagged JSON (valid even for non-JSON nums)
        assert!(s1.contains("\"__yaml_number__\""));
        assert!(s1.contains("42"));
    }

    #[test]
    fn insertion_order_produces_identical_serialization() {
        // Construct two bundles with same logical docs but different insert order.
        let d1 = make_doc("a.md", "A");
        let d2 = make_doc("b.md", "B");

        let b1 = Bundle::from_documents([d1.clone(), d2.clone()]).expect("no dups");
        let b2 = Bundle::from_documents([d2, d1]).expect("no dups");

        let s1 = b1.to_canonical_form();
        let s2 = b2.to_canonical_form();
        assert_eq!(s1, s2);

        // Also verify schema version appears.
        assert!(s1.contains("\"schema_version\""));
        assert!(s1.contains(BUNDLE_SCHEMA_VERSION));
    }

    #[test]
    fn original_source_and_raw_frontmatter_are_unchanged() {
        let raw_fm = "---\ntype: x\nextra: 1\n---\n";
        let body = "hello world";
        let source = format!("{raw_fm}{body}");

        let mut parsed = BTreeMap::new();
        parsed.insert("type".to_owned(), YamlValue::String("x".to_owned()));
        parsed.insert("extra".to_owned(), YamlValue::Number("1".to_owned()));
        let fm = Frontmatter::from_parsed(raw_fm, parsed);
        let doc = Doc::new("p/q.md", source.clone(), body.to_owned(), fm);

        assert_eq!(doc.source(), source);
        assert_eq!(doc.body(), body);
        assert_eq!(doc.frontmatter().raw(), raw_fm);
        // Ensure we did not mutate the raw evidence. Raw preserved byte-for-byte.
        assert!(doc.frontmatter().raw().contains("extra: 1"));
    }

    #[test]
    fn minimal_concept_identity_and_reserved_file_kinds_are_correct() {
        let c = make_doc("concepts/foo/bar.md", "body");
        assert_eq!(c.concept_identity(), Some("concepts/foo/bar"));
        match c.kind() {
            DocKind::Concept { identity } => assert_eq!(identity, "concepts/foo/bar"),
            _ => panic!("expected concept"),
        }

        let idx = Doc::new("index.md", "idx", "", Frontmatter::empty());
        assert_eq!(idx.concept_identity(), None);
        assert!(matches!(idx.kind(), DocKind::Index));

        let log = Doc::new("log.md", "log", "", Frontmatter::empty());
        assert_eq!(log.concept_identity(), None);
        assert!(matches!(log.kind(), DocKind::Log));

        // Reserved names recognized by basename at any hierarchy level (OKF v0.1 §3.1).
        let idx_nested = Doc::new("nested/index.md", "idx", "", Frontmatter::empty());
        assert_eq!(idx_nested.concept_identity(), None);
        assert!(matches!(idx_nested.kind(), DocKind::Index));

        let log_nested = Doc::new("a/b/c/log.md", "log", "", Frontmatter::empty());
        assert_eq!(log_nested.concept_identity(), None);
        assert!(matches!(log_nested.kind(), DocKind::Log));

        // Non-.md path still treated as concept with full path as identity (edge)
        let weird = Doc::new("weird", "w", "w", Frontmatter::empty());
        match weird.kind() {
            DocKind::Concept { identity } => assert_eq!(identity, "weird"),
            _ => panic!("expected concept for non-md"),
        }
    }

    #[test]
    fn malformed_parse_status_remains_explicit_and_serializes_deterministically() {
        let raw = "---\n: bad yaml here\n---\n";
        let fm = Frontmatter::malformed(raw, "unexpected colon at start of key");
        let doc = Doc::new("bad.md", raw.to_owned() + "body", "body", fm);
        let b = Bundle::from_documents([doc]).expect("no duplicate path");

        let s1 = b.to_canonical_form();
        let s2 = b.to_canonical_form();
        assert_eq!(s1, s2);

        // Status must be explicit and carry the reason.
        assert!(s1.contains("\"status\""));
        assert!(s1.contains("malformed"));
        assert!(s1.contains("unexpected colon"));
        // parsed must be null for malformed
        assert!(s1.contains("\"parsed\":null"));
        // raw evidence preserved
        assert!(s1.contains("bad yaml here"));
    }

    #[test]
    fn bundle_uses_stable_schema_version_exactly_one() {
        // Do not invent slice-coded versions; stable envelope is "1".
        let b = Bundle::new();
        assert_eq!(b.schema_version(), "1");

        let b = Bundle::from_documents([make_doc("only.md", "x")]).expect("single doc");
        assert_eq!(b.schema_version(), "1");
        let s = b.to_canonical_form();
        assert!(s.contains("\"schema_version\":\"1\""));
    }

    #[test]
    fn empty_bundle_has_stable_canonical_form() {
        let b1 = Bundle::new();
        let b2 = Bundle::new();
        assert_eq!(b1.to_canonical_form(), b2.to_canonical_form());
        assert!(b1.is_empty());
    }

    #[test]
    fn bundle_from_documents_rejects_duplicate_paths_with_typed_error() {
        // Duplicate path behavior must be deterministic (typed rejection, not replace).
        let d1 = make_doc("dup/path.md", "one");
        let d2 = Doc::new("dup/path.md", "src-two", "two", make_simple_frontmatter());
        // Order A
        let r1 = Bundle::from_documents(vec![d1.clone(), d2.clone()]);
        // Order B (same dup path)
        let r2 = Bundle::from_documents(vec![d2, d1]);
        assert!(r1.is_err());
        assert!(r2.is_err());
        let e1 = r1.unwrap_err();
        let e2 = r2.unwrap_err();
        assert_eq!(e1.path, "dup/path.md");
        assert_eq!(e2.path, "dup/path.md");
        // Error is Eq and carries the path.
        assert_eq!(
            e1,
            DuplicatePathError {
                path: "dup/path.md".to_owned()
            }
        );
    }

    #[test]
    fn bundle_construction_and_access_are_immutable_value_semantics() {
        // After construction, only read-only accessors; no setters.
        let fm = make_simple_frontmatter();
        let doc = Doc::new("immut.md", "src", "b", fm);
        let b = Bundle::from_documents([doc]).unwrap();

        // Accessors for preserved state
        assert_eq!(b.schema_version(), "1");
        assert_eq!(b.len(), 1);
        let d = b.get("immut.md").expect("present");
        assert_eq!(d.path(), "immut.md");
        assert!(d.source().contains("src"));
        assert_eq!(d.body(), "b");
        let f = d.frontmatter();
        assert!(f.raw().contains("type: concept"));
        assert!(f.parsed().is_some());
        assert!(f.status().is_ok());
        // docs() accessor
        assert!(b.docs().contains_key("immut.md"));
    }
}
