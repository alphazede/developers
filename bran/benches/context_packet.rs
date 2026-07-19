use bran_core::adapters::sqz::{
    SqzAdapter, SqzAdapterConfig, SqzIdentity, SqzPolicy, SqzPort, SqzPortError, SqzPortOutput,
    SqzStatus,
};
use bran_core::graph::{
    Confidence, GraphInput, GraphLimits, KnowledgeGraph, NodeId, NodeInput, NodeRole, Provenance,
};
use bran_core::packet::{
    EvidenceContent, EvidencePriority, PacketAssembler, PacketAssemblyRequest, PacketLimits,
    PreservationAnchor,
};
use bran_core::view::{
    Presentation, ViewCompiler, ViewField, ViewFilter, ViewGrouping, ViewSort, ViewSource, ViewSpec,
};
use std::time::{Duration, Instant};

const CANDIDATE_COUNT: usize = 6_000;
const VIEW_ITEM_LIMIT: usize = 128;
const PACKET_ITEM_LIMIT: usize = 48;
const FIDELITY_ANCHOR: &str = "architecture-contract";

struct InMemorySqzPort;

impl SqzPort for InMemorySqzPort {
    fn compress(&self, input: &str) -> Result<SqzPortOutput, SqzPortError> {
        Ok(SqzPortOutput::new(
            format!(
                "{FIDELITY_ANCHOR}\nrequired-fact-0\nrequired-fact-1\nrequired-fact-2\nrequired-fact-3\nrequired-fact-4\nrequired-fact-5\nrequired-fact-6\nrequired-fact-7\nfocused_context_source_bytes={}\n",
                input.len()
            ),
            SqzIdentity::approved(),
        ))
    }
}

fn node_id(index: usize) -> NodeId {
    NodeId::parse(format!("repository.node.{index:05}"))
        .expect("valid context-packet benchmark node identity")
}

fn controlled_graph() -> KnowledgeGraph {
    let mut nodes = Vec::with_capacity(CANDIDATE_COUNT);
    for index in 0..CANDIDATE_COUNT {
        let role = match index % 4 {
            0 => NodeRole::Document,
            1 => NodeRole::Symbol,
            2 => NodeRole::Test,
            _ => NodeRole::Entrypoint,
        };
        nodes.push(NodeInput::new(
            node_id(index),
            role,
            Provenance::new("controlled-repository", format!("src/module-{index:05}.rs"))
                .expect("valid context-packet benchmark provenance"),
            Confidence::new(80 + (index % 21) as u8)
                .expect("valid context-packet benchmark confidence"),
        ));
    }
    KnowledgeGraph::build(
        GraphInput::new(nodes, Vec::new()),
        GraphLimits::new(CANDIDATE_COUNT, 1).expect("valid context-packet graph limits"),
    )
    .expect("build controlled context-packet graph")
}

fn elapsed<T>(operation: impl FnOnce() -> T) -> (T, Duration) {
    let started = Instant::now();
    let result = operation();
    (result, started.elapsed())
}

fn main() {
    let graph = controlled_graph();
    let spec = ViewSpec {
        source: ViewSource::All,
        filter: ViewFilter::All,
        sort: ViewSort::ConfidenceDescendingThenNodeId,
        grouping: ViewGrouping::Role,
        fields: vec![
            ViewField::NodeId,
            ViewField::Role,
            ViewField::ProvenanceLocator,
            ViewField::Confidence,
        ],
        presentation: Presentation::Terminal,
        max_items: VIEW_ITEM_LIMIT,
        max_bytes: 1_000_000,
    };
    let (view, view_compile) = elapsed(|| ViewCompiler::new().compile(&spec, &graph));
    assert_eq!(view.items().len(), VIEW_ITEM_LIMIT);
    assert!(view.truncated());

    let evidence = view
        .items()
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let required_fact = format!("required-fact-{index}");
            let priority = if index < 8 {
                EvidencePriority::Required
            } else if index < PACKET_ITEM_LIMIT {
                EvidencePriority::Recommended
            } else {
                EvidencePriority::Related
            };
            EvidenceContent::new(
                item.id.clone(),
                format!(
                    "{FIDELITY_ANCHOR} {required_fact} evidence for {}: deterministic repository context {}",
                    item.id.as_str(),
                    "supports bounded review and planning. ".repeat(12)
                ),
                priority,
                10_000 - index as u64,
                20_000 - index as u64,
                if priority == EvidencePriority::Required {
                    vec![PreservationAnchor::new(
                        format!("required.fact.{index}"),
                        required_fact,
                    )
                    .expect("valid context-packet benchmark preservation anchor")]
                } else {
                    Vec::new()
                },
            )
        })
        .collect::<Vec<_>>();
    let request = PacketAssemblyRequest {
        view: &view,
        evidence: &evidence,
        limits: PacketLimits::new(PACKET_ITEM_LIMIT, 64 * 1024, Some(16 * 1024)),
    };
    let (packet, packet_assembly) = elapsed(|| {
        PacketAssembler::new()
            .assemble(&request)
            .expect("assemble bounded context packet")
    });
    assert_eq!(packet.items.len(), PACKET_ITEM_LIMIT);
    assert!(packet.receipt.truncated);

    let raw_bytes = packet.payload.len();
    let adapter = SqzAdapter::new(
        InMemorySqzPort,
        SqzAdapterConfig::new(
            SqzPolicy::PublicOn,
            SqzIdentity::approved(),
            1_024,
            vec![
                PreservationAnchor::new("global.architecture", FIDELITY_ANCHOR)
                    .expect("valid global context-packet benchmark preservation anchor"),
            ],
        ),
    );
    let (evaluation, sqz_evaluation) = elapsed(|| {
        adapter
            .evaluate(packet, 1_024)
            .expect("evaluate packet through in-memory SQZ port")
    });
    assert_eq!(evaluation.receipt.status, SqzStatus::Applied);
    assert!(evaluation.packet.payload.len() < raw_bytes);

    println!(
        "context_packet controlled=true sqz_port=controlled-in-memory candidates={CANDIDATE_COUNT} view_items={} packet_items={} raw_bytes={} returned_bytes={} estimated_raw_tokens={} estimated_returned_tokens={} actual_input_tokens=unavailable actual_output_tokens=unavailable view_compile_ns={} packet_assembly_ns={} sqz_evaluation_ns={}",
        view.items().len(),
        evaluation.packet.items.len(),
        evaluation.receipt.raw_bytes,
        evaluation.receipt.returned_bytes,
        evaluation
            .receipt
            .raw_token_estimate_bytes_divided_by_four_ceiling,
        evaluation
            .receipt
            .returned_token_estimate_bytes_divided_by_four_ceiling,
        view_compile.as_nanos(),
        packet_assembly.as_nanos(),
        sqz_evaluation.as_nanos()
    );
}
