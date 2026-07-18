//! Read-only, bounded metadata normalization for repository scanning.

use std::collections::{BTreeMap, BTreeSet};

pub const DEFAULT_MAX_INPUT_BYTES: usize = 256 * 1024;
type Fields = Vec<(String, String)>;
type ParsedHeader = Option<(Fields, FactProvenance)>;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PackageDefaults(BTreeMap<String, String>);

impl PackageDefaults {
    pub fn new(facts: impl IntoIterator<Item = (String, String)>) -> Self {
        Self(facts.into_iter().collect())
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.0.insert(key.into(), value.into());
    }

    pub(crate) fn overlay(&mut self, other: &Self) {
        self.0.extend(other.0.clone());
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum FactProvenance {
    MarkdownFrontmatter,
    CommentedYaml,
    PackageDefault,
    Filename,
    Symbol,
    Import,
    Test,
    Dependency,
    BoundaryClassification,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum FactConfidence {
    Low,
    Medium,
    High,
}

/// Facts are candidates or explicitly ambiguous; they are never verified here.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum FactState {
    Candidate,
    Ambiguous,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct MetadataFact {
    pub key: String,
    pub value: String,
    pub provenance: FactProvenance,
    pub confidence: FactConfidence,
    pub state: FactState,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MetadataReport {
    pub facts: Vec<MetadataFact>,
    pub warnings: Vec<String>,
    pub proposals: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataParserRegistry {
    max_input_bytes: usize,
}

impl Default for MetadataParserRegistry {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_INPUT_BYTES)
    }
}

impl MetadataParserRegistry {
    pub fn new(max_input_bytes: usize) -> Self {
        Self { max_input_bytes }
    }

    /// Parses only supplied text; it never reads or writes repository files.
    pub fn parse(&self, path: &str, source: &str, defaults: &PackageDefaults) -> MetadataReport {
        if source.len() > self.max_input_bytes {
            return MetadataReport {
                warnings: vec![format!(
                    "input-too-large: {} bytes exceeds {} byte limit",
                    source.len(),
                    self.max_input_bytes
                )],
                ..MetadataReport::default()
            };
        }

        let mut warnings = BTreeSet::new();
        let declared = match headers(source) {
            Ok(value) => value,
            Err(reason) => {
                warnings.insert(format!("malformed-metadata: {reason}"));
                None
            }
        };
        let declared_keys: BTreeSet<String> = declared
            .as_ref()
            .map(|(fields, _)| fields.iter().map(|(key, _)| key.clone()).collect())
            .unwrap_or_default();
        let mut facts = BTreeSet::new();
        for (key, value) in &defaults.0 {
            if !declared_keys.contains(key) {
                facts.insert(new_fact(
                    key,
                    value,
                    FactProvenance::PackageDefault,
                    FactConfidence::Medium,
                ));
            }
        }
        if let Some((fields, provenance)) = declared {
            for (key, value) in fields {
                facts.insert(new_fact(
                    key,
                    value,
                    provenance.clone(),
                    FactConfidence::High,
                ));
            }
        } else {
            warnings
                .insert("metadata-on-touch: proposal only; source remains unchanged".to_owned());
        }
        infer(path, source, &mut facts);
        boundary(path, source, &mut facts);
        resolve(&mut facts, &mut warnings);
        MetadataReport {
            facts: facts.into_iter().collect(),
            warnings: warnings.into_iter().collect(),
            proposals: declared_keys
                .is_empty()
                .then(|| proposal(path))
                .into_iter()
                .collect(),
        }
    }
}

fn headers(source: &str) -> Result<ParsedHeader, String> {
    let mut lines = source.lines();
    let first = lines
        .next()
        .unwrap_or("")
        .trim_start_matches('\u{feff}')
        .trim();
    if first == "---" {
        let mut body = String::new();
        for line in lines {
            if line.trim() == "---" {
                return yaml(&body)
                    .map(|fields| Some((fields, FactProvenance::MarkdownFrontmatter)));
            }
            body.push_str(line);
            body.push('\n');
        }
        return Err("frontmatter is missing its closing delimiter".to_owned());
    }

    let mut body = String::new();
    let mut open = false;
    for line in source.lines() {
        let Some(line) = uncomment(line) else { break };
        if line.trim() == "---" {
            if open {
                return yaml(&body).map(|fields| Some((fields, FactProvenance::CommentedYaml)));
            }
            open = true;
        } else if open {
            body.push_str(line);
            body.push('\n');
        }
    }
    if open {
        Err("commented YAML header is missing its closing delimiter".to_owned())
    } else {
        Ok(None)
    }
}

fn uncomment(line: &str) -> Option<&str> {
    let line = line.trim_start();
    for prefix in ["///", "//!", "//", "/*", "#", ";", "--", "*"] {
        if let Some(value) = line.strip_prefix(prefix) {
            return Some(value.trim_start());
        }
    }
    None
}

fn yaml(body: &str) -> Result<Fields, String> {
    let mut fields = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            return Err(format!("not key/value YAML: {line}"));
        };
        let key = key.trim();
        let value = value.trim();
        if !valid_key(key)
            || value.is_empty()
            || value.starts_with('{')
            || value.starts_with('|')
            || value.starts_with('>')
        {
            return Err(format!("unsupported YAML scalar: {line}"));
        }
        if value.starts_with('[') != value.ends_with(']') {
            return Err(format!("malformed YAML list: {line}"));
        }
        if let Some(values) = value
            .strip_prefix('[')
            .and_then(|item| item.strip_suffix(']'))
        {
            for value in values.split(',') {
                fields.push((key.to_owned(), scalar(value)?));
            }
        } else {
            fields.push((key.to_owned(), scalar(value)?));
        }
    }
    Ok(fields)
}

fn scalar(value: &str) -> Result<String, String> {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|item| item.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|item| item.strip_suffix('\''))
        })
        .unwrap_or(value)
        .trim();
    if value.is_empty() {
        Err("empty YAML scalar".to_owned())
    } else {
        Ok(value.to_owned())
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn infer(path: &str, source: &str, facts: &mut BTreeSet<MetadataFact>) {
    if let Some(name) = path
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
    {
        facts.insert(new_fact(
            "filename",
            name,
            FactProvenance::Filename,
            FactConfidence::High,
        ));
    }
    let mut rust_test = false;
    let mut dependencies = false;
    for line in source.lines() {
        let line = line.trim();
        if path.ends_with("Cargo.toml") && line.starts_with('[') && line.ends_with(']') {
            dependencies = matches!(
                line,
                "[dependencies]" | "[dev-dependencies]" | "[build-dependencies]"
            );
            continue;
        }
        if dependencies && path.ends_with("Cargo.toml") {
            if let Some((name, _)) = line.split_once('=') {
                let name = name.trim();
                if valid_key(name) {
                    facts.insert(new_fact(
                        "dependency",
                        name,
                        FactProvenance::Dependency,
                        FactConfidence::Medium,
                    ));
                }
            }
        }
        if line == "#[test]" {
            rust_test = true;
            continue;
        }
        if let Some(name) = symbol(line) {
            facts.insert(new_fact(
                "symbol",
                name,
                FactProvenance::Symbol,
                FactConfidence::Medium,
            ));
            if rust_test {
                facts.insert(new_fact(
                    "test",
                    name,
                    FactProvenance::Test,
                    FactConfidence::High,
                ));
            }
        }
        rust_test = false;
        if let Some(name) = imported(line) {
            facts.insert(new_fact(
                "import",
                name,
                FactProvenance::Import,
                FactConfidence::Low,
            ));
        }
        if let Some(name) = line
            .strip_prefix("def test_")
            .map(identifier)
            .filter(|name| !name.is_empty())
        {
            facts.insert(new_fact(
                "test",
                name,
                FactProvenance::Test,
                FactConfidence::High,
            ));
        }
    }
}

fn symbol(line: &str) -> Option<&str> {
    let line = line.strip_prefix("pub ").unwrap_or(line);
    [
        "fn ",
        "struct ",
        "enum ",
        "trait ",
        "class ",
        "def ",
        "function ",
    ]
    .iter()
    .find_map(|prefix| line.strip_prefix(prefix).map(identifier))
    .filter(|name| !name.is_empty())
}

fn imported(line: &str) -> Option<&str> {
    let value = line
        .strip_prefix("use ")
        .map(|item| item.trim_end_matches(';'))
        .or_else(|| line.strip_prefix("import "))
        .or_else(|| line.strip_prefix("from "))
        .or_else(|| {
            line.strip_prefix("require(").map(|item| {
                item.trim_start_matches(['\'', '"'])
                    .split(['\'', '"'])
                    .next()
                    .unwrap_or("")
            })
        })?;
    value
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty())
}

fn identifier(value: &str) -> &str {
    let end = value
        .bytes()
        .position(|byte| !(byte.is_ascii_alphanumeric() || byte == b'_'))
        .unwrap_or(value.len());
    &value[..end]
}

fn boundary(path: &str, source: &str, facts: &mut BTreeSet<MetadataFact>) {
    let path = path.to_ascii_lowercase();
    if [
        ".github/",
        "auth",
        "ci/",
        "credential",
        "deploy",
        "infra/",
        "policy",
        "secret",
        "security",
        "workflow",
        "cargo.toml",
    ]
    .iter()
    .any(|marker| path.contains(marker))
        || source.contains("BEGIN PRIVATE KEY")
    {
        facts.insert(new_fact(
            "important_boundary",
            "true",
            FactProvenance::BoundaryClassification,
            FactConfidence::Medium,
        ));
    }
}

fn resolve(facts: &mut BTreeSet<MetadataFact>, warnings: &mut BTreeSet<String>) {
    let mut values = BTreeMap::<String, BTreeSet<String>>::new();
    let mut declared = BTreeSet::new();
    for fact in facts.iter() {
        if !multiple(&fact.key) {
            values
                .entry(fact.key.clone())
                .or_default()
                .insert(fact.value.clone());
            if matches!(
                fact.provenance,
                FactProvenance::MarkdownFrontmatter | FactProvenance::CommentedYaml
            ) {
                declared.insert(fact.key.clone());
            }
        }
    }
    let conflicts: BTreeSet<String> = values
        .into_iter()
        .filter_map(|(key, values)| (values.len() > 1 && declared.contains(&key)).then_some(key))
        .collect();
    if conflicts.is_empty() {
        return;
    }
    let mut normalized = BTreeSet::new();
    for mut fact in std::mem::take(facts) {
        if conflicts.contains(&fact.key) {
            fact.state = FactState::Ambiguous;
        }
        normalized.insert(fact);
    }
    for key in conflicts {
        warnings.insert(format!("ambiguous-fact: conflicting declared or inferred singleton {key}; no value is verified"));
    }
    *facts = normalized;
}

fn multiple(key: &str) -> bool {
    matches!(key, "tags" | "symbol" | "import" | "test" | "dependency")
}

fn new_fact(
    key: impl Into<String>,
    value: impl Into<String>,
    provenance: FactProvenance,
    confidence: FactConfidence,
) -> MetadataFact {
    MetadataFact {
        key: key.into(),
        value: value.into(),
        provenance,
        confidence,
        state: FactState::Candidate,
    }
}

fn proposal(path: &str) -> String {
    if path.ends_with(".md") || path.ends_with(".markdown") {
        "---\ntype: TODO\npublic_boundary: TODO\n---".to_owned()
    } else {
        "// ---\n// type: TODO\n// public_boundary: TODO\n// ---".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact<'a>(
        report: &'a MetadataReport,
        key: &str,
        value: &str,
        provenance: FactProvenance,
    ) -> &'a MetadataFact {
        report
            .facts
            .iter()
            .find(|item| item.key == key && item.value == value && item.provenance == provenance)
            .expect("expected fact")
    }

    fn warning(report: &MetadataReport, prefix: &str) -> bool {
        report.warnings.iter().any(|item| item.starts_with(prefix))
    }

    fn contains(
        report: &MetadataReport,
        key: &str,
        value: &str,
        provenance: FactProvenance,
    ) -> bool {
        report
            .facts
            .iter()
            .any(|item| item.key == key && item.value == value && item.provenance == provenance)
    }

    #[test]
    fn p2_metadata() {
        let defaults = PackageDefaults::new([
            ("owner".to_owned(), "platform".to_owned()),
            ("type".to_owned(), "default".to_owned()),
        ]);
        let registry = MetadataParserRegistry::new(256);
        let markdown = registry.parse(
            "docs/security.md",
            "---\ntype: guide\ntags: [security, public]\nfilename: declared.md\n---\n# Security\n",
            &defaults,
        );
        assert_eq!(
            fact(
                &markdown,
                "type",
                "guide",
                FactProvenance::MarkdownFrontmatter
            )
            .state,
            FactState::Candidate
        );
        assert_eq!(
            fact(
                &markdown,
                "owner",
                "platform",
                FactProvenance::PackageDefault
            )
            .state,
            FactState::Candidate
        );
        assert!(!contains(
            &markdown,
            "type",
            "default",
            FactProvenance::PackageDefault
        ));
        assert_eq!(
            fact(
                &markdown,
                "tags",
                "security",
                FactProvenance::MarkdownFrontmatter
            )
            .state,
            FactState::Candidate
        );
        assert_eq!(
            fact(
                &markdown,
                "tags",
                "public",
                FactProvenance::MarkdownFrontmatter
            )
            .state,
            FactState::Candidate
        );
        assert_eq!(
            fact(
                &markdown,
                "filename",
                "declared.md",
                FactProvenance::MarkdownFrontmatter
            )
            .state,
            FactState::Ambiguous
        );
        assert_eq!(
            fact(
                &markdown,
                "important_boundary",
                "true",
                FactProvenance::BoundaryClassification
            )
            .confidence,
            FactConfidence::Medium
        );
        assert!(warning(&markdown, "ambiguous-fact:"));
        let commented = registry.parse(
            "src/auth/service.rs",
            "// ---\n// type: service\n// ---\nuse crate::token;\n#[test]\nfn checks_token() {}\n",
            &defaults,
        );
        assert_eq!(
            fact(&commented, "type", "service", FactProvenance::CommentedYaml).state,
            FactState::Candidate
        );
        assert_eq!(
            fact(&commented, "symbol", "checks_token", FactProvenance::Symbol).state,
            FactState::Candidate
        );
        assert_eq!(
            fact(&commented, "import", "crate::token", FactProvenance::Import).state,
            FactState::Candidate
        );
        assert_eq!(
            fact(&commented, "test", "checks_token", FactProvenance::Test).state,
            FactState::Candidate
        );
        assert_eq!(
            fact(
                &commented,
                "important_boundary",
                "true",
                FactProvenance::BoundaryClassification
            )
            .state,
            FactState::Candidate
        );
        let dependencies = registry.parse(
            "Cargo.toml",
            "[dependencies]\nserde = \"1\"\n[dev-dependencies]\ninsta = \"1\"\n",
            &defaults,
        );
        assert_eq!(
            fact(
                &dependencies,
                "dependency",
                "serde",
                FactProvenance::Dependency
            )
            .state,
            FactState::Candidate
        );
        assert_eq!(
            fact(
                &dependencies,
                "dependency",
                "insta",
                FactProvenance::Dependency
            )
            .state,
            FactState::Candidate
        );
        assert_eq!(dependencies.proposals.len(), 1);
        assert!(warning(&dependencies, "metadata-on-touch:"));
        let malformed = registry.parse("src/lib.rs", "---\ntype: [\n---\n", &defaults);
        assert!(warning(&malformed, "malformed-metadata:"));
        let oversized = registry.parse("src/large.rs", &"x".repeat(257), &defaults);
        assert!(oversized.facts.is_empty());
        assert!(oversized.warnings[0].starts_with("input-too-large:"));
    }
}
