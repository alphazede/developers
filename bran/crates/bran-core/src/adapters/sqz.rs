//! Dependency-free SQZ policy evaluation at the packet boundary.
//!
//! This module deliberately owns no process, filesystem, network, or provider
//! integration. A host supplies those concerns through [`SqzPort`].

use crate::agent::result_store::ResultId;
use crate::packet::{ContextPacket, EvidencePriority, PreservationAnchor};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

pub const APPROVED_SQZ_SOURCE: &str =
    "approved-cargo-install:sqz-cli=1.1.1+patched-compatible-deps";
pub const APPROVED_SQZ_VERSION: &str = "sqz 1.1.1";
pub const APPROVED_SQZ_SHA256: &str =
    "03c8de9c55f22e3c3e33852972a2a12a8e436d8861736db71c9441804075e722";
pub const SQZ_RECEIPT_SCHEMA_VERSION: &str = "1.0.0";

/// Exact identity claimed by the configured and returned SQZ implementation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqzIdentity {
    pub source: String,
    pub version: String,
    pub sha256: String,
}

impl SqzIdentity {
    pub fn new(
        source: impl Into<String>,
        version: impl Into<String>,
        sha256: impl Into<String>,
    ) -> Self {
        Self {
            source: source.into(),
            version: version.into(),
            sha256: sha256.into(),
        }
    }

    pub fn approved() -> Self {
        Self::new(
            APPROVED_SQZ_SOURCE,
            APPROVED_SQZ_VERSION,
            APPROVED_SQZ_SHA256,
        )
    }

    fn is_approved(&self) -> bool {
        self.source == APPROVED_SQZ_SOURCE
            && self.version == APPROVED_SQZ_VERSION
            && self.sha256 == APPROVED_SQZ_SHA256
    }
}

/// Policy resolved by configuration, not by a call site.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SqzPolicy {
    PublicOff,
    PublicOn,
    InternalLocked,
}

/// A provider-neutral port. Implementations may be in-memory or host-owned.
pub trait SqzPort {
    fn compress(&self, input: &str) -> Result<SqzPortOutput, SqzPortError>;
}

/// Successful port response. Actual token counts are optional provider telemetry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqzPortOutput {
    pub payload: String,
    pub identity: SqzIdentity,
    pub actual_input_tokens: Option<usize>,
    pub actual_output_tokens: Option<usize>,
}

impl SqzPortOutput {
    pub fn new(payload: impl Into<String>, identity: SqzIdentity) -> Self {
        Self {
            payload: payload.into(),
            identity,
            actual_input_tokens: None,
            actual_output_tokens: None,
        }
    }
}

/// Closed public diagnostic codes prevent provider stderr or secrets entering receipts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SqzPortErrorCode {
    Unavailable,
    Timeout,
    ExecutionFailed,
    InvalidOutput,
}

/// A port failure without provider-specific or unbounded text entering the core.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SqzPortError {
    pub code: SqzPortErrorCode,
}

impl SqzPortError {
    pub fn new(code: SqzPortErrorCode) -> Self {
        Self { code }
    }
}

/// Configuration fixed when the adapter is created.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqzAdapterConfig {
    pub policy: SqzPolicy,
    pub identity: SqzIdentity,
    pub configured_max_output_bytes: usize,
    pub fidelity_anchors: Vec<PreservationAnchor>,
}

impl SqzAdapterConfig {
    pub fn new(
        policy: SqzPolicy,
        identity: SqzIdentity,
        configured_max_output_bytes: usize,
        fidelity_anchors: Vec<PreservationAnchor>,
    ) -> Self {
        Self {
            policy,
            identity,
            configured_max_output_bytes,
            fidelity_anchors,
        }
    }
}

/// Explicit outcome for one eligible packet evaluation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SqzStatus {
    Off,
    Applied,
    NotBeneficial,
    Failed,
}

/// Fidelity-anchor evaluation is explicit even when an output was unavailable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FidelityStatus {
    NotEvaluated,
    RequiredButUnavailable,
    Passed,
    Missing,
}

/// How far DLP evaluation progressed for the returned receipt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DlpStatus {
    NotEvaluated,
    InputPassed,
    Passed,
    Findings,
}

/// Why a completed evaluation did not produce a valid compressed payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SqzFailureReason {
    ConfiguredIdentityMismatch,
    ReturnedIdentityMismatch,
    PortUnavailable(SqzPortErrorCode),
    FidelityAnchorsUnavailable,
    MissingFidelityAnchors,
    FidelityAnchorMissingFromInput,
    ConflictingFidelityAnchorIds,
    DlpFindings,
    OutputExceedsBound,
}

/// A SHA-256 identity for accepted returned content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqzId {
    pub algorithm: &'static str,
    pub value: String,
}

/// Complete accounting for policy evaluation. Byte-derived token counts are estimates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqzReceipt {
    pub schema_version: &'static str,
    pub configured_identity: SqzIdentity,
    pub returned_identity: Option<SqzIdentity>,
    pub policy: SqzPolicy,
    pub status: SqzStatus,
    pub failure_reason: Option<SqzFailureReason>,
    pub monotonic_call_latency: Duration,
    pub raw_bytes: usize,
    pub candidate_compressed_bytes: Option<usize>,
    pub returned_bytes: usize,
    pub raw_token_estimate_bytes_divided_by_four_ceiling: usize,
    pub candidate_token_estimate_bytes_divided_by_four_ceiling: Option<usize>,
    pub returned_token_estimate_bytes_divided_by_four_ceiling: usize,
    pub actual_input_tokens: Option<usize>,
    pub actual_output_tokens: Option<usize>,
    pub fidelity_status: FidelityStatus,
    pub required_fidelity_anchor_ids: Vec<String>,
    pub missing_fidelity_anchor_ids: Vec<String>,
    pub dlp_status: DlpStatus,
    pub dlp_findings: Vec<String>,
    pub requested_max_output_bytes: usize,
    pub effective_max_output_bytes: usize,
    pub sqz_id: Option<SqzId>,
}

/// The returned payload and its policy receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqzEvaluation {
    pub packet: ContextPacket,
    pub receipt: SqzReceipt,
}

/// Internal locked policy returns this typed failure instead of an original packet.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqzError {
    pub receipt: Box<SqzReceipt>,
}

/// Evaluates one packet through a configured policy. Callers cannot override it.
#[derive(Clone, Debug)]
pub struct SqzAdapter<P> {
    port: P,
    config: SqzAdapterConfig,
}

impl<P> SqzAdapter<P>
where
    P: SqzPort,
{
    pub fn new(port: P, config: SqzAdapterConfig) -> Self {
        Self { port, config }
    }

    pub fn policy(&self) -> SqzPolicy {
        self.config.policy
    }

    pub fn evaluate(
        &self,
        packet: ContextPacket,
        requested_max_output_bytes: usize,
    ) -> Result<SqzEvaluation, SqzError> {
        let raw_bytes = packet.payload.len();
        let effective_max_output_bytes =
            requested_max_output_bytes.min(self.config.configured_max_output_bytes);
        let anchors = combined_anchors(&packet, &self.config.fidelity_anchors);
        if self.config.policy == SqzPolicy::PublicOff {
            return Ok(SqzEvaluation {
                receipt: self.base_receipt(
                    &packet,
                    raw_bytes,
                    raw_bytes,
                    requested_max_output_bytes,
                    effective_max_output_bytes,
                ),
                packet,
            });
        }

        if !self.config.identity.is_approved() {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                None,
                Duration::ZERO,
                None,
                FidelityStatus::NotEvaluated,
                Vec::new(),
                Vec::new(),
                SqzFailureReason::ConfiguredIdentityMismatch,
            );
        }

        if anchors.conflicting_ids {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                None,
                Duration::ZERO,
                None,
                FidelityStatus::NotEvaluated,
                Vec::new(),
                Vec::new(),
                SqzFailureReason::ConflictingFidelityAnchorIds,
            );
        }

        let anchor_dlp = anchors
            .anchors
            .iter()
            .flat_map(|anchor| dlp_findings(anchor.value()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if !anchor_dlp.is_empty() {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                None,
                Duration::ZERO,
                None,
                FidelityStatus::NotEvaluated,
                Vec::new(),
                anchor_dlp,
                SqzFailureReason::DlpFindings,
            );
        }

        let missing_input_anchor_ids = anchors
            .anchors
            .iter()
            .filter(|anchor| !packet.payload.contains(anchor.value()))
            .map(|anchor| anchor.id().to_owned())
            .collect::<Vec<_>>();
        if !missing_input_anchor_ids.is_empty() {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                None,
                Duration::ZERO,
                None,
                FidelityStatus::Missing,
                missing_input_anchor_ids,
                Vec::new(),
                SqzFailureReason::FidelityAnchorMissingFromInput,
            );
        }

        let input_dlp = dlp_findings(&packet.payload);
        if !input_dlp.is_empty() {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                None,
                Duration::ZERO,
                None,
                FidelityStatus::NotEvaluated,
                Vec::new(),
                input_dlp,
                SqzFailureReason::DlpFindings,
            );
        }

        let started = Instant::now();
        let output = self.port.compress(&packet.payload);
        let latency = started.elapsed();
        let output = match output {
            Ok(output) => output,
            Err(error) => {
                return self.failed(
                    packet,
                    requested_max_output_bytes,
                    effective_max_output_bytes,
                    None,
                    latency,
                    None,
                    FidelityStatus::NotEvaluated,
                    Vec::new(),
                    Vec::new(),
                    SqzFailureReason::PortUnavailable(error.code),
                )
            }
        };

        let candidate_bytes = output.payload.len();
        if !output.identity.is_approved() || output.identity != self.config.identity {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                Some(output.identity.clone()),
                latency,
                Some((&output, candidate_bytes, None)),
                FidelityStatus::NotEvaluated,
                Vec::new(),
                Vec::new(),
                SqzFailureReason::ReturnedIdentityMismatch,
            );
        }
        let returned_identity = Some(output.identity.clone());
        if candidate_bytes > effective_max_output_bytes {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                returned_identity,
                latency,
                Some((&output, candidate_bytes, None)),
                FidelityStatus::NotEvaluated,
                Vec::new(),
                Vec::new(),
                SqzFailureReason::OutputExceedsBound,
            );
        }
        let candidate_id = Some(content_id(&output.payload));

        let (fidelity_status, missing_fidelity_anchor_ids) =
            fidelity_status(&output.payload, &anchors.anchors);
        let findings = dlp_findings(&output.payload);
        if fidelity_status == FidelityStatus::RequiredButUnavailable {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                returned_identity,
                latency,
                Some((&output, candidate_bytes, candidate_id)),
                fidelity_status,
                missing_fidelity_anchor_ids,
                findings,
                SqzFailureReason::FidelityAnchorsUnavailable,
            );
        }
        if fidelity_status == FidelityStatus::Missing {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                returned_identity,
                latency,
                Some((&output, candidate_bytes, candidate_id)),
                fidelity_status,
                missing_fidelity_anchor_ids,
                findings,
                SqzFailureReason::MissingFidelityAnchors,
            );
        }
        if !findings.is_empty() {
            return self.failed(
                packet,
                requested_max_output_bytes,
                effective_max_output_bytes,
                returned_identity,
                latency,
                Some((&output, candidate_bytes, candidate_id)),
                fidelity_status,
                missing_fidelity_anchor_ids,
                findings,
                SqzFailureReason::DlpFindings,
            );
        }
        if candidate_bytes >= raw_bytes {
            let returned_id = Some(content_id(&packet.payload));
            let receipt = self.receipt(
                raw_bytes,
                raw_bytes,
                requested_max_output_bytes,
                effective_max_output_bytes,
                returned_identity,
                latency,
                Some((&output, candidate_bytes, returned_id)),
                SqzStatus::NotBeneficial,
                None,
                fidelity_status,
                anchor_ids(&anchors.anchors),
                missing_fidelity_anchor_ids,
                findings,
            );
            return Ok(SqzEvaluation { packet, receipt });
        }

        let receipt = self.receipt(
            raw_bytes,
            candidate_bytes,
            requested_max_output_bytes,
            effective_max_output_bytes,
            returned_identity,
            latency,
            Some((&output, candidate_bytes, candidate_id)),
            SqzStatus::Applied,
            None,
            fidelity_status,
            anchor_ids(&anchors.anchors),
            missing_fidelity_anchor_ids,
            findings,
        );
        Ok(SqzEvaluation {
            packet: ContextPacket {
                payload: output.payload,
                ..packet
            },
            receipt,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn failed(
        &self,
        packet: ContextPacket,
        requested_max_output_bytes: usize,
        effective_max_output_bytes: usize,
        returned_identity: Option<SqzIdentity>,
        latency: Duration,
        candidate: Option<(&SqzPortOutput, usize, Option<SqzId>)>,
        fidelity_status: FidelityStatus,
        missing_fidelity_anchor_ids: Vec<String>,
        dlp_findings: Vec<String>,
        failure_reason: SqzFailureReason,
    ) -> Result<SqzEvaluation, SqzError> {
        let raw_bytes = packet.payload.len();
        let required_fidelity_anchor_ids =
            anchor_ids(&combined_anchors(&packet, &self.config.fidelity_anchors).anchors);
        let receipt = self.receipt(
            raw_bytes,
            raw_bytes,
            requested_max_output_bytes,
            effective_max_output_bytes,
            returned_identity,
            latency,
            candidate,
            SqzStatus::Failed,
            Some(failure_reason),
            fidelity_status,
            required_fidelity_anchor_ids,
            missing_fidelity_anchor_ids,
            dlp_findings,
        );
        if self.config.policy == SqzPolicy::InternalLocked {
            Err(SqzError {
                receipt: Box::new(receipt),
            })
        } else {
            Ok(SqzEvaluation { packet, receipt })
        }
    }

    fn base_receipt(
        &self,
        packet: &ContextPacket,
        raw_bytes: usize,
        returned_bytes: usize,
        requested_max_output_bytes: usize,
        effective_max_output_bytes: usize,
    ) -> SqzReceipt {
        let required_fidelity_anchor_ids =
            anchor_ids(&combined_anchors(packet, &self.config.fidelity_anchors).anchors);
        self.receipt(
            raw_bytes,
            returned_bytes,
            requested_max_output_bytes,
            effective_max_output_bytes,
            None,
            Duration::ZERO,
            None,
            SqzStatus::Off,
            None,
            FidelityStatus::NotEvaluated,
            required_fidelity_anchor_ids,
            Vec::new(),
            Vec::new(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn receipt(
        &self,
        raw_bytes: usize,
        returned_bytes: usize,
        requested_max_output_bytes: usize,
        effective_max_output_bytes: usize,
        returned_identity: Option<SqzIdentity>,
        monotonic_call_latency: Duration,
        candidate: Option<(&SqzPortOutput, usize, Option<SqzId>)>,
        status: SqzStatus,
        failure_reason: Option<SqzFailureReason>,
        fidelity_status: FidelityStatus,
        required_fidelity_anchor_ids: Vec<String>,
        missing_fidelity_anchor_ids: Vec<String>,
        dlp_findings: Vec<String>,
    ) -> SqzReceipt {
        let candidate_compressed_bytes = candidate.as_ref().map(|(_, bytes, _)| *bytes);
        let candidate_token_estimate_bytes_divided_by_four_ceiling =
            candidate_compressed_bytes.map(estimate_tokens);
        let actual_input_tokens = candidate
            .as_ref()
            .and_then(|(output, _, _)| output.actual_input_tokens);
        let actual_output_tokens = candidate
            .as_ref()
            .and_then(|(output, _, _)| output.actual_output_tokens);
        let sqz_id = matches!(status, SqzStatus::Applied | SqzStatus::NotBeneficial)
            .then(|| candidate.and_then(|(_, _, id)| id))
            .flatten();
        let dlp_status = if !dlp_findings.is_empty() {
            DlpStatus::Findings
        } else if status == SqzStatus::Off
            || matches!(
                failure_reason.as_ref(),
                Some(SqzFailureReason::ConfiguredIdentityMismatch)
                    | Some(SqzFailureReason::ConflictingFidelityAnchorIds)
            )
        {
            DlpStatus::NotEvaluated
        } else if matches!(
            failure_reason.as_ref(),
            Some(SqzFailureReason::PortUnavailable(_))
                | Some(SqzFailureReason::ReturnedIdentityMismatch)
                | Some(SqzFailureReason::OutputExceedsBound)
        ) {
            DlpStatus::InputPassed
        } else {
            DlpStatus::Passed
        };
        SqzReceipt {
            schema_version: SQZ_RECEIPT_SCHEMA_VERSION,
            configured_identity: self.config.identity.clone(),
            returned_identity,
            policy: self.config.policy,
            status,
            failure_reason,
            monotonic_call_latency,
            raw_bytes,
            candidate_compressed_bytes,
            returned_bytes,
            raw_token_estimate_bytes_divided_by_four_ceiling: estimate_tokens(raw_bytes),
            candidate_token_estimate_bytes_divided_by_four_ceiling,
            returned_token_estimate_bytes_divided_by_four_ceiling: estimate_tokens(returned_bytes),
            actual_input_tokens,
            actual_output_tokens,
            fidelity_status,
            required_fidelity_anchor_ids,
            missing_fidelity_anchor_ids,
            dlp_status,
            dlp_findings,
            requested_max_output_bytes,
            effective_max_output_bytes,
            sqz_id,
        }
    }
}

fn estimate_tokens(bytes: usize) -> usize {
    bytes / 4 + usize::from(!bytes.is_multiple_of(4))
}

fn fidelity_status(output: &str, anchors: &[PreservationAnchor]) -> (FidelityStatus, Vec<String>) {
    if anchors.is_empty() {
        return (FidelityStatus::RequiredButUnavailable, Vec::new());
    }
    let missing = anchors
        .iter()
        .filter(|anchor| !output.contains(anchor.value()))
        .map(|anchor| anchor.id().to_owned())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        (FidelityStatus::Passed, missing)
    } else {
        (FidelityStatus::Missing, missing)
    }
}

struct CombinedAnchors {
    anchors: Vec<PreservationAnchor>,
    conflicting_ids: bool,
}

fn combined_anchors(packet: &ContextPacket, configured: &[PreservationAnchor]) -> CombinedAnchors {
    let mut anchors = BTreeMap::<String, PreservationAnchor>::new();
    let mut conflicting_ids = false;
    for anchor in configured.iter().chain(
        packet
            .items
            .iter()
            .filter(|item| item.priority == EvidencePriority::Required)
            .flat_map(|item| item.preservation_anchors.iter()),
    ) {
        if let Some(existing) = anchors.get(anchor.id()) {
            if existing.value() != anchor.value() {
                conflicting_ids = true;
            }
        } else {
            anchors.insert(anchor.id().to_owned(), anchor.clone());
        }
    }
    CombinedAnchors {
        anchors: anchors.into_values().collect(),
        conflicting_ids,
    }
}

fn anchor_ids(anchors: &[PreservationAnchor]) -> Vec<String> {
    anchors
        .iter()
        .map(|anchor| anchor.id().to_owned())
        .collect()
}

fn content_id(output: &str) -> SqzId {
    let id = ResultId::sha256(output.as_bytes());
    SqzId {
        algorithm: id.algorithm(),
        value: id.value().to_owned(),
    }
}

fn dlp_findings(value: &str) -> Vec<String> {
    let lower = value.to_ascii_lowercase();
    let mut findings = Vec::new();
    if lower.contains("api_key=")
        || lower.contains("api_key:")
        || lower.contains("token=")
        || lower.contains("token:")
        || lower.contains("secret=")
        || lower.contains("secret:")
        || lower.contains("password=")
        || lower.contains("password:")
    {
        findings.push("credential_assignment".to_owned());
    }
    if value.contains("/home/") {
        findings.push("private_home_path".to_owned());
    }
    if lower.contains("bearer ") || lower.contains("ghp_") || lower.contains("gho_") {
        findings.push("bearer_or_token".to_owned());
    }
    if value.contains("-----BEGIN PRIVATE KEY-----") {
        findings.push("private_key".to_owned());
    }
    findings
}
