//! Read-only bounded graph queries. Only `Known` edges establish reachability.

use super::{
    Confidence, EdgeCertainty, EdgeId, EdgeInput, KnowledgeGraph, NodeId, NodeInput, NodeRole,
    Provenance,
};
use std::collections::{HashMap, HashSet, VecDeque};

/// Caller-provided bounds. Zero is valid and returns an explicitly truncated result when needed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct QueryBounds {
    pub max_results: usize,
    pub max_depth: usize,
}

impl QueryBounds {
    pub fn new(max_results: usize, max_depth: usize) -> Self {
        Self {
            max_results,
            max_depth,
        }
    }
}

/// A deterministic, bounded result list.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bounded<T> {
    pub items: Vec<T>,
    pub truncated: bool,
}

/// A graph node with scanner evidence retained verbatim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeEvidence {
    pub id: NodeId,
    pub role: NodeRole,
    pub provenance: Provenance,
    pub confidence: Confidence,
}

/// A graph edge with candidate certainty and scanner evidence retained verbatim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EdgeEvidence {
    pub id: EdgeId,
    pub source: NodeId,
    pub target: NodeId,
    pub provenance: Provenance,
    pub confidence: Confidence,
    pub certainty: EdgeCertainty,
}

/// A node query whose requested node may not exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NodeQuery<T> {
    Found(Bounded<T>),
    Missing(NodeId),
}

pub type FindResult = Bounded<NodeEvidence>;

/// A direct source consuming the requested target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Consumer {
    pub node: NodeEvidence,
    pub edge: EdgeEvidence,
}

/// A node reached by reverse impact through one established edge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Impact {
    pub node: NodeEvidence,
    pub via: EdgeEvidence,
    pub depth: usize,
}

/// The non-speculative explanation for a reachability classification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReachabilityReason {
    Entrypoint,
    KnownPath { depth: usize },
    TestRole,
    GeneratedRole,
    NoKnownPath,
    Uncertain(EdgeEvidence),
    DepthBound,
}

/// Reachability is established only by `Known` edges.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Reachability {
    Active(ReachabilityReason),
    Supporting(ReachabilityReason),
    TestOnly(ReachabilityReason),
    Generated(ReachabilityReason),
    Unreachable(ReachabilityReason),
    Unknown(ReachabilityReason),
}

/// A node classification with evidence and explicit traversal completeness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Classification {
    pub node: NodeEvidence,
    pub outcome: Reachability,
    pub truncated: bool,
}

/// Evidence for a safe zombie candidate; uncertain candidates are excluded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Zombie {
    pub node: NodeEvidence,
    pub reason: ReachabilityReason,
}

/// A shortest known-only trail, including the start and target nodes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Trail {
    pub nodes: Vec<NodeEvidence>,
    pub edges: Vec<EdgeEvidence>,
    pub truncated: bool,
}

/// Guided-trail status, including explicit absence and bounded incompleteness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TrailStatus {
    Found(Trail),
    MissingStart(NodeId),
    MissingTarget(NodeId),
    Unreachable { truncated: bool },
}

impl KnowledgeGraph {
    /// Deterministically finds nodes by stable identity or retained provenance text.
    pub fn find(&self, needle: &str, max_results: usize) -> FindResult {
        let mut items = Vec::new();
        for node in &self.nodes {
            if !matches_node(node, needle) {
                continue;
            }
            if items.len() == max_results {
                return Bounded {
                    items,
                    truncated: true,
                };
            }
            items.push(node_evidence(node));
        }
        Bounded {
            items,
            truncated: false,
        }
    }

    /// Returns direct consumers, retaining every edge certainty as candidate evidence.
    pub fn consumers(&self, target: &NodeId, max_results: usize) -> NodeQuery<Consumer> {
        if self.node(target).is_none() {
            return NodeQuery::Missing(target.clone());
        }
        let mut items = Vec::new();
        for edge_id in self.reverse_edges(target) {
            if items.len() == max_results {
                return NodeQuery::Found(Bounded {
                    items,
                    truncated: true,
                });
            }
            let edge = self.edge(edge_id).expect("topology owns adjacency edges");
            let node = self.node(edge.source()).expect("validated edge source");
            items.push(Consumer {
                node: node_evidence(node),
                edge: edge_evidence(edge),
            });
        }
        NodeQuery::Found(Bounded {
            items,
            truncated: false,
        })
    }

    /// Breadth-first reverse impact over `Known` edges, with cycles visited once.
    pub fn impact(&self, start: &NodeId, bounds: QueryBounds) -> NodeQuery<Impact> {
        if self.node(start).is_none() {
            return NodeQuery::Missing(start.clone());
        }
        let mut items = Vec::new();
        let mut seen = HashSet::from([start.clone()]);
        let mut queue = VecDeque::from([(start.clone(), 0usize)]);
        while let Some((current, depth)) = queue.pop_front() {
            for edge_id in self.reverse_edges(&current) {
                let edge = self.edge(edge_id).expect("topology owns adjacency edges");
                if edge.certainty() != EdgeCertainty::Known || seen.contains(edge.source()) {
                    continue;
                }
                if depth == bounds.max_depth || items.len() == bounds.max_results {
                    return NodeQuery::Found(Bounded {
                        items,
                        truncated: true,
                    });
                }
                let source = edge.source().clone();
                seen.insert(source.clone());
                queue.push_back((source.clone(), depth + 1));
                items.push(Impact {
                    node: node_evidence(self.node(&source).expect("validated edge source")),
                    via: edge_evidence(edge),
                    depth: depth + 1,
                });
            }
        }
        NodeQuery::Found(Bounded {
            items,
            truncated: false,
        })
    }

    /// Classifies a node without treating uncertain candidates as verified absence.
    pub fn reachability(&self, target: &NodeId, max_depth: usize) -> NodeQuery<Classification> {
        let Some(node) = self.node(target) else {
            return NodeQuery::Missing(target.clone());
        };
        let evidence = node_evidence(node);
        let immediate = match node.role() {
            NodeRole::Entrypoint => Some(Reachability::Active(ReachabilityReason::Entrypoint)),
            NodeRole::Test => Some(Reachability::TestOnly(ReachabilityReason::TestRole)),
            NodeRole::Generated => Some(Reachability::Generated(ReachabilityReason::GeneratedRole)),
            _ => None,
        };
        if let Some(outcome) = immediate {
            return NodeQuery::Found(Bounded {
                items: vec![Classification {
                    node: evidence,
                    outcome,
                    truncated: false,
                }],
                truncated: false,
            });
        }

        let (depth, bounded) = self.known_distance_to(target, max_depth);
        let outcome = if let Some(depth) = depth {
            Reachability::Supporting(ReachabilityReason::KnownPath { depth })
        } else if bounded {
            Reachability::Unknown(ReachabilityReason::DepthBound)
        } else if let Some(edge) = self.uncertain_edge(target) {
            Reachability::Unknown(ReachabilityReason::Uncertain(edge))
        } else {
            Reachability::Unreachable(ReachabilityReason::NoKnownPath)
        };
        NodeQuery::Found(Bounded {
            items: vec![Classification {
                node: evidence,
                outcome,
                truncated: bounded,
            }],
            truncated: false,
        })
    }

    /// Returns only nodes proven unreachable within the supplied known-edge depth bound.
    pub fn zombies(&self, bounds: QueryBounds) -> Bounded<Zombie> {
        let mut items = Vec::new();
        for id in self.node_ids() {
            let NodeQuery::Found(result) = self.reachability(&id, bounds.max_depth) else {
                continue;
            };
            let classification = &result.items[0];
            let Reachability::Unreachable(reason) = &classification.outcome else {
                continue;
            };
            if classification.truncated {
                continue;
            }
            if items.len() == bounds.max_results {
                return Bounded {
                    items,
                    truncated: true,
                };
            }
            items.push(Zombie {
                node: classification.node.clone(),
                reason: reason.clone(),
            });
        }
        Bounded {
            items,
            truncated: false,
        }
    }

    /// Finds the deterministic shortest `Known` trail. Equal paths use node then edge identity.
    pub fn trail(&self, start: &NodeId, target: &NodeId, bounds: QueryBounds) -> TrailStatus {
        if self.node(start).is_none() {
            return TrailStatus::MissingStart(start.clone());
        }
        if self.node(target).is_none() {
            return TrailStatus::MissingTarget(target.clone());
        }
        if start == target {
            return TrailStatus::Found(Trail {
                nodes: vec![node_evidence(self.node(start).expect("validated start"))],
                edges: vec![],
                truncated: false,
            });
        }
        let mut seen = HashSet::from([start.clone()]);
        let mut prior: HashMap<NodeId, (NodeId, EdgeId)> = HashMap::new();
        let mut queue = VecDeque::from([(start.clone(), 0usize)]);
        let mut truncated = false;
        while let Some((current, depth)) = queue.pop_front() {
            let mut adjacent: Vec<_> = self
                .forward_edges(&current)
                .iter()
                .filter_map(|id| self.edge(id))
                .filter(|edge| edge.certainty() == EdgeCertainty::Known)
                .collect();
            adjacent.sort_by_key(|edge| (edge.target().clone(), edge.id().clone()));
            for edge in adjacent {
                if seen.contains(edge.target()) {
                    continue;
                }
                if depth == bounds.max_depth || prior.len() == bounds.max_results {
                    truncated = true;
                    continue;
                }
                let next = edge.target().clone();
                prior.insert(next.clone(), (current.clone(), edge.id().clone()));
                if &next == target {
                    return TrailStatus::Found(
                        self.rebuild_trail(start, target, &prior, truncated),
                    );
                }
                seen.insert(next.clone());
                queue.push_back((next, depth + 1));
            }
        }
        TrailStatus::Unreachable { truncated }
    }

    fn known_distance_to(&self, target: &NodeId, max_depth: usize) -> (Option<usize>, bool) {
        let mut seen = HashSet::new();
        let mut queue = VecDeque::new();
        for node in &self.nodes {
            if node.role() == NodeRole::Entrypoint {
                if node.id() == target {
                    return (Some(0), false);
                }
                seen.insert(node.id().clone());
                queue.push_back((node.id().clone(), 0usize));
            }
        }
        let mut bounded = false;
        while let Some((current, depth)) = queue.pop_front() {
            for edge_id in self.forward_edges(&current) {
                let edge = self.edge(edge_id).expect("topology owns adjacency edges");
                if edge.certainty() != EdgeCertainty::Known || seen.contains(edge.target()) {
                    continue;
                }
                if depth == max_depth {
                    bounded = true;
                    continue;
                }
                if edge.target() == target {
                    return (Some(depth + 1), false);
                }
                seen.insert(edge.target().clone());
                queue.push_back((edge.target().clone(), depth + 1));
            }
        }
        (None, bounded)
    }

    fn uncertain_edge(&self, node: &NodeId) -> Option<EdgeEvidence> {
        self.edges
            .iter()
            .find(|edge| {
                edge.certainty() != EdgeCertainty::Known
                    && (edge.source() == node || edge.target() == node)
            })
            .map(edge_evidence)
    }

    fn rebuild_trail(
        &self,
        start: &NodeId,
        target: &NodeId,
        prior: &HashMap<NodeId, (NodeId, EdgeId)>,
        truncated: bool,
    ) -> Trail {
        let mut node_ids = vec![target.clone()];
        let mut edge_ids = Vec::new();
        let mut current = target;
        while current != start {
            let (parent, edge) = prior
                .get(current)
                .expect("reached nodes retain predecessors");
            node_ids.push(parent.clone());
            edge_ids.push(edge.clone());
            current = parent;
        }
        node_ids.reverse();
        edge_ids.reverse();
        Trail {
            nodes: node_ids
                .iter()
                .map(|id| node_evidence(self.node(id).expect("trail node is indexed")))
                .collect(),
            edges: edge_ids
                .iter()
                .map(|id| edge_evidence(self.edge(id).expect("trail edge is indexed")))
                .collect(),
            truncated,
        }
    }
}

fn matches_node(node: &NodeInput, needle: &str) -> bool {
    node.id().as_str().contains(needle)
        || node.provenance().source().contains(needle)
        || node.provenance().locator().contains(needle)
}

fn node_evidence(node: &NodeInput) -> NodeEvidence {
    NodeEvidence {
        id: node.id().clone(),
        role: node.role(),
        provenance: node.provenance().clone(),
        confidence: node.confidence(),
    }
}

fn edge_evidence(edge: &EdgeInput) -> EdgeEvidence {
    EdgeEvidence {
        id: edge.id().clone(),
        source: edge.source().clone(),
        target: edge.target().clone(),
        provenance: edge.provenance().clone(),
        confidence: edge.confidence(),
        certainty: edge.certainty(),
    }
}
