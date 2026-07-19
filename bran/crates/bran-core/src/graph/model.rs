//! Immutable, scanner-neutral graph input and topology records.

use std::collections::BTreeMap;
use std::fmt;

/// A stable graph identity accepted at the scanner-to-graph boundary.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NodeId(String);

impl NodeId {
    pub fn parse(value: impl Into<String>) -> Result<Self, GraphError> {
        let value = value.into();
        if valid_identity(&value) {
            Ok(Self(value))
        } else {
            Err(GraphError::InvalidNodeId(value))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A stable graph edge identity accepted at the scanner-to-graph boundary.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EdgeId(String);

impl EdgeId {
    pub fn parse(value: impl Into<String>) -> Result<Self, GraphError> {
        let value = value.into();
        if valid_identity(&value) {
            Ok(Self(value))
        } else {
            Err(GraphError::InvalidEdgeId(value))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The role a node plays in the scanned knowledge graph.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodeRole {
    Document,
    Section,
    Symbol,
    External,
    Entrypoint,
    Test,
    Generated,
    Archived,
}

/// Bounded scanner-supplied semantic facts. Values remain free-form evidence,
/// not graph-owned classifications or an ontology.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NodeFacts {
    fields: BTreeMap<String, Vec<String>>,
    semantic_bytes: usize,
}

impl NodeFacts {
    /// Maximum number of distinct semantic keys carried by one node.
    pub const MAX_FIELDS: usize = 32;
    /// Maximum UTF-8 byte length of one semantic key.
    pub const MAX_FIELD_KEY_BYTES: usize = 64;
    /// Maximum Unicode scalar count of one semantic key.
    pub const MAX_FIELD_KEY_CHARS: usize = 64;
    /// Maximum distinct values retained for one semantic key.
    pub const MAX_VALUES_PER_FIELD: usize = 32;
    /// Maximum UTF-8 byte length of one semantic value.
    pub const MAX_VALUE_BYTES: usize = 256;
    /// Maximum UTF-8 payload bytes: every stored key plus every stored value.
    pub const MAX_SEMANTIC_BYTES: usize = 8 * 1024;

    /// Adds one value to a semantic key. Keys and values are retained in
    /// lexical order and duplicate values are ignored, so lookup is stable.
    pub fn with_field_value(
        mut self,
        key: impl Into<String>,
        value: impl Into<String>,
    ) -> Result<Self, GraphError> {
        let key = valid_fact_key(key.into())?;
        let value = valid_fact_value(&key, value.into())?;
        let new_field = !self.fields.contains_key(&key);
        if let Some(values) = self.fields.get(&key) {
            if values.contains(&value) {
                return Ok(self);
            }
            if values.len() == Self::MAX_VALUES_PER_FIELD {
                return Err(GraphError::FactValuesPerFieldExceeded {
                    key,
                    limit: Self::MAX_VALUES_PER_FIELD,
                });
            }
        } else if self.fields.len() == Self::MAX_FIELDS {
            return Err(GraphError::FactFieldLimitExceeded {
                limit: Self::MAX_FIELDS,
            });
        }

        let additional_bytes = value.len() + usize::from(new_field) * key.len();
        let actual = self.semantic_bytes.saturating_add(additional_bytes);
        if actual > Self::MAX_SEMANTIC_BYTES {
            return Err(GraphError::SemanticByteLimitExceeded {
                limit: Self::MAX_SEMANTIC_BYTES,
                actual,
            });
        }

        let values = self.fields.entry(key).or_default();
        values.push(value);
        values.sort();
        self.semantic_bytes = actual;
        Ok(self)
    }

    /// Returns the exact values for a semantic key, in stable lexical order.
    pub fn values(&self, key: &str) -> Option<&[String]> {
        self.fields.get(key).map(Vec::as_slice)
    }

    /// Returns whether the exact semantic key has the exact supplied value.
    pub fn contains_value(&self, key: &str, value: &str) -> bool {
        self.values(key).is_some_and(|values| {
            values
                .binary_search_by(|item| item.as_str().cmp(value))
                .is_ok()
        })
    }

    /// Returns the bounded semantic payload byte count.
    pub fn semantic_bytes(&self) -> usize {
        self.semantic_bytes
    }

    pub fn with_status(self, value: impl Into<String>) -> Result<Self, GraphError> {
        self.replace_single_value("status", value.into())
    }

    pub fn with_tag(self, value: impl Into<String>) -> Result<Self, GraphError> {
        self.with_field_value("tags", value)
    }

    pub fn with_freshness(self, value: impl Into<String>) -> Result<Self, GraphError> {
        self.replace_single_value("freshness", value.into())
    }

    pub fn with_subsystem(self, value: impl Into<String>) -> Result<Self, GraphError> {
        self.replace_single_value("subsystem", value.into())
    }

    pub fn with_purpose(self, value: impl Into<String>) -> Result<Self, GraphError> {
        self.replace_single_value("purpose", value.into())
    }

    pub fn with_task(self, value: impl Into<String>) -> Result<Self, GraphError> {
        self.replace_single_value("task", value.into())
    }

    pub fn with_audience(self, value: impl Into<String>) -> Result<Self, GraphError> {
        self.replace_single_value("audience", value.into())
    }

    pub fn status(&self) -> Option<&str> {
        self.values("status")
            .and_then(|values| values.first())
            .map(String::as_str)
    }
    pub fn tags(&self) -> &[String] {
        self.values("tags").unwrap_or(&[])
    }
    pub fn freshness(&self) -> Option<&str> {
        self.values("freshness")
            .and_then(|values| values.first())
            .map(String::as_str)
    }
    pub fn subsystem(&self) -> Option<&str> {
        self.values("subsystem")
            .and_then(|values| values.first())
            .map(String::as_str)
    }
    pub fn purpose(&self) -> Option<&str> {
        self.values("purpose")
            .and_then(|values| values.first())
            .map(String::as_str)
    }
    pub fn task(&self) -> Option<&str> {
        self.values("task")
            .and_then(|values| values.first())
            .map(String::as_str)
    }
    pub fn audience(&self) -> Option<&str> {
        self.values("audience")
            .and_then(|values| values.first())
            .map(String::as_str)
    }

    fn replace_single_value(mut self, key: &str, value: String) -> Result<Self, GraphError> {
        if let Some(values) = self.fields.remove(key) {
            self.semantic_bytes -= key.len() + values.iter().map(String::len).sum::<usize>();
        }
        self.with_field_value(key, value)
    }
}

/// Scanner evidence carried through graph construction without interpretation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Provenance {
    source: String,
    locator: String,
}

impl Provenance {
    /// Maximum UTF-8 bytes accepted for a scanner/provider name.
    pub const MAX_SOURCE_BYTES: usize = 128;
    /// Maximum UTF-8 bytes accepted for a source locator.
    pub const MAX_LOCATOR_BYTES: usize = 1_024;

    pub fn new(source: impl Into<String>, locator: impl Into<String>) -> Result<Self, GraphError> {
        let source = source.into();
        let locator = locator.into();
        if source.trim().is_empty()
            || locator.trim().is_empty()
            || source.len() > Self::MAX_SOURCE_BYTES
            || locator.len() > Self::MAX_LOCATOR_BYTES
        {
            return Err(GraphError::InvalidProvenance);
        }
        Ok(Self { source, locator })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn locator(&self) -> &str {
        &self.locator
    }
}

/// A bounded scanner confidence score, preserved without graph-side inference.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Confidence(u8);

impl Confidence {
    pub fn new(value: u8) -> Result<Self, GraphError> {
        if value <= 100 {
            Ok(Self(value))
        } else {
            Err(GraphError::InvalidConfidence(value))
        }
    }

    pub fn value(self) -> u8 {
        self.0
    }
}

/// The certainty of a candidate edge. No variant authorizes graph repair.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EdgeCertainty {
    Known,
    Dynamic,
    Unknown,
    MissingTarget,
}

/// Directed scanner-supplied relationship meaning. `Unspecified` preserves
/// compatibility for callers that only have topology and certainty evidence.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum EdgeRelationship {
    #[default]
    Unspecified,
    Dependency,
    Implementation,
    Replacement,
    Supersedes,
    Validation,
    Reachability,
    Contradiction,
    Conflict,
}

/// Immutable scanner-neutral node input retained by the graph.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeInput {
    id: NodeId,
    role: NodeRole,
    provenance: Provenance,
    confidence: Confidence,
    facts: NodeFacts,
}

impl NodeInput {
    pub fn new(id: NodeId, role: NodeRole, provenance: Provenance, confidence: Confidence) -> Self {
        Self {
            id,
            role,
            provenance,
            confidence,
            facts: NodeFacts::default(),
        }
    }

    pub fn with_facts(mut self, facts: NodeFacts) -> Self {
        self.facts = facts;
        self
    }

    pub fn id(&self) -> &NodeId {
        &self.id
    }
    pub fn role(&self) -> NodeRole {
        self.role
    }
    pub fn provenance(&self) -> &Provenance {
        &self.provenance
    }
    pub fn confidence(&self) -> Confidence {
        self.confidence
    }
    pub fn facts(&self) -> &NodeFacts {
        &self.facts
    }
}

/// Immutable scanner-neutral edge input retained by the graph.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EdgeInput {
    id: EdgeId,
    source: NodeId,
    target: NodeId,
    provenance: Provenance,
    confidence: Confidence,
    certainty: EdgeCertainty,
    relationship: EdgeRelationship,
}

impl EdgeInput {
    pub fn new(
        id: EdgeId,
        source: NodeId,
        target: NodeId,
        provenance: Provenance,
        confidence: Confidence,
        certainty: EdgeCertainty,
    ) -> Self {
        Self {
            id,
            source,
            target,
            provenance,
            confidence,
            certainty,
            relationship: EdgeRelationship::Unspecified,
        }
    }

    pub fn with_relationship(mut self, relationship: EdgeRelationship) -> Self {
        self.relationship = relationship;
        self
    }

    pub fn id(&self) -> &EdgeId {
        &self.id
    }
    pub fn source(&self) -> &NodeId {
        &self.source
    }
    pub fn target(&self) -> &NodeId {
        &self.target
    }
    pub fn provenance(&self) -> &Provenance {
        &self.provenance
    }
    pub fn confidence(&self) -> Confidence {
        self.confidence
    }
    pub fn certainty(&self) -> EdgeCertainty {
        self.certainty
    }
    pub fn relationship(&self) -> EdgeRelationship {
        self.relationship
    }
}

/// Narrow scanner adapter boundary: data only, without filesystem semantics.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GraphInput {
    nodes: Vec<NodeInput>,
    edges: Vec<EdgeInput>,
}

impl GraphInput {
    pub fn new(nodes: Vec<NodeInput>, edges: Vec<EdgeInput>) -> Self {
        Self { nodes, edges }
    }
    pub fn nodes(&self) -> &[NodeInput] {
        &self.nodes
    }
    pub fn edges(&self) -> &[EdgeInput] {
        &self.edges
    }
    pub(super) fn into_parts(self) -> (Vec<NodeInput>, Vec<EdgeInput>) {
        (self.nodes, self.edges)
    }
}

/// Explicit resource bounds for deterministic graph construction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GraphLimits {
    max_nodes: usize,
    max_edges: usize,
}

impl GraphLimits {
    pub fn new(max_nodes: usize, max_edges: usize) -> Result<Self, GraphError> {
        if max_nodes == 0 || max_edges == 0 {
            return Err(GraphError::InvalidLimits);
        }
        Ok(Self {
            max_nodes,
            max_edges,
        })
    }

    pub fn max_nodes(self) -> usize {
        self.max_nodes
    }
    pub fn max_edges(self) -> usize {
        self.max_edges
    }
}

/// Construction failures; all ambiguity remains represented, never repaired.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GraphError {
    InvalidNodeId(String),
    InvalidEdgeId(String),
    InvalidProvenance,
    InvalidConfidence(u8),
    InvalidFactKey(String),
    InvalidFactValue { key: String, value: String },
    FactFieldLimitExceeded { limit: usize },
    FactValuesPerFieldExceeded { key: String, limit: usize },
    SemanticByteLimitExceeded { limit: usize, actual: usize },
    InvalidLimits,
    NodeLimitExceeded { limit: usize, actual: usize },
    EdgeLimitExceeded { limit: usize, actual: usize },
    DuplicateNodeId(NodeId),
    DuplicateEdgeId(EdgeId),
    MissingSource(NodeId),
    MissingTargetMustBeExplicit { edge: EdgeId, target: NodeId },
    MissingTargetMustBeAbsent { edge: EdgeId, target: NodeId },
}

impl fmt::Display for GraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidNodeId(id) => write!(f, "invalid node identity: {id}"),
            Self::InvalidEdgeId(id) => write!(f, "invalid edge identity: {id}"),
            Self::InvalidProvenance => write!(
                f,
                "provenance source and locator must be nonblank and at most {} and {} bytes",
                Provenance::MAX_SOURCE_BYTES,
                Provenance::MAX_LOCATOR_BYTES
            ),
            Self::InvalidConfidence(value) => write!(f, "confidence must be at most 100: {value}"),
            Self::InvalidFactKey(key) => write!(
                f,
                "semantic key must be nonblank and at most {} bytes and {} characters: {key}",
                NodeFacts::MAX_FIELD_KEY_BYTES,
                NodeFacts::MAX_FIELD_KEY_CHARS,
            ),
            Self::InvalidFactValue { key, value } => write!(
                f,
                "{key} semantic value must be nonblank and at most {} bytes: {value}",
                NodeFacts::MAX_VALUE_BYTES
            ),
            Self::FactFieldLimitExceeded { limit } => {
                write!(f, "semantic field limit exceeded: {limit}")
            }
            Self::FactValuesPerFieldExceeded { key, limit } => {
                write!(f, "semantic value limit exceeded for {key}: {limit}")
            }
            Self::SemanticByteLimitExceeded { limit, actual } => {
                write!(f, "semantic byte limit {limit} exceeded: {actual}")
            }
            Self::InvalidLimits => write!(f, "node and edge limits must be nonzero"),
            Self::NodeLimitExceeded { limit, actual } => {
                write!(f, "node limit {limit} exceeded by {actual}")
            }
            Self::EdgeLimitExceeded { limit, actual } => {
                write!(f, "edge limit {limit} exceeded by {actual}")
            }
            Self::DuplicateNodeId(id) => write!(f, "duplicate node identity: {id:?}"),
            Self::DuplicateEdgeId(id) => write!(f, "duplicate edge identity: {id:?}"),
            Self::MissingSource(id) => write!(f, "edge source is not a graph node: {id:?}"),
            Self::MissingTargetMustBeExplicit { edge, target } => write!(
                f,
                "edge {edge:?} references absent target {target:?} without MissingTarget certainty"
            ),
            Self::MissingTargetMustBeAbsent { edge, target } => write!(
                f,
                "edge {edge:?} marks present target {target:?} MissingTarget"
            ),
        }
    }
}

impl std::error::Error for GraphError {}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'/' | b':' | b'_' | b'-')
        })
}

fn valid_fact_key(key: String) -> Result<String, GraphError> {
    if key.trim().is_empty()
        || key.len() > NodeFacts::MAX_FIELD_KEY_BYTES
        || key.chars().count() > NodeFacts::MAX_FIELD_KEY_CHARS
    {
        Err(GraphError::InvalidFactKey(key))
    } else {
        Ok(key)
    }
}

fn valid_fact_value(key: &str, value: String) -> Result<String, GraphError> {
    if value.trim().is_empty() || value.len() > NodeFacts::MAX_VALUE_BYTES {
        Err(GraphError::InvalidFactValue {
            key: key.to_owned(),
            value,
        })
    } else {
        Ok(value)
    }
}
