//! Deterministic, dependency-free context packet assembly.
//!
//! Packet assembly consumes a compiled view and caller-supplied evidence bytes.
//! It deliberately has no SQZ, provider, filesystem, or persisted-token-policy
//! dependency; compression and provider telemetry are separate adapter concerns.

use crate::graph::{EdgeCertainty, EdgeRelationship, KnowledgeGraph, NodeId, Provenance};
use crate::view::CompiledView;
use std::collections::{BTreeMap, BTreeSet};

pub const PACKET_RECEIPT_SCHEMA_VERSION: &str = "1.0.0";

/// The selection class assigned by the caller to evidence for a view node.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum EvidencePriority {
    Required,
    Recommended,
    Related,
}

const MAX_PRESERVATION_ANCHOR_ID_BYTES: usize = 64;
const MAX_PRESERVATION_ANCHOR_VALUE_BYTES: usize = 512;

/// A bounded semantic fact whose value must survive compression.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreservationAnchor {
    id: String,
    value: String,
}

impl PreservationAnchor {
    pub fn new(
        id: impl Into<String>,
        value: impl Into<String>,
    ) -> Result<Self, PreservationAnchorError> {
        let id = id.into();
        let value = value.into();
        if id.is_empty() || id.len() > MAX_PRESERVATION_ANCHOR_ID_BYTES {
            return Err(PreservationAnchorError::InvalidIdLength);
        }
        if !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(PreservationAnchorError::InvalidIdCharacter);
        }
        if value.trim().is_empty() {
            return Err(PreservationAnchorError::BlankValue);
        }
        if value.len() > MAX_PRESERVATION_ANCHOR_VALUE_BYTES {
            return Err(PreservationAnchorError::ValueTooLong);
        }
        Ok(Self { id, value })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreservationAnchorError {
    InvalidIdLength,
    InvalidIdCharacter,
    BlankValue,
    ValueTooLong,
}

/// Caller-supplied content and ranking facts for one selected view node.
///
/// Larger authority and freshness values take precedence within an equal
/// [`EvidencePriority`]. Node identity is the final stable tie-break.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvidenceContent {
    pub id: NodeId,
    pub content: String,
    pub priority: EvidencePriority,
    pub authority: u64,
    pub freshness: u64,
    pub preservation_anchors: Vec<PreservationAnchor>,
}

impl EvidenceContent {
    pub fn new(
        id: NodeId,
        content: impl Into<String>,
        priority: EvidencePriority,
        authority: u64,
        freshness: u64,
        preservation_anchors: Vec<PreservationAnchor>,
    ) -> Self {
        Self {
            id,
            content: content.into(),
            priority,
            authority,
            freshness,
            preservation_anchors,
        }
    }
}

/// Runtime assembly limits. Token ceilings are intentionally not a ViewSpec field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PacketLimits {
    pub max_items: usize,
    pub max_bytes: usize,
    pub runtime_token_ceiling: Option<usize>,
}

impl PacketLimits {
    pub fn new(max_items: usize, max_bytes: usize, runtime_token_ceiling: Option<usize>) -> Self {
        Self {
            max_items,
            max_bytes,
            runtime_token_ceiling,
        }
    }
}

/// Input to one packet assembly attempt.
#[derive(Clone, Debug)]
pub struct PacketAssemblyRequest<'a> {
    pub view: &'a CompiledView,
    pub graph: &'a KnowledgeGraph,
    pub evidence: &'a [EvidenceContent],
    pub limits: PacketLimits,
    pub dependency_limits: DependencyClosureLimits,
}

/// Validated limits for dependency expansion beyond compiled View seeds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DependencyClosureLimits {
    max_depth: usize,
    max_nodes: usize,
}

impl DependencyClosureLimits {
    pub const HARD_MAX_DEPTH: usize = 64;
    pub const HARD_MAX_NODES: usize = 4_096;

    pub fn new(max_depth: usize, max_nodes: usize) -> Result<Self, PacketError> {
        if max_depth > Self::HARD_MAX_DEPTH || max_nodes == 0 || max_nodes > Self::HARD_MAX_NODES {
            return Err(PacketError::InvalidDependencyClosureLimits {
                max_depth,
                max_nodes,
            });
        }
        Ok(Self {
            max_depth,
            max_nodes,
        })
    }

    pub fn max_depth(self) -> usize {
        self.max_depth
    }

    pub fn max_nodes(self) -> usize {
        self.max_nodes
    }
}

/// The bound that rejected a load-bearing evidence item.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PacketBound {
    Items,
    Bytes,
    RuntimeTokens,
}

/// Explicit receipt method for the non-provider token estimate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TokenEstimateMethod {
    BytesDividedByFourCeiling,
}

/// A selected evidence item with immutable graph provenance retained verbatim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextItem {
    pub id: NodeId,
    pub provenance: Provenance,
    pub content: String,
    pub priority: EvidencePriority,
    pub authority: u64,
    pub freshness: u64,
    pub preservation_anchors: Vec<PreservationAnchor>,
    pub raw_bytes: usize,
}

/// Deterministic accounting for one context packet.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PacketReceipt {
    pub schema_version: &'static str,
    pub seed_ids: Vec<NodeId>,
    pub admitted_dependency_ids: Vec<NodeId>,
    pub selected_ids: Vec<NodeId>,
    pub omitted_ids: Vec<NodeId>,
    pub dependency_closure_truncated: bool,
    pub dependency_max_depth: usize,
    pub dependency_max_nodes: usize,
    pub raw_bytes: usize,
    pub estimated_tokens: usize,
    pub token_estimate_method: TokenEstimateMethod,
    pub effective_max_items: usize,
    pub effective_max_bytes: usize,
    pub runtime_token_ceiling: Option<usize>,
    pub truncated: bool,
}

/// A provider-neutral payload plus its lossless identity and provenance record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextPacket {
    pub items: Vec<ContextItem>,
    pub payload: String,
    pub receipt: PacketReceipt,
}

/// Deterministic packet assembly failures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PacketError {
    InvalidDependencyClosureLimits {
        max_depth: usize,
        max_nodes: usize,
    },
    ViewSeedNotInGraph(NodeId),
    MissingSelectedEvidence(NodeId),
    DuplicateSelectedEvidence(NodeId),
    EvidenceNotInView(NodeId),
    UnrelatedEvidence(NodeId),
    RequiredEvidenceMissingPreservationAnchors(NodeId),
    PreservationAnchorNotInEvidence {
        evidence_id: NodeId,
        anchor_id: String,
    },
    RequiredEvidenceDoesNotFit {
        id: NodeId,
        bound: PacketBound,
    },
    ArithmeticOverflow {
        operation: &'static str,
    },
}

/// Stateless assembler for one compiled view and its external evidence content.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PacketAssembler;

impl PacketAssembler {
    pub fn new() -> Self {
        Self
    }

    /// Selects evidence by requiredness, authority, freshness, then node ID.
    ///
    /// Effective item and byte ceilings cannot relax the persisted view limits.
    /// A runtime token ceiling only narrows this individual assembly attempt.
    pub fn assemble(
        &self,
        request: &PacketAssemblyRequest<'_>,
    ) -> Result<ContextPacket, PacketError> {
        let closure = dependency_closure(request)?;
        let evidence = index_evidence(request, &closure.admitted_ids)?;
        let limits = effective_limits(request, closure.admitted_ids.len())?;
        let mut candidates = Vec::with_capacity(
            request
                .view
                .items()
                .len()
                .checked_add(closure.admitted_ids.len())
                .ok_or(PacketError::ArithmeticOverflow {
                    operation: "packet candidate capacity",
                })?,
        );
        for item in request.view.items() {
            candidates.push(Candidate {
                provenance: item.provenance.clone(),
                evidence: evidence
                    .get(&item.id)
                    .expect("seed evidence was validated before sorting"),
            });
        }
        for id in &closure.admitted_ids {
            let node = request
                .graph
                .node(id)
                .expect("admitted dependency is a present graph node");
            candidates.push(Candidate {
                provenance: node.provenance().clone(),
                evidence: evidence
                    .get(id)
                    .expect("dependency evidence was validated before sorting"),
            });
        }
        candidates.sort_by(candidate_order);

        let mut items = Vec::new();
        let mut payload = String::new();
        let mut selected_ids = Vec::new();
        let mut omitted_ids = Vec::new();
        let mut raw_bytes = 0usize;

        for candidate in candidates {
            let encoded = encode_item(
                &candidate.evidence.id,
                &candidate.provenance,
                candidate.evidence,
            );
            let next_bytes =
                raw_bytes
                    .checked_add(encoded.len())
                    .ok_or(PacketError::ArithmeticOverflow {
                        operation: "packet raw byte count",
                    })?;
            let next_tokens = estimate_tokens(next_bytes);
            let rejection = if items.len() == limits.max_items {
                Some(PacketBound::Items)
            } else if next_bytes > limits.max_bytes {
                Some(PacketBound::Bytes)
            } else if limits
                .runtime_token_ceiling
                .is_some_and(|ceiling| next_tokens > ceiling)
            {
                Some(PacketBound::RuntimeTokens)
            } else {
                None
            };

            if let Some(bound) = rejection {
                if candidate.evidence.priority == EvidencePriority::Required {
                    return Err(PacketError::RequiredEvidenceDoesNotFit {
                        id: candidate.evidence.id.clone(),
                        bound,
                    });
                }
                omitted_ids.push(candidate.evidence.id.clone());
                continue;
            }

            let item = ContextItem {
                id: candidate.evidence.id.clone(),
                provenance: candidate.provenance.clone(),
                content: candidate.evidence.content.clone(),
                priority: candidate.evidence.priority,
                authority: candidate.evidence.authority,
                freshness: candidate.evidence.freshness,
                preservation_anchors: candidate.evidence.preservation_anchors.clone(),
                raw_bytes: encoded.len(),
            };
            raw_bytes = next_bytes;
            payload.push_str(&encoded);
            selected_ids.push(item.id.clone());
            items.push(item);
        }

        let estimated_tokens = estimate_tokens(raw_bytes);
        let omitted_any = !omitted_ids.is_empty();
        Ok(ContextPacket {
            items,
            payload,
            receipt: PacketReceipt {
                schema_version: PACKET_RECEIPT_SCHEMA_VERSION,
                seed_ids: request
                    .view
                    .items()
                    .iter()
                    .map(|item| item.id.clone())
                    .collect(),
                admitted_dependency_ids: closure.admitted_ids,
                selected_ids,
                omitted_ids,
                dependency_closure_truncated: closure.truncated,
                dependency_max_depth: request.dependency_limits.max_depth(),
                dependency_max_nodes: request.dependency_limits.max_nodes(),
                raw_bytes,
                estimated_tokens,
                token_estimate_method: TokenEstimateMethod::BytesDividedByFourCeiling,
                effective_max_items: limits.max_items,
                effective_max_bytes: limits.max_bytes,
                runtime_token_ceiling: limits.runtime_token_ceiling,
                truncated: request.view.truncated() || closure.truncated || omitted_any,
            },
        })
    }
}

struct Candidate<'a> {
    provenance: Provenance,
    evidence: &'a EvidenceContent,
}

struct DependencyClosure {
    admitted_ids: Vec<NodeId>,
    truncated: bool,
}

fn dependency_closure(
    request: &PacketAssemblyRequest<'_>,
) -> Result<DependencyClosure, PacketError> {
    let seeds = request
        .view
        .items()
        .iter()
        .map(|item| item.id.clone())
        .collect::<BTreeSet<_>>();
    for seed in &seeds {
        if request.graph.node(seed).is_none() {
            return Err(PacketError::ViewSeedNotInGraph(seed.clone()));
        }
    }

    let mut visited = seeds.clone();
    let mut frontier = seeds.into_iter().map(|id| (id, 0usize)).collect::<Vec<_>>();
    let mut cursor = 0usize;
    let mut admitted = BTreeSet::new();
    let mut truncated = false;
    while cursor < frontier.len() {
        let (source, depth) = frontier[cursor].clone();
        cursor += 1;
        for edge_id in request.graph.forward_edges(&source) {
            let edge = request
                .graph
                .edge(edge_id)
                .expect("graph adjacency references a present edge");
            if edge.certainty() != EdgeCertainty::Known
                || !positive_context_relationship(edge.relationship())
                || request.graph.node(edge.target()).is_none()
                || visited.contains(edge.target())
            {
                continue;
            }
            if depth == request.dependency_limits.max_depth()
                || admitted.len() == request.dependency_limits.max_nodes()
            {
                truncated = true;
                continue;
            }
            let target = edge.target().clone();
            visited.insert(target.clone());
            admitted.insert(target.clone());
            frontier.push((target, depth + 1));
        }
    }
    Ok(DependencyClosure {
        admitted_ids: admitted.into_iter().collect(),
        truncated,
    })
}

fn positive_context_relationship(relationship: EdgeRelationship) -> bool {
    matches!(
        relationship,
        EdgeRelationship::Dependency
            | EdgeRelationship::Implementation
            | EdgeRelationship::Replacement
            | EdgeRelationship::Supersedes
            | EdgeRelationship::Validation
            | EdgeRelationship::Reachability
    )
}

fn index_evidence<'a>(
    request: &'a PacketAssemblyRequest<'a>,
    dependency_ids: &[NodeId],
) -> Result<BTreeMap<NodeId, &'a EvidenceContent>, PacketError> {
    let mut selected_ids = request
        .view
        .items()
        .iter()
        .map(|item| item.id.clone())
        .collect::<BTreeSet<_>>();
    selected_ids.extend(dependency_ids.iter().cloned());
    let mut evidence = BTreeMap::new();
    let mut duplicates = BTreeSet::new();
    for item in request.evidence {
        if evidence.insert(item.id.clone(), item).is_some() {
            duplicates.insert(item.id.clone());
        }
    }
    if let Some(id) = duplicates.into_iter().next() {
        return Err(PacketError::DuplicateSelectedEvidence(id));
    }
    for id in &selected_ids {
        if !evidence.contains_key(id) {
            return Err(PacketError::MissingSelectedEvidence(id.clone()));
        }
    }
    if let Some(id) = evidence.keys().find(|id| !selected_ids.contains(*id)) {
        return Err(PacketError::UnrelatedEvidence(id.clone()));
    }
    if let Some(item) = evidence.values().find(|item| {
        item.priority == EvidencePriority::Required && item.preservation_anchors.is_empty()
    }) {
        return Err(PacketError::RequiredEvidenceMissingPreservationAnchors(
            item.id.clone(),
        ));
    }
    if let Some((item, anchor)) = evidence.values().find_map(|item| {
        item.preservation_anchors
            .iter()
            .find(|anchor| !item.content.contains(anchor.value()))
            .map(|anchor| (*item, anchor))
    }) {
        return Err(PacketError::PreservationAnchorNotInEvidence {
            evidence_id: item.id.clone(),
            anchor_id: anchor.id().to_owned(),
        });
    }
    Ok(evidence)
}

fn effective_limits(
    request: &PacketAssemblyRequest<'_>,
    admitted_dependencies: usize,
) -> Result<PacketLimits, PacketError> {
    let expanded_view_ceiling = request
        .view
        .spec()
        .max_items
        .checked_add(admitted_dependencies)
        .ok_or(PacketError::ArithmeticOverflow {
            operation: "expanded packet item ceiling",
        })?;
    Ok(PacketLimits {
        max_items: request.limits.max_items.min(expanded_view_ceiling),
        max_bytes: request.limits.max_bytes.min(request.view.spec().max_bytes),
        runtime_token_ceiling: request.limits.runtime_token_ceiling,
    })
}

fn candidate_order(left: &Candidate<'_>, right: &Candidate<'_>) -> std::cmp::Ordering {
    left.evidence
        .priority
        .cmp(&right.evidence.priority)
        .then_with(|| right.evidence.authority.cmp(&left.evidence.authority))
        .then_with(|| right.evidence.freshness.cmp(&left.evidence.freshness))
        .then_with(|| left.evidence.id.cmp(&right.evidence.id))
}

fn encode_item(id: &NodeId, provenance: &Provenance, evidence: &EvidenceContent) -> String {
    format!(
        "node={}\nsource={}\nlocator={}\ncontent={}\n",
        id.as_str(),
        provenance.source(),
        provenance.locator(),
        evidence.content
    )
}

fn estimate_tokens(raw_bytes: usize) -> usize {
    raw_bytes / 4 + usize::from(!raw_bytes.is_multiple_of(4))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::sqz::{
        DlpStatus, FidelityStatus, SqzAdapter, SqzAdapterConfig, SqzFailureReason, SqzIdentity,
        SqzPolicy, SqzPort, SqzPortError, SqzPortErrorCode, SqzPortOutput, SqzStatus,
    };
    use crate::agent::result_store::ResultId;
    use crate::graph::{
        Confidence, EdgeCertainty, EdgeId, EdgeInput, EdgeRelationship, GraphInput, GraphLimits,
        KnowledgeGraph, NodeInput, NodeRole,
    };
    use crate::view::{
        Presentation, ViewCompiler, ViewField, ViewFilter, ViewGrouping, ViewSort, ViewSource,
        ViewSpec,
    };
    use std::cell::Cell;
    use std::rc::Rc;

    fn node_id(value: &str) -> NodeId {
        NodeId::parse(value).unwrap()
    }

    fn source(value: &str) -> Provenance {
        Provenance::new("scanner", value).unwrap()
    }

    fn anchor(id: &str, value: &str) -> PreservationAnchor {
        PreservationAnchor::new(id, value).unwrap()
    }

    fn compiled_packet_view() -> (KnowledgeGraph, CompiledView) {
        let graph = KnowledgeGraph::build(
            GraphInput::new(
                vec![
                    NodeInput::new(
                        node_id("node.alpha"),
                        NodeRole::Document,
                        source("alpha.md"),
                        Confidence::new(90).unwrap(),
                    ),
                    NodeInput::new(
                        node_id("node.beta"),
                        NodeRole::Section,
                        source("beta.md#one"),
                        Confidence::new(91).unwrap(),
                    ),
                    NodeInput::new(
                        node_id("node.delta"),
                        NodeRole::Symbol,
                        source("delta.rs:1"),
                        Confidence::new(92).unwrap(),
                    ),
                    NodeInput::new(
                        node_id("node.eta"),
                        NodeRole::Test,
                        source("eta.rs:1"),
                        Confidence::new(93).unwrap(),
                    ),
                    NodeInput::new(
                        node_id("node.gamma"),
                        NodeRole::Test,
                        source("gamma.rs:1"),
                        Confidence::new(94).unwrap(),
                    ),
                    NodeInput::new(
                        node_id("node.theta"),
                        NodeRole::External,
                        source("theta.txt"),
                        Confidence::new(95).unwrap(),
                    ),
                    NodeInput::new(
                        node_id("node.zeta"),
                        NodeRole::External,
                        source("zeta.txt"),
                        Confidence::new(96).unwrap(),
                    ),
                ],
                vec![],
            ),
            GraphLimits::new(7, 1).unwrap(),
        )
        .unwrap();
        let view = ViewCompiler::new()
            .compile(
                &ViewSpec {
                    source: ViewSource::All,
                    filter: ViewFilter::All,
                    sort: ViewSort::NodeId,
                    grouping: ViewGrouping::None,
                    fields: vec![ViewField::NodeId],
                    presentation: Presentation::Json,
                    max_items: 7,
                    max_bytes: 2_000,
                },
                &graph,
            )
            .unwrap();
        (graph, view)
    }

    fn dependency_limits() -> DependencyClosureLimits {
        DependencyClosureLimits::new(4, 16).unwrap()
    }

    fn edge_id(value: &str) -> EdgeId {
        EdgeId::parse(value).unwrap()
    }

    fn dependency_packet_fixture() -> (KnowledgeGraph, CompiledView, Vec<EvidenceContent>) {
        let seed = node_id("node.closure.seed");
        let dependency = node_id("node.closure.dependency");
        let unrelated = node_id("node.closure.unrelated");
        let graph = KnowledgeGraph::build(
            GraphInput::new(
                vec![
                    NodeInput::new(
                        seed.clone(),
                        NodeRole::Document,
                        source("seed.md"),
                        Confidence::new(100).unwrap(),
                    ),
                    NodeInput::new(
                        dependency.clone(),
                        NodeRole::Symbol,
                        source("dependency.rs:1"),
                        Confidence::new(100).unwrap(),
                    ),
                    NodeInput::new(
                        unrelated.clone(),
                        NodeRole::External,
                        source("unrelated.md"),
                        Confidence::new(20).unwrap(),
                    ),
                ],
                vec![
                    EdgeInput::new(
                        edge_id("edge.closure.dependency"),
                        seed.clone(),
                        dependency.clone(),
                        source("seed-to-dependency"),
                        Confidence::new(100).unwrap(),
                        EdgeCertainty::Known,
                    )
                    .with_relationship(EdgeRelationship::Dependency),
                    EdgeInput::new(
                        edge_id("edge.closure.cycle"),
                        dependency.clone(),
                        seed.clone(),
                        source("dependency-to-seed"),
                        Confidence::new(100).unwrap(),
                        EdgeCertainty::Known,
                    )
                    .with_relationship(EdgeRelationship::Implementation),
                    EdgeInput::new(
                        edge_id("edge.closure.uncertain"),
                        seed.clone(),
                        unrelated.clone(),
                        source("uncertain"),
                        Confidence::new(40).unwrap(),
                        EdgeCertainty::Unknown,
                    )
                    .with_relationship(EdgeRelationship::Reachability),
                    EdgeInput::new(
                        edge_id("edge.closure.conflict"),
                        seed.clone(),
                        unrelated.clone(),
                        source("conflict"),
                        Confidence::new(90).unwrap(),
                        EdgeCertainty::Known,
                    )
                    .with_relationship(EdgeRelationship::Conflict),
                ],
            ),
            GraphLimits::new(3, 4).unwrap(),
        )
        .unwrap();
        let view = ViewCompiler::new()
            .compile(
                &ViewSpec {
                    source: ViewSource::NodeIds(vec![seed.clone()]),
                    filter: ViewFilter::All,
                    sort: ViewSort::NodeId,
                    grouping: ViewGrouping::None,
                    fields: vec![ViewField::NodeId],
                    presentation: Presentation::Json,
                    max_items: 1,
                    max_bytes: 1_000,
                },
                &graph,
            )
            .unwrap();
        let evidence = vec![
            EvidenceContent::new(
                seed,
                "seed contract",
                EvidencePriority::Required,
                20,
                20,
                vec![anchor("required.seed", "seed contract")],
            ),
            EvidenceContent::new(
                dependency,
                "dependency contract",
                EvidencePriority::Required,
                10,
                10,
                vec![anchor("required.dependency", "dependency contract")],
            ),
            EvidenceContent::new(
                unrelated,
                "unrelated",
                EvidencePriority::Related,
                1,
                1,
                vec![],
            ),
        ];
        (graph, view, evidence)
    }

    fn packet_evidence() -> Vec<EvidenceContent> {
        vec![
            EvidenceContent::new(
                node_id("node.zeta"),
                "z".repeat(220),
                EvidencePriority::Related,
                1,
                1,
                vec![],
            ),
            EvidenceContent::new(
                node_id("node.eta"),
                "eta",
                EvidencePriority::Recommended,
                3,
                4,
                vec![],
            ),
            EvidenceContent::new(
                node_id("node.alpha"),
                "alpha",
                EvidencePriority::Required,
                9,
                3,
                vec![anchor("required.alpha", "alpha")],
            ),
            EvidenceContent::new(
                node_id("node.beta"),
                "beta",
                EvidencePriority::Required,
                9,
                7,
                vec![anchor("required.beta", "beta")],
            ),
            EvidenceContent::new(
                node_id("node.delta"),
                "delta",
                EvidencePriority::Required,
                5,
                99,
                vec![anchor("required.delta", "delta")],
            ),
            EvidenceContent::new(
                node_id("node.gamma"),
                "gamma",
                EvidencePriority::Required,
                9,
                7,
                vec![anchor("required.gamma", "gamma")],
            ),
            EvidenceContent::new(
                node_id("node.theta"),
                "theta",
                EvidencePriority::Related,
                4,
                8,
                vec![],
            ),
        ]
    }

    struct InMemorySqzPort {
        response: Result<SqzPortOutput, SqzPortError>,
        calls: Rc<Cell<usize>>,
    }

    impl InMemorySqzPort {
        fn output(payload: impl Into<String>) -> Self {
            let mut response = SqzPortOutput::new(payload, SqzIdentity::approved());
            response.actual_input_tokens = Some(111);
            response.actual_output_tokens = Some(17);
            Self {
                response: Ok(response),
                calls: Rc::new(Cell::new(0)),
            }
        }

        fn unavailable() -> Self {
            Self {
                response: Err(SqzPortError::new(SqzPortErrorCode::Unavailable)),
                calls: Rc::new(Cell::new(0)),
            }
        }
    }

    impl SqzPort for InMemorySqzPort {
        fn compress(&self, _input: &str) -> Result<SqzPortOutput, SqzPortError> {
            self.calls.set(self.calls.get() + 1);
            self.response.clone()
        }
    }

    fn sqz_config(policy: SqzPolicy, max_output_bytes: usize) -> SqzAdapterConfig {
        SqzAdapterConfig::new(
            policy,
            SqzIdentity::approved(),
            max_output_bytes,
            vec![
                anchor("global.beta-node", "node=node.beta"),
                anchor("global.gamma-node", "node=node.gamma"),
            ],
        )
    }

    #[test]
    fn p2_packet_sqz() {
        let public_fixture =
            include_str!("../../../../fixtures/packets/context-packet-sqz-v1.json");
        assert!(public_fixture.contains("\"schema_version\": \"1.0.0\""));
        assert!(public_fixture.contains("\"admitted_dependency_ids\""));
        assert!(public_fixture.contains("\"file:src/support.rs\""));
        assert!(
            public_fixture.contains("\"token_estimate_method\": \"bytes-divided-by-four-ceiling\"")
        );
        assert!(public_fixture.contains("\"actual_input_tokens\": null"));
        assert!(public_fixture.contains("\"fidelity_status\": \"passed\""));
        assert!(public_fixture.contains("\"dlp_status\": \"passed\""));
        assert_eq!(
            PreservationAnchor::new("blank.anchor", " \t"),
            Err(PreservationAnchorError::BlankValue)
        );
        let (graph, view) = compiled_packet_view();
        let evidence = packet_evidence();
        let assembler = PacketAssembler::new();
        let bounded = assembler
            .assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &evidence,
                limits: PacketLimits::new(6, 800, Some(200)),
                dependency_limits: dependency_limits(),
            })
            .unwrap();
        assert_eq!(
            bounded.receipt.schema_version,
            PACKET_RECEIPT_SCHEMA_VERSION
        );
        assert_eq!(bounded.items[0].id, node_id("node.beta"));
        assert_eq!(bounded.items[1].id, node_id("node.gamma"));
        assert_eq!(bounded.items[2].id, node_id("node.alpha"));
        assert_eq!(bounded.items[3].id, node_id("node.delta"));
        assert_eq!(bounded.items[4].id, node_id("node.eta"));
        assert_eq!(bounded.items[5].id, node_id("node.theta"));
        assert_eq!(bounded.items[0].provenance, source("beta.md#one"));
        assert_eq!(
            bounded.receipt.selected_ids,
            vec![
                node_id("node.beta"),
                node_id("node.gamma"),
                node_id("node.alpha"),
                node_id("node.delta"),
                node_id("node.eta"),
                node_id("node.theta"),
            ]
        );
        assert_eq!(bounded.receipt.omitted_ids, vec![node_id("node.zeta")]);
        assert_eq!(bounded.receipt.raw_bytes, bounded.payload.len());
        assert_eq!(
            bounded.receipt.estimated_tokens,
            bounded.receipt.raw_bytes.div_ceil(4)
        );
        assert!(bounded.receipt.raw_bytes <= 800);
        assert!(bounded.receipt.estimated_tokens <= 200);
        assert_eq!(
            bounded.receipt.token_estimate_method,
            TokenEstimateMethod::BytesDividedByFourCeiling
        );
        assert!(bounded.receipt.truncated);
        let item_limited = assembler
            .assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &evidence,
                limits: PacketLimits::new(5, 2_000, None),
                dependency_limits: dependency_limits(),
            })
            .unwrap();
        assert_eq!(
            item_limited.receipt.omitted_ids,
            vec![node_id("node.theta"), node_id("node.zeta")]
        );
        assert_eq!(item_limited.receipt.effective_max_items, 5);
        assert_eq!(
            assembler.assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &evidence,
                limits: PacketLimits::new(7, 2_000, Some(1)),
                dependency_limits: dependency_limits(),
            }),
            Err(PacketError::RequiredEvidenceDoesNotFit {
                id: node_id("node.beta"),
                bound: PacketBound::RuntimeTokens,
            })
        );
        let replay = assembler
            .assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &evidence,
                limits: PacketLimits::new(6, 800, Some(200)),
                dependency_limits: dependency_limits(),
            })
            .unwrap();
        assert_eq!(bounded, replay);
        let byte_limited = assembler
            .assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &evidence,
                limits: PacketLimits::new(7, 500, None),
                dependency_limits: dependency_limits(),
            })
            .unwrap();
        assert_eq!(byte_limited.receipt.omitted_ids, vec![node_id("node.zeta")]);
        assert!(byte_limited.receipt.raw_bytes <= 500);
        let token_limited = assembler
            .assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &evidence,
                limits: PacketLimits::new(7, 2_000, Some(120)),
                dependency_limits: dependency_limits(),
            })
            .unwrap();
        assert_eq!(
            token_limited.receipt.omitted_ids,
            vec![node_id("node.zeta")]
        );
        assert!(token_limited.receipt.estimated_tokens <= 120);
        let mut oversized_required = packet_evidence();
        oversized_required[3].content = format!("beta{}", "b".repeat(300));
        assert_eq!(
            assembler.assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &oversized_required,
                limits: PacketLimits::new(7, 200, None),
                dependency_limits: dependency_limits(),
            }),
            Err(PacketError::RequiredEvidenceDoesNotFit {
                id: node_id("node.beta"),
                bound: PacketBound::Bytes,
            })
        );
        assert_eq!(
            assembler.assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &evidence[1..],
                limits: PacketLimits::new(7, 2_000, None),
                dependency_limits: dependency_limits(),
            }),
            Err(PacketError::MissingSelectedEvidence(node_id("node.zeta")))
        );
        let mut duplicate = packet_evidence();
        duplicate.push(evidence[0].clone());
        assert_eq!(
            assembler.assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &duplicate,
                limits: PacketLimits::new(7, 2_000, None),
                dependency_limits: dependency_limits(),
            }),
            Err(PacketError::DuplicateSelectedEvidence(node_id("node.zeta")))
        );
        let mut unanchored_required = packet_evidence();
        unanchored_required[2].preservation_anchors.clear();
        assert_eq!(
            assembler.assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &unanchored_required,
                limits: PacketLimits::new(7, 2_000, None),
                dependency_limits: dependency_limits(),
            }),
            Err(PacketError::RequiredEvidenceMissingPreservationAnchors(
                node_id("node.alpha")
            ))
        );
        let mut absent_anchor_value = packet_evidence();
        absent_anchor_value[2].preservation_anchors =
            vec![anchor("required.alpha", "not-in-alpha-evidence")];
        assert_eq!(
            assembler.assemble(&PacketAssemblyRequest {
                view: &view,
                graph: &graph,
                evidence: &absent_anchor_value,
                limits: PacketLimits::new(7, 2_000, None),
                dependency_limits: dependency_limits(),
            }),
            Err(PacketError::PreservationAnchorNotInEvidence {
                evidence_id: node_id("node.alpha"),
                anchor_id: "required.alpha".to_owned(),
            })
        );

        let (closure_graph, closure_view, closure_evidence) = dependency_packet_fixture();
        let dependency_packet = assembler
            .assemble(&PacketAssemblyRequest {
                view: &closure_view,
                graph: &closure_graph,
                evidence: &closure_evidence[..2],
                limits: PacketLimits::new(2, 1_000, None),
                dependency_limits: DependencyClosureLimits::new(4, 2).unwrap(),
            })
            .unwrap();
        assert_eq!(
            dependency_packet.receipt.seed_ids,
            vec![node_id("node.closure.seed")]
        );
        assert_eq!(
            dependency_packet.receipt.admitted_dependency_ids,
            vec![node_id("node.closure.dependency")]
        );
        assert_eq!(
            dependency_packet.receipt.selected_ids,
            vec![
                node_id("node.closure.seed"),
                node_id("node.closure.dependency")
            ]
        );
        assert_eq!(
            dependency_packet.items[1].provenance,
            source("dependency.rs:1")
        );
        assert!(!dependency_packet.receipt.dependency_closure_truncated);
        assert_eq!(
            assembler.assemble(&PacketAssemblyRequest {
                view: &closure_view,
                graph: &closure_graph,
                evidence: &closure_evidence,
                limits: PacketLimits::new(3, 1_000, None),
                dependency_limits: DependencyClosureLimits::new(4, 2).unwrap(),
            }),
            Err(PacketError::UnrelatedEvidence(node_id(
                "node.closure.unrelated"
            )))
        );
        assert_eq!(
            assembler.assemble(&PacketAssemblyRequest {
                view: &closure_view,
                graph: &closure_graph,
                evidence: &closure_evidence[..2],
                limits: PacketLimits::new(1, 1_000, None),
                dependency_limits: DependencyClosureLimits::new(4, 2).unwrap(),
            }),
            Err(PacketError::RequiredEvidenceDoesNotFit {
                id: node_id("node.closure.dependency"),
                bound: PacketBound::Items,
            })
        );
        let depth_truncated = assembler
            .assemble(&PacketAssemblyRequest {
                view: &closure_view,
                graph: &closure_graph,
                evidence: &closure_evidence[..1],
                limits: PacketLimits::new(1, 1_000, None),
                dependency_limits: DependencyClosureLimits::new(0, 1).unwrap(),
            })
            .unwrap();
        assert!(depth_truncated.receipt.dependency_closure_truncated);
        assert!(depth_truncated.receipt.admitted_dependency_ids.is_empty());
        assert_eq!(depth_truncated.receipt.dependency_max_depth, 0);
        assert_eq!(depth_truncated.receipt.dependency_max_nodes, 1);

        let preserved = "node=node.beta\nnode=node.gamma\nalpha\nbeta\ndelta\ngamma\n";
        let applied_port = InMemorySqzPort::output(preserved);
        let applied = SqzAdapter::new(applied_port, sqz_config(SqzPolicy::PublicOn, 200))
            .evaluate(bounded.clone(), 150)
            .unwrap();
        assert_eq!(
            applied.receipt.schema_version,
            crate::adapters::sqz::SQZ_RECEIPT_SCHEMA_VERSION
        );
        assert_eq!(applied.receipt.status, SqzStatus::Applied);
        assert_eq!(applied.receipt.configured_identity, SqzIdentity::approved());
        assert_eq!(
            applied.receipt.returned_identity,
            Some(SqzIdentity::approved())
        );
        assert_eq!(applied.receipt.raw_bytes, bounded.payload.len());
        assert_eq!(
            applied.receipt.candidate_compressed_bytes,
            Some(applied.packet.payload.len())
        );
        assert_eq!(applied.receipt.returned_bytes, applied.packet.payload.len());
        assert_eq!(applied.receipt.actual_input_tokens, Some(111));
        assert_eq!(applied.receipt.actual_output_tokens, Some(17));
        assert_eq!(applied.receipt.fidelity_status, FidelityStatus::Passed);
        assert_eq!(
            applied.receipt.required_fidelity_anchor_ids,
            vec![
                "global.beta-node".to_owned(),
                "global.gamma-node".to_owned(),
                "required.alpha".to_owned(),
                "required.beta".to_owned(),
                "required.delta".to_owned(),
                "required.gamma".to_owned(),
            ]
        );
        assert!(applied.receipt.missing_fidelity_anchor_ids.is_empty());
        assert_eq!(applied.receipt.dlp_status, DlpStatus::Passed);
        assert!(applied.receipt.dlp_findings.is_empty());
        assert_eq!(applied.receipt.requested_max_output_bytes, 150);
        assert_eq!(applied.receipt.effective_max_output_bytes, 150);
        assert!(applied.receipt.monotonic_call_latency >= std::time::Duration::ZERO);
        let applied_id = ResultId::sha256(applied.packet.payload.as_bytes());
        assert_eq!(
            applied.receipt.sqz_id.as_ref().unwrap().algorithm,
            applied_id.algorithm()
        );
        assert_eq!(
            applied.receipt.sqz_id.as_ref().unwrap().value,
            applied_id.value()
        );

        let returned_identity = SqzIdentity::new(
            "unapproved-cargo-install:sqz-cli=1.1.1",
            "sqz 1.1.1",
            "f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5",
        );
        let mut identity_mismatch_port = InMemorySqzPort::output(preserved);
        identity_mismatch_port.response.as_mut().unwrap().identity = returned_identity.clone();
        let identity_mismatch =
            SqzAdapter::new(identity_mismatch_port, sqz_config(SqzPolicy::PublicOn, 200))
                .evaluate(bounded.clone(), 150)
                .unwrap();
        assert_eq!(identity_mismatch.receipt.status, SqzStatus::Failed);
        assert_eq!(
            identity_mismatch.receipt.failure_reason,
            Some(SqzFailureReason::ReturnedIdentityMismatch)
        );
        assert_eq!(
            identity_mismatch.receipt.returned_identity,
            Some(returned_identity)
        );
        assert_eq!(identity_mismatch.receipt.sqz_id, None);
        assert_eq!(identity_mismatch.packet, bounded);

        let off_port = InMemorySqzPort::output(preserved);
        let off_calls = off_port.calls.clone();
        let off = SqzAdapter::new(off_port, sqz_config(SqzPolicy::PublicOff, 200))
            .evaluate(bounded.clone(), 150)
            .unwrap();
        assert_eq!(off.receipt.status, SqzStatus::Off);
        assert_eq!(off.packet, bounded);
        assert_eq!(off.receipt.candidate_compressed_bytes, None);
        assert_eq!(off.receipt.actual_input_tokens, None);
        assert_eq!(off.receipt.fidelity_status, FidelityStatus::NotEvaluated);
        assert_eq!(off.receipt.dlp_status, DlpStatus::NotEvaluated);
        assert_eq!(off.receipt.sqz_id, None);
        assert_eq!(off_calls.get(), 0);

        let expanded_payload = format!("{}node=node.beta\nnode=node.gamma\n", bounded.payload);
        let rejected_candidate_id = ResultId::sha256(expanded_payload.as_bytes());
        let not_beneficial = SqzAdapter::new(
            InMemorySqzPort::output(expanded_payload),
            sqz_config(SqzPolicy::PublicOn, 2_000),
        )
        .evaluate(bounded.clone(), 1_500)
        .unwrap();
        assert_eq!(not_beneficial.receipt.status, SqzStatus::NotBeneficial);
        assert_eq!(not_beneficial.packet, bounded);
        assert!(
            not_beneficial.receipt.candidate_compressed_bytes.unwrap()
                >= not_beneficial.receipt.raw_bytes
        );
        let not_beneficial_id = ResultId::sha256(not_beneficial.packet.payload.as_bytes());
        assert_eq!(
            not_beneficial.receipt.sqz_id.as_ref().unwrap().algorithm,
            not_beneficial_id.algorithm()
        );
        assert_eq!(
            not_beneficial.receipt.sqz_id.as_ref().unwrap().value,
            not_beneficial_id.value()
        );
        assert_ne!(
            not_beneficial.receipt.sqz_id.as_ref().unwrap().value,
            rejected_candidate_id.value()
        );

        let missing_required = SqzAdapter::new(
            InMemorySqzPort::output("node=node.beta\nnode=node.gamma\nalpha\nbeta\ngamma\n"),
            sqz_config(SqzPolicy::PublicOn, 200),
        )
        .evaluate(bounded.clone(), 150)
        .unwrap();
        assert_eq!(missing_required.receipt.status, SqzStatus::Failed);
        assert_eq!(
            missing_required.receipt.failure_reason,
            Some(SqzFailureReason::MissingFidelityAnchors)
        );
        assert_eq!(
            missing_required.receipt.missing_fidelity_anchor_ids,
            vec!["required.delta"]
        );
        assert_eq!(missing_required.receipt.sqz_id, None);
        assert_eq!(missing_required.packet, bounded);

        let dlp_failure = SqzAdapter::new(
            InMemorySqzPort::output(format!("{preserved}api_key=abcdef\n")),
            sqz_config(SqzPolicy::PublicOn, 200),
        )
        .evaluate(bounded.clone(), 150)
        .unwrap();
        assert_eq!(dlp_failure.receipt.status, SqzStatus::Failed);
        assert_eq!(
            dlp_failure.receipt.failure_reason,
            Some(SqzFailureReason::DlpFindings)
        );
        assert_eq!(
            dlp_failure.receipt.dlp_findings,
            vec!["credential_assignment"]
        );
        assert_eq!(dlp_failure.receipt.dlp_status, DlpStatus::Findings);
        assert_eq!(dlp_failure.receipt.sqz_id, None);
        assert_eq!(dlp_failure.packet, bounded);

        let anchor_dlp_port = InMemorySqzPort::output(preserved);
        let anchor_dlp_calls = anchor_dlp_port.calls.clone();
        let anchor_dlp = SqzAdapter::new(
            anchor_dlp_port,
            SqzAdapterConfig::new(
                SqzPolicy::PublicOn,
                SqzIdentity::approved(),
                200,
                vec![anchor("global.secret", "api_key=abcdef")],
            ),
        )
        .evaluate(bounded.clone(), 150)
        .unwrap();
        assert_eq!(anchor_dlp.receipt.status, SqzStatus::Failed);
        assert_eq!(anchor_dlp.receipt.dlp_status, DlpStatus::Findings);
        assert_eq!(
            anchor_dlp.receipt.dlp_findings,
            vec!["credential_assignment"]
        );
        assert_eq!(anchor_dlp.receipt.sqz_id, None);
        assert_eq!(anchor_dlp_calls.get(), 0);

        let over_bound = SqzAdapter::new(
            InMemorySqzPort::output(preserved),
            sqz_config(SqzPolicy::PublicOn, 200),
        )
        .evaluate(bounded.clone(), 4)
        .unwrap();
        assert_eq!(over_bound.receipt.status, SqzStatus::Failed);
        assert_eq!(
            over_bound.receipt.failure_reason,
            Some(SqzFailureReason::OutputExceedsBound)
        );
        assert_eq!(over_bound.receipt.sqz_id, None);
        assert_eq!(over_bound.packet, bounded);

        let locked_port = InMemorySqzPort::unavailable();
        let locked_calls = locked_port.calls.clone();
        let locked = SqzAdapter::new(locked_port, sqz_config(SqzPolicy::InternalLocked, 200))
            .evaluate(bounded, 150);
        assert!(locked.is_err());
        let locked = locked.unwrap_err();
        assert_eq!(locked.receipt.status, SqzStatus::Failed);
        assert_eq!(
            locked.receipt.failure_reason,
            Some(SqzFailureReason::PortUnavailable(
                SqzPortErrorCode::Unavailable
            ))
        );
        assert_eq!(locked.receipt.policy, SqzPolicy::InternalLocked);
        assert_eq!(locked.receipt.sqz_id, None);
        assert_eq!(locked_calls.get(), 1);
    }
}
