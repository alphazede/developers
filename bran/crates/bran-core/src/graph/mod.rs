//! Deterministic immutable graph topology. Query algorithms live in Slice 2.2 A2.

pub mod model;
pub mod query;

pub use model::{
    Confidence, EdgeCertainty, EdgeId, EdgeInput, GraphError, GraphInput, GraphLimits, NodeId,
    NodeInput, NodeRole, Provenance,
};

use std::collections::HashMap;

/// Immutable deterministic topology built solely from scanner-neutral input records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KnowledgeGraph {
    nodes: Vec<NodeInput>,
    node_index: HashMap<NodeId, usize>,
    edges: Vec<EdgeInput>,
    edge_index: HashMap<EdgeId, usize>,
    forward: HashMap<NodeId, Vec<EdgeId>>,
    reverse: HashMap<NodeId, Vec<EdgeId>>,
}

impl KnowledgeGraph {
    pub fn build(input: GraphInput, limits: GraphLimits) -> Result<Self, GraphError> {
        if input.nodes().len() > limits.max_nodes() {
            return Err(GraphError::NodeLimitExceeded {
                limit: limits.max_nodes(),
                actual: input.nodes().len(),
            });
        }
        if input.edges().len() > limits.max_edges() {
            return Err(GraphError::EdgeLimitExceeded {
                limit: limits.max_edges(),
                actual: input.edges().len(),
            });
        }

        let mut nodes = input.nodes().to_vec();
        nodes.sort_by(|left, right| left.id().cmp(right.id()));
        let mut node_index = HashMap::with_capacity(nodes.len());
        for (position, node) in nodes.iter().enumerate() {
            if node_index.insert(node.id().clone(), position).is_some() {
                return Err(GraphError::DuplicateNodeId(node.id().clone()));
            }
        }

        let mut edges = input.edges().to_vec();
        edges.sort_by(|left, right| left.id().cmp(right.id()));
        let mut edge_index = HashMap::with_capacity(edges.len());
        let mut forward = HashMap::new();
        let mut reverse = HashMap::new();
        for (position, edge) in edges.iter().enumerate() {
            if !node_index.contains_key(edge.source()) {
                return Err(GraphError::MissingSource(edge.source().clone()));
            }
            let target_present = node_index.contains_key(edge.target());
            if !target_present && edge.certainty() != EdgeCertainty::MissingTarget {
                return Err(GraphError::MissingTargetMustBeExplicit {
                    edge: edge.id().clone(),
                    target: edge.target().clone(),
                });
            }
            if target_present && edge.certainty() == EdgeCertainty::MissingTarget {
                return Err(GraphError::MissingTargetMustBeAbsent {
                    edge: edge.id().clone(),
                    target: edge.target().clone(),
                });
            }
            if edge_index.insert(edge.id().clone(), position).is_some() {
                return Err(GraphError::DuplicateEdgeId(edge.id().clone()));
            }
            forward
                .entry(edge.source().clone())
                .or_insert_with(Vec::new)
                .push(edge.id().clone());
            reverse
                .entry(edge.target().clone())
                .or_insert_with(Vec::new)
                .push(edge.id().clone());
        }
        for adjacent in forward.values_mut() {
            adjacent.sort();
        }
        for adjacent in reverse.values_mut() {
            adjacent.sort();
        }
        Ok(Self {
            nodes,
            node_index,
            edges,
            edge_index,
            forward,
            reverse,
        })
    }

    pub fn node(&self, id: &NodeId) -> Option<&NodeInput> {
        self.node_index
            .get(id)
            .map(|position| &self.nodes[*position])
    }
    pub fn edge(&self, id: &EdgeId) -> Option<&EdgeInput> {
        self.edge_index
            .get(id)
            .map(|position| &self.edges[*position])
    }
    pub fn node_ids(&self) -> Vec<NodeId> {
        self.nodes.iter().map(|node| node.id().clone()).collect()
    }
    pub fn edge_ids(&self) -> Vec<EdgeId> {
        self.edges.iter().map(|edge| edge.id().clone()).collect()
    }
    pub fn forward_edges(&self, id: &NodeId) -> &[EdgeId] {
        self.forward.get(id).map(Vec::as_slice).unwrap_or(&[])
    }
    pub fn reverse_edges(&self, id: &NodeId) -> &[EdgeId] {
        self.reverse.get(id).map(Vec::as_slice).unwrap_or(&[])
    }
}

#[cfg(test)]
mod tests {
    use super::query::{NodeQuery, QueryBounds, Reachability, TrailStatus};
    use super::*;

    fn id(value: &str) -> NodeId {
        NodeId::parse(value).unwrap()
    }
    fn edge_id(value: &str) -> EdgeId {
        EdgeId::parse(value).unwrap()
    }
    fn source(value: &str) -> Provenance {
        Provenance::new("scanner", value).unwrap()
    }
    fn graph_input() -> GraphInput {
        let a = id("node.a");
        let b = id("node.b");
        let c = id("node.c");
        let missing = id("node.missing");
        GraphInput::new(
            vec![
                NodeInput::new(
                    c.clone(),
                    NodeRole::Symbol,
                    source("c"),
                    Confidence::new(70).unwrap(),
                ),
                NodeInput::new(
                    a.clone(),
                    NodeRole::Document,
                    source("a"),
                    Confidence::new(100).unwrap(),
                ),
                NodeInput::new(
                    b.clone(),
                    NodeRole::Section,
                    source("b"),
                    Confidence::new(80).unwrap(),
                ),
            ],
            vec![
                EdgeInput::new(
                    edge_id("edge.unknown"),
                    c,
                    a.clone(),
                    source("unknown"),
                    Confidence::new(40).unwrap(),
                    EdgeCertainty::Unknown,
                ),
                EdgeInput::new(
                    edge_id("edge.missing"),
                    a.clone(),
                    missing,
                    source("candidate"),
                    Confidence::new(15).unwrap(),
                    EdgeCertainty::MissingTarget,
                ),
                EdgeInput::new(
                    edge_id("edge.known"),
                    a,
                    b.clone(),
                    source("known"),
                    Confidence::new(100).unwrap(),
                    EdgeCertainty::Known,
                ),
                EdgeInput::new(
                    edge_id("edge.dynamic"),
                    b,
                    id("node.c"),
                    source("dynamic"),
                    Confidence::new(55).unwrap(),
                    EdgeCertainty::Dynamic,
                ),
            ],
        )
    }

    fn q_node(name: &str, role: NodeRole) -> NodeInput {
        NodeInput::new(id(name), role, source(name), Confidence::new(90).unwrap())
    }

    fn q_edge(
        name: &str,
        source_id: &str,
        target_id: &str,
        certainty: EdgeCertainty,
        confidence: u8,
    ) -> EdgeInput {
        EdgeInput::new(
            edge_id(name),
            id(source_id),
            id(target_id),
            source(name),
            Confidence::new(confidence).unwrap(),
            certainty,
        )
    }

    fn query_graph() -> KnowledgeGraph {
        KnowledgeGraph::build(
            GraphInput::new(
                vec![
                    q_node("node.entry", NodeRole::Entrypoint),
                    q_node("node.support", NodeRole::Symbol),
                    q_node("node.test", NodeRole::Test),
                    q_node("node.generated", NodeRole::Generated),
                    q_node("node.orphan", NodeRole::Archived),
                    q_node("node.dynamic", NodeRole::Symbol),
                    q_node("node.unknown", NodeRole::Symbol),
                    q_node("node.cycle.a", NodeRole::Symbol),
                    q_node("node.cycle.b", NodeRole::Symbol),
                    q_node("node.cycle.c", NodeRole::Symbol),
                    q_node("node.left", NodeRole::Symbol),
                    q_node("node.right", NodeRole::Symbol),
                    q_node("node.target", NodeRole::Symbol),
                ],
                vec![
                    q_edge(
                        "edge.entry-support",
                        "node.entry",
                        "node.support",
                        EdgeCertainty::Known,
                        100,
                    ),
                    q_edge(
                        "edge.entry-cycle",
                        "node.entry",
                        "node.cycle.a",
                        EdgeCertainty::Known,
                        100,
                    ),
                    q_edge(
                        "edge.z-left",
                        "node.entry",
                        "node.left",
                        EdgeCertainty::Known,
                        100,
                    ),
                    q_edge(
                        "edge.a-right",
                        "node.entry",
                        "node.right",
                        EdgeCertainty::Known,
                        100,
                    ),
                    q_edge(
                        "edge.left-target",
                        "node.left",
                        "node.target",
                        EdgeCertainty::Known,
                        100,
                    ),
                    q_edge(
                        "edge.right-target",
                        "node.right",
                        "node.target",
                        EdgeCertainty::Known,
                        100,
                    ),
                    q_edge(
                        "edge.cycle-a-b",
                        "node.cycle.a",
                        "node.cycle.b",
                        EdgeCertainty::Known,
                        100,
                    ),
                    q_edge(
                        "edge.cycle-b-c",
                        "node.cycle.b",
                        "node.cycle.c",
                        EdgeCertainty::Known,
                        100,
                    ),
                    q_edge(
                        "edge.cycle-c-a",
                        "node.cycle.c",
                        "node.cycle.a",
                        EdgeCertainty::Known,
                        100,
                    ),
                    q_edge(
                        "edge.dynamic",
                        "node.dynamic",
                        "node.support",
                        EdgeCertainty::Dynamic,
                        11,
                    ),
                    q_edge(
                        "edge.unknown",
                        "node.unknown",
                        "node.support",
                        EdgeCertainty::Unknown,
                        12,
                    ),
                ],
            ),
            GraphLimits::new(13, 11).unwrap(),
        )
        .unwrap()
    }

    fn classification(graph: &KnowledgeGraph, node: &str) -> Reachability {
        let NodeQuery::Found(result) = graph.reachability(&id(node), 8) else {
            panic!("known query node missing");
        };
        result.items[0].outcome.clone()
    }

    #[test]
    fn p2_graph() {
        let limits = GraphLimits::new(3, 4).unwrap();
        let graph = KnowledgeGraph::build(graph_input(), limits).unwrap();
        assert_eq!(
            graph.node_ids(),
            vec![id("node.a"), id("node.b"), id("node.c")]
        );
        assert_eq!(
            graph.edge_ids(),
            vec![
                edge_id("edge.dynamic"),
                edge_id("edge.known"),
                edge_id("edge.missing"),
                edge_id("edge.unknown")
            ]
        );
        assert_eq!(
            graph.forward_edges(&id("node.a")),
            &[edge_id("edge.known"), edge_id("edge.missing")]
        );
        assert_eq!(
            graph.reverse_edges(&id("node.a")),
            &[edge_id("edge.unknown")]
        );
        assert_eq!(
            graph.forward_edges(&id("node.c")),
            &[edge_id("edge.unknown")]
        );
        assert_eq!(
            graph.reverse_edges(&id("node.c")),
            &[edge_id("edge.dynamic")]
        );
        assert_eq!(KnowledgeGraph::build(graph_input(), limits).unwrap(), graph);
        let node = graph.node(&id("node.a")).unwrap();
        assert_eq!(node.role(), NodeRole::Document);
        assert_eq!(node.provenance().locator(), "a");
        assert_eq!(node.confidence().value(), 100);
        let missing = graph.edge(&edge_id("edge.missing")).unwrap();
        assert_eq!(missing.certainty(), EdgeCertainty::MissingTarget);
        assert_eq!(missing.provenance().locator(), "candidate");
        assert_eq!(missing.confidence().value(), 15);
        assert_eq!(
            graph.edge(&edge_id("edge.dynamic")).unwrap().certainty(),
            EdgeCertainty::Dynamic
        );
        assert_eq!(
            graph.edge(&edge_id("edge.unknown")).unwrap().certainty(),
            EdgeCertainty::Unknown
        );
        assert_eq!(
            KnowledgeGraph::build(
                GraphInput::new(
                    vec![NodeInput::new(
                        id("node.a"),
                        NodeRole::Document,
                        source("a"),
                        Confidence::new(1).unwrap()
                    )],
                    vec![EdgeInput::new(
                        edge_id("edge.absent"),
                        id("node.a"),
                        id("node.missing"),
                        source("absent"),
                        Confidence::new(1).unwrap(),
                        EdgeCertainty::Known
                    )]
                ),
                GraphLimits::new(1, 1).unwrap()
            ),
            Err(GraphError::MissingTargetMustBeExplicit {
                edge: edge_id("edge.absent"),
                target: id("node.missing")
            })
        );
        assert_eq!(
            KnowledgeGraph::build(
                GraphInput::new(
                    vec![
                        NodeInput::new(
                            id("node.a"),
                            NodeRole::Document,
                            source("one"),
                            Confidence::new(1).unwrap()
                        ),
                        NodeInput::new(
                            id("node.a"),
                            NodeRole::Document,
                            source("two"),
                            Confidence::new(1).unwrap()
                        )
                    ],
                    vec![]
                ),
                GraphLimits::new(3, 1).unwrap()
            ),
            Err(GraphError::DuplicateNodeId(id("node.a")))
        );
        assert_eq!(
            KnowledgeGraph::build(
                GraphInput::new(
                    vec![NodeInput::new(
                        id("node.a"),
                        NodeRole::Document,
                        source("a"),
                        Confidence::new(1).unwrap()
                    )],
                    vec![
                        EdgeInput::new(
                            edge_id("edge.a"),
                            id("node.a"),
                            id("node.a"),
                            source("a"),
                            Confidence::new(1).unwrap(),
                            EdgeCertainty::Known
                        ),
                        EdgeInput::new(
                            edge_id("edge.a"),
                            id("node.a"),
                            id("node.a"),
                            source("b"),
                            Confidence::new(1).unwrap(),
                            EdgeCertainty::Known
                        )
                    ]
                ),
                GraphLimits::new(1, 2).unwrap()
            ),
            Err(GraphError::DuplicateEdgeId(edge_id("edge.a")))
        );
        assert_eq!(
            KnowledgeGraph::build(graph_input(), GraphLimits::new(2, 4).unwrap()),
            Err(GraphError::NodeLimitExceeded {
                limit: 2,
                actual: 3
            })
        );
        assert_eq!(
            KnowledgeGraph::build(graph_input(), GraphLimits::new(3, 3).unwrap()),
            Err(GraphError::EdgeLimitExceeded {
                limit: 3,
                actual: 4
            })
        );
    }

    #[test]
    fn p2_queries() {
        let graph = query_graph();
        assert_eq!(graph.find("node.", 2), graph.find("node.", 2));
        assert_eq!(graph.find("node.", 2).items.len(), 2);
        assert!(graph.find("node.", 0).truncated);
        let NodeQuery::Found(consumers) = graph.consumers(&id("node.support"), 8) else {
            panic!("known consumer target missing");
        };
        assert_eq!(consumers.items.len(), 3);
        assert_eq!(consumers.items[0].node.id, id("node.dynamic"));
        assert_eq!(consumers.items[0].edge.certainty, EdgeCertainty::Dynamic);
        assert_eq!(consumers.items[0].edge.provenance.locator(), "edge.dynamic");
        assert_eq!(consumers.items[0].edge.confidence.value(), 11);
        let NodeQuery::Found(impact) = graph.impact(&id("node.cycle.a"), QueryBounds::new(8, 8))
        else {
            panic!("known impact start missing");
        };
        assert_eq!(impact.items.len(), 3);
        assert_eq!(impact.items[0].node.id, id("node.cycle.c"));
        assert_eq!(impact.items[1].node.id, id("node.entry"));
        assert_eq!(impact.items[2].node.id, id("node.cycle.b"));
        assert!(matches!(
            classification(&graph, "node.entry"),
            Reachability::Active(_)
        ));
        assert!(matches!(
            classification(&graph, "node.support"),
            Reachability::Supporting(_)
        ));
        assert!(matches!(
            classification(&graph, "node.test"),
            Reachability::TestOnly(_)
        ));
        assert!(matches!(
            classification(&graph, "node.generated"),
            Reachability::Generated(_)
        ));
        assert!(matches!(
            classification(&graph, "node.orphan"),
            Reachability::Unreachable(_)
        ));
        assert!(matches!(
            classification(&graph, "node.dynamic"),
            Reachability::Unknown(_)
        ));
        assert!(matches!(
            classification(&graph, "node.unknown"),
            Reachability::Unknown(_)
        ));
        let zombies = graph.zombies(QueryBounds::new(8, 8));
        assert_eq!(zombies.items.len(), 1);
        assert_eq!(zombies.items[0].node.id, id("node.orphan"));
        let trail = graph.trail(
            &id("node.entry"),
            &id("node.target"),
            QueryBounds::new(8, 8),
        );
        assert_eq!(
            trail,
            graph.trail(
                &id("node.entry"),
                &id("node.target"),
                QueryBounds::new(8, 8)
            )
        );
        let TrailStatus::Found(trail) = trail else {
            panic!("known trail absent");
        };
        assert_eq!(trail.nodes[1].id, id("node.left"));
        assert_eq!(trail.edges[0].id, edge_id("edge.z-left"));
        assert_eq!(
            graph.trail(&id("node.none"), &id("node.target"), QueryBounds::new(8, 8)),
            TrailStatus::MissingStart(id("node.none"))
        );
        assert_eq!(
            graph.trail(&id("node.entry"), &id("node.none"), QueryBounds::new(8, 8)),
            TrailStatus::MissingTarget(id("node.none"))
        );
        let NodeQuery::Found(depth_bound) =
            graph.impact(&id("node.cycle.a"), QueryBounds::new(8, 1))
        else {
            panic!("known impact start missing");
        };
        assert!(depth_bound.truncated);
        let NodeQuery::Found(result_bound) =
            graph.impact(&id("node.cycle.a"), QueryBounds::new(1, 8))
        else {
            panic!("known impact start missing");
        };
        assert_eq!(result_bound.items.len(), 1);
        assert!(result_bound.truncated);
    }
}
