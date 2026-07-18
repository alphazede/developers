use bran_core::graph::query::{NodeQuery, QueryBounds, TrailStatus};
use bran_core::graph::{
    Confidence, EdgeCertainty, EdgeId, EdgeInput, GraphInput, GraphLimits, KnowledgeGraph, NodeId,
    NodeInput, NodeRole, Provenance,
};
use std::mem::size_of;
use std::time::{Duration, Instant};

const NODE_COUNT: usize = 6_000;
const EDGE_COUNT: usize = 100_000;
const CANDIDATE_COUNT: usize = 6_000;
const WARM_QUERY_LIMIT: Duration = Duration::from_millis(150);

fn node_id(index: usize) -> NodeId {
    NodeId::parse(format!("node.{index:05}")).expect("valid benchmark node identity")
}

fn edge_id(index: usize) -> EdgeId {
    EdgeId::parse(format!("edge.{index:06}")).expect("valid benchmark edge identity")
}

fn provenance(kind: &str, index: usize) -> Provenance {
    Provenance::new("controlled-benchmark", format!("{kind}:{index:06}"))
        .expect("valid benchmark provenance")
}

fn controlled_input() -> GraphInput {
    let mut nodes = Vec::with_capacity(NODE_COUNT);
    for index in 0..NODE_COUNT {
        let role = if index == 0 {
            NodeRole::Entrypoint
        } else {
            NodeRole::Symbol
        };
        nodes.push(NodeInput::new(
            node_id(index),
            role,
            provenance("node", index),
            Confidence::new(100).expect("valid benchmark confidence"),
        ));
    }

    let mut edges = Vec::with_capacity(EDGE_COUNT);
    for index in 0..EDGE_COUNT {
        let (source, target) = if index < NODE_COUNT - 1 {
            (node_id(0), node_id(index + 1))
        } else {
            let source_index = 2 + ((index - (NODE_COUNT - 1)) % (NODE_COUNT - 2));
            (node_id(source_index), node_id(1))
        };
        edges.push(EdgeInput::new(
            edge_id(index),
            source,
            target,
            provenance("edge", index),
            Confidence::new(100).expect("valid benchmark confidence"),
            EdgeCertainty::Known,
        ));
    }
    GraphInput::new(nodes, edges)
}

fn elapsed<T>(operation: impl FnOnce() -> T) -> (T, Duration) {
    let started = Instant::now();
    let result = operation();
    (result, started.elapsed())
}

fn main() {
    let input_record_lower_bound =
        size_of::<NodeInput>() * NODE_COUNT + size_of::<EdgeInput>() * EDGE_COUNT;
    let (graph, build) = elapsed(|| {
        KnowledgeGraph::build(
            controlled_input(),
            GraphLimits::new(NODE_COUNT, EDGE_COUNT).expect("valid benchmark limits"),
        )
        .expect("build controlled benchmark graph")
    });

    let target = node_id(1);
    let trail_target = node_id(NODE_COUNT - 1);
    let (_, warmup) = elapsed(|| {
        let found = graph.find("node.", CANDIDATE_COUNT);
        let impact = graph.impact(&target, QueryBounds::new(CANDIDATE_COUNT, 2));
        let trail = graph.trail(
            &node_id(0),
            &trail_target,
            QueryBounds::new(CANDIDATE_COUNT, 1),
        );
        assert_eq!(found.items.len(), CANDIDATE_COUNT);
        assert!(!found.truncated);
        assert!(matches!(impact, NodeQuery::Found(_)));
        assert!(matches!(trail, TrailStatus::Found(_)));
    });

    let (_, warm_query) = elapsed(|| {
        let found = graph.find("node.", CANDIDATE_COUNT);
        let impact = graph.impact(&target, QueryBounds::new(CANDIDATE_COUNT, 2));
        let trail = graph.trail(
            &node_id(0),
            &trail_target,
            QueryBounds::new(CANDIDATE_COUNT, 1),
        );
        assert_eq!(found.items.len(), CANDIDATE_COUNT);
        assert!(!found.truncated);
        assert!(matches!(impact, NodeQuery::Found(_)));
        assert!(matches!(trail, TrailStatus::Found(_)));
    });
    assert!(
        warm_query <= WARM_QUERY_LIMIT,
        "controlled warm query exceeded the 150ms design threshold: {warm_query:?}"
    );

    println!(
        "knowledge_graph controlled=true nodes={NODE_COUNT} edges={EDGE_COUNT} candidates={CANDIDATE_COUNT} build_ns={} warmup_query_ns={} warm_query_ns={} rss_proxy_kind=input-record-structure-lower-bound rss_proxy_bytes={input_record_lower_bound}",
        build.as_nanos(),
        warmup.as_nanos(),
        warm_query.as_nanos()
    );
}
