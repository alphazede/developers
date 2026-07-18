//! Immutable, scanner-neutral graph input and topology records.

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

/// Scanner evidence carried through graph construction without interpretation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Provenance {
    source: String,
    locator: String,
}

impl Provenance {
    pub fn new(source: impl Into<String>, locator: impl Into<String>) -> Result<Self, GraphError> {
        let source = source.into();
        let locator = locator.into();
        if source.trim().is_empty() || locator.trim().is_empty() {
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

/// Immutable scanner-neutral node input retained by the graph.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeInput {
    id: NodeId,
    role: NodeRole,
    provenance: Provenance,
    confidence: Confidence,
}

impl NodeInput {
    pub fn new(id: NodeId, role: NodeRole, provenance: Provenance, confidence: Confidence) -> Self {
        Self {
            id,
            role,
            provenance,
            confidence,
        }
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
        }
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
            Self::InvalidProvenance => write!(f, "provenance source and locator must not be blank"),
            Self::InvalidConfidence(value) => write!(f, "confidence must be at most 100: {value}"),
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
