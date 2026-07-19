//! Provider-neutral agent-runtime coordination.
//! Standard library only; adapters own authentication, provider, and SQZ I/O.

use crate::adapters::{DlpStatus, FidelityStatus, SqzReceipt, SqzStatus};

use super::delegate::DelegationRequest;
use super::receipt::{
    DelegationReceipt, DelegationReceiptParts, EffectiveExecution, InlineResult,
    RequestedExecution, SqzStages, StoredResultRef,
};
use super::result_store::{MemoryResultStore, ResultId};
use super::runtime::{
    AgentFailure, Attestation, AuthError, AuthStore, InvocationLifecycle, InvocationMetrics,
    InvocationOutcome, InvocationState, ProviderError, ProviderPort, ProviderRequest,
};
use super::{AgentProfile, AgentProfileRegistry, ReasoningLevel, ToolPolicy};

/// Stage at which SQZ compression is applied during agent coordination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqzStage {
    Input,
    Output,
}

/// Immutable output from an agent SQZ stage: a bounded, non-blank payload
/// together with the corresponding policy receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSqzOutput {
    payload: String,
    receipt: SqzReceipt,
}

impl AgentSqzOutput {
    pub fn new(payload: impl Into<String>, receipt: SqzReceipt) -> Result<Self, AgentSqzError> {
        let payload = payload.into();
        if payload.trim().is_empty() || payload.len() > 1_048_576 {
            return Err(AgentSqzError::new(AgentSqzFailureCode::InvalidOutput, None));
        }
        Ok(Self { payload, receipt })
    }

    pub fn payload(&self) -> &str {
        &self.payload
    }

    pub fn receipt(&self) -> &SqzReceipt {
        &self.receipt
    }
}

/// Closed codes for agent SQZ failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSqzFailureCode {
    InputFailed,
    OutputFailed,
    InvalidOutput,
}

/// SQZ failure with optional partial policy evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSqzError {
    code: AgentSqzFailureCode,
    receipt: Option<Box<SqzReceipt>>,
}

impl AgentSqzError {
    pub fn new(code: AgentSqzFailureCode, receipt: Option<SqzReceipt>) -> Self {
        Self {
            code,
            receipt: receipt.map(Box::new),
        }
    }

    pub fn code(&self) -> AgentSqzFailureCode {
        self.code
    }

    pub fn receipt(&self) -> Option<&SqzReceipt> {
        self.receipt.as_deref()
    }

    fn into_receipt(self) -> Option<SqzReceipt> {
        self.receipt.map(|receipt| *receipt)
    }
}

/// Provider-neutral port for SQZ evaluation at agent coordination seams.
pub trait AgentSqzPort {
    fn evaluate(
        &self,
        stage: SqzStage,
        payload: &str,
        max_output_bytes: usize,
    ) -> Result<AgentSqzOutput, AgentSqzError>;
}

/// Runtime configuration for connected agent behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRuntimeConfig {
    enabled: bool,
    max_delegation_depth: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRuntimeConfigError {
    _p: (),
}

impl AgentRuntimeConfig {
    pub fn new(
        enabled: bool,
        max_delegation_depth: usize,
    ) -> Result<Self, AgentRuntimeConfigError> {
        if !(1..=8).contains(&max_delegation_depth) {
            return Err(AgentRuntimeConfigError { _p: () });
        }
        Ok(Self {
            enabled,
            max_delegation_depth,
        })
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn max_delegation_depth(&self) -> usize {
        self.max_delegation_depth
    }
}

impl Default for AgentRuntimeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_delegation_depth: 8,
        }
    }
}

/// Immutable authority determined by the host, never by a delegation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRuntimeAuthority {
    explicit_offline: bool,
    project_trusted: bool,
    mutation_authorized: bool,
}

impl AgentRuntimeAuthority {
    pub const fn new(
        explicit_offline: bool,
        project_trusted: bool,
        mutation_authorized: bool,
    ) -> Self {
        Self {
            explicit_offline,
            project_trusted,
            mutation_authorized,
        }
    }
}

/// Borrowed seam bundle for agent runtime ports and stores.
pub struct RuntimePorts<'a, Auth, Prov, SqzP>
where
    Auth: AuthStore,
    Prov: ProviderPort<<Auth as AuthStore>::Credential>,
    SqzP: AgentSqzPort,
{
    pub auth_store: &'a Auth,
    pub provider_port: &'a Prov,
    pub agent_sqz_port: &'a SqzP,
    pub memory_result_store: &'a mut MemoryResultStore,
}

impl<'a, Auth, Prov, SqzP> RuntimePorts<'a, Auth, Prov, SqzP>
where
    Auth: AuthStore,
    Prov: ProviderPort<<Auth as AuthStore>::Credential>,
    SqzP: AgentSqzPort,
{
    pub fn new(
        auth_store: &'a Auth,
        provider_port: &'a Prov,
        agent_sqz_port: &'a SqzP,
        memory_result_store: &'a mut MemoryResultStore,
    ) -> Self {
        Self {
            auth_store,
            provider_port,
            agent_sqz_port,
            memory_result_store,
        }
    }
}

/// The only runtime error: a receipt invariant which should be unreachable
/// after the validated request, profile, and provider contracts are honored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRuntimeInternalError {
    ReceiptInvariant,
}

/// Provider-neutral agent coordination state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRuntime {
    config: AgentRuntimeConfig,
}

impl AgentRuntime {
    pub const fn new(config: AgentRuntimeConfig) -> Self {
        Self { config }
    }

    pub const fn config(&self) -> AgentRuntimeConfig {
        self.config
    }

    /// Coordinates one request. Operational failures are always incomplete,
    /// content-free receipts; only impossible receipt construction fails here.
    pub fn invoke<'a, Auth, Prov, SqzP, Factory>(
        &self,
        request: &DelegationRequest,
        authority: AgentRuntimeAuthority,
        agent_profile_registry: &AgentProfileRegistry,
        ports: Factory,
        now_tick: u64,
    ) -> Result<DelegationReceipt, AgentRuntimeInternalError>
    where
        Auth: AuthStore + 'a,
        Prov: ProviderPort<Auth::Credential> + 'a,
        SqzP: AgentSqzPort + 'a,
        Factory: FnOnce() -> RuntimePorts<'a, Auth, Prov, SqzP>,
    {
        let mut lifecycle = InvocationLifecycle::configured();
        let provisional = requested(request, None, None, None)?;
        let unavailable = unavailable_effective(request.tool_policy().clone());
        if !self.config.enabled() {
            return incomplete(
                provisional,
                unavailable,
                AgentFailure::AgentDisabled,
                None,
                None,
                0,
                0,
                request.no_session(),
            );
        }
        if authority.explicit_offline {
            return incomplete(
                provisional,
                unavailable,
                AgentFailure::ExplicitOffline,
                None,
                None,
                0,
                0,
                request.no_session(),
            );
        }
        if !authority.project_trusted {
            return incomplete(
                provisional,
                unavailable,
                AgentFailure::ProjectUntrusted,
                None,
                None,
                0,
                0,
                request.no_session(),
            );
        }
        if request.delegation_depth() > self.config.max_delegation_depth() {
            return incomplete(
                provisional,
                unavailable,
                AgentFailure::DepthExceeded,
                None,
                None,
                0,
                0,
                request.no_session(),
            );
        }

        let profile = match agent_profile_registry.get(request.profile()) {
            Ok(profile) => profile,
            Err(_) => {
                return incomplete(
                    provisional,
                    unavailable,
                    AgentFailure::UnknownProfile,
                    None,
                    None,
                    0,
                    0,
                    request.no_session(),
                )
            }
        };
        if denied_tool(request.tool_policy(), profile.tool_policy()) {
            return incomplete(
                requested(request, Some(profile), None, None)?,
                unavailable_effective(request.tool_policy().clone()),
                AgentFailure::DeniedTool,
                None,
                None,
                0,
                0,
                request.no_session(),
            );
        }
        if !authority.mutation_authorized && mutation_requested(request.tool_policy()) {
            return incomplete(
                requested(request, Some(profile), None, None)?,
                unavailable_effective(request.tool_policy().clone()),
                AgentFailure::DeniedTool,
                None,
                None,
                0,
                0,
                request.no_session(),
            );
        }

        let provider = request.provider_override().unwrap_or(profile.provider());
        let model = request.model_override().unwrap_or(profile.model());
        let reasoning = request
            .reasoning_override()
            .unwrap_or(profile.default_reasoning_level());
        let requested = requested(request, Some(profile), Some(provider), Some(model))?;
        let selected = unavailable_effective(request.tool_policy().clone());
        if agent_profile_registry
            .provider_registry()
            .require(provider)
            .is_err()
        {
            return incomplete(
                requested,
                selected,
                AgentFailure::UnknownProvider,
                None,
                None,
                0,
                0,
                request.no_session(),
            );
        }
        if agent_profile_registry
            .model_registry()
            .require_for_provider(provider, model)
            .is_err()
        {
            return incomplete(
                requested,
                selected,
                AgentFailure::UnknownModel,
                None,
                None,
                0,
                0,
                request.no_session(),
            );
        }

        let ports = ports();
        let credential = match ports.auth_store.resolve(profile.account_handle()) {
            Ok(credential) => credential,
            Err(AuthError::Missing | AuthError::Unavailable | AuthError::Locked) => {
                return incomplete(
                    requested,
                    selected,
                    AgentFailure::MissingAuth,
                    None,
                    None,
                    0,
                    0,
                    request.no_session(),
                )
            }
        };
        let input = match ports.agent_sqz_port.evaluate(
            SqzStage::Input,
            request.prompt(),
            request.max_output_bytes(),
        ) {
            Ok(output) => output,
            Err(error) => {
                let failure = sqz_failure(error.code(), SqzStage::Input);
                return incomplete(
                    requested,
                    selected,
                    failure,
                    error.into_receipt(),
                    None,
                    0,
                    0,
                    request.no_session(),
                );
            }
        };
        let input_bytes = input.payload().len();
        if !accepted_sqz(input.receipt(), input.payload()) {
            return incomplete(
                requested,
                selected,
                AgentFailure::SqzInputFailed,
                Some(input.receipt().clone()),
                None,
                0,
                0,
                request.no_session(),
            );
        }
        let provider_request = match ProviderRequest::new(
            provider,
            model,
            reasoning,
            request.tool_policy().clone(),
            input.payload(),
            request.max_output_bytes(),
            request.delegation_depth(),
        ) {
            Ok(provider_request) => provider_request,
            Err(_) => {
                return incomplete(
                    requested,
                    selected,
                    AgentFailure::SqzInputFailed,
                    Some(input.receipt().clone()),
                    None,
                    input_bytes,
                    0,
                    request.no_session(),
                )
            }
        };
        lifecycle
            .advance(InvocationState::PacketReady)
            .and_then(|_| lifecycle.advance(InvocationState::Running))
            .map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)?;
        let provider_output = match ports.provider_port.invoke(&provider_request, &credential) {
            Ok(output) => output,
            Err(error) => {
                return incomplete(
                    requested,
                    selected,
                    provider_failure(error),
                    Some(input.receipt().clone()),
                    None,
                    input_bytes,
                    0,
                    request.no_session(),
                )
            }
        };
        lifecycle
            .advance(InvocationState::Validating)
            .map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)?;
        let effective = provider_effective(
            profile,
            provider,
            &provider_output,
            request.tool_policy().clone(),
            agent_profile_registry,
        );
        let output = match ports.agent_sqz_port.evaluate(
            SqzStage::Output,
            provider_output.answer(),
            request.max_output_bytes(),
        ) {
            Ok(output) => output,
            Err(error) => {
                let failure = sqz_failure(error.code(), SqzStage::Output);
                return incomplete(
                    requested,
                    effective,
                    failure,
                    Some(input.receipt().clone()),
                    error.into_receipt(),
                    input_bytes,
                    0,
                    request.no_session(),
                );
            }
        };

        if !accepted_sqz(output.receipt(), output.payload()) {
            return incomplete(
                requested,
                effective,
                AgentFailure::SqzOutputFailed,
                Some(input.receipt().clone()),
                Some(output.receipt().clone()),
                input_bytes,
                0,
                request.no_session(),
            );
        }

        let stored_ref = match store_output(
            ports.memory_result_store,
            output.payload(),
            provider_output.citations(),
            provider_output.artifacts(),
            now_tick,
        ) {
            Some(stored_ref) => stored_ref,
            None => {
                return incomplete(
                    requested,
                    effective,
                    AgentFailure::ResultStoreFailed,
                    Some(input.receipt().clone()),
                    Some(output.receipt().clone()),
                    input_bytes,
                    output.payload().len(),
                    request.no_session(),
                )
            }
        };
        let inline = InlineResult::new(
            output.payload(),
            provider_output.citations().iter().cloned(),
        )
        .map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)?;
        complete(
            &mut lifecycle,
            requested,
            effective,
            input.receipt().clone(),
            output.receipt().clone(),
            inline,
            stored_ref,
            provider_output.actual_input_tokens(),
            provider_output.actual_output_tokens(),
            input_bytes,
            output.payload().len(),
            request.no_session(),
            provider_run_id(&provider_output),
        )
    }
}

fn requested(
    request: &DelegationRequest,
    profile: Option<&AgentProfile>,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<RequestedExecution, AgentRuntimeInternalError> {
    RequestedExecution::with_attestations(
        request.profile(),
        provider
            .or(request.provider_override())
            .or(profile.map(AgentProfile::provider))
            .map(|value| Attestation::Attested(value.to_string()))
            .unwrap_or(Attestation::Unavailable),
        model
            .or(request.model_override())
            .or(profile.map(AgentProfile::model))
            .map(|value| Attestation::Attested(value.to_string()))
            .unwrap_or(Attestation::Unavailable),
        request
            .reasoning_override()
            .or(profile.map(AgentProfile::default_reasoning_level))
            .map(Attestation::Attested)
            .unwrap_or(Attestation::Unavailable),
        request.tool_policy().clone(),
    )
    .map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)
}

fn unavailable_effective(tool_policy: ToolPolicy) -> EffectiveExecution {
    EffectiveExecution::new(
        Attestation::Unavailable,
        Attestation::Unavailable,
        Attestation::Unavailable,
        Attestation::Unavailable,
        tool_policy,
    )
}

fn provider_effective(
    profile: &AgentProfile,
    provider: &str,
    output: &super::runtime::ProviderOutput,
    tool_policy: ToolPolicy,
    registry: &AgentProfileRegistry,
) -> EffectiveExecution {
    let model = match output.effective_model() {
        Some(model) => {
            if registry
                .model_registry()
                .require_for_provider(provider, model)
                .is_err()
            {
                Attestation::Unavailable
            } else {
                Attestation::Attested(model.to_string())
            }
        }
        None => Attestation::Unavailable,
    };
    let reasoning = match output.effective_reasoning() {
        Some(reasoning) => ReasoningLevel::parse(reasoning)
            .map(Attestation::Attested)
            .unwrap_or(Attestation::Unavailable),
        None => Attestation::Unavailable,
    };
    EffectiveExecution::new(
        match output.effective_profile() {
            Some(value) if value == profile.name() => Attestation::Attested(profile.clone()),
            _ => Attestation::Unavailable,
        },
        match output.effective_provider() {
            Some(value) if value == provider => Attestation::Attested(provider.to_string()),
            _ => Attestation::Unavailable,
        },
        model,
        reasoning,
        tool_policy,
    )
}

fn denied_tool(request: &ToolPolicy, profile: &ToolPolicy) -> bool {
    ["read", "search", "write", "edit", "shell", "network"]
        .into_iter()
        .any(|tool| request.allows(tool) && !profile.allows(tool))
}

fn mutation_requested(policy: &ToolPolicy) -> bool {
    ["write", "edit", "shell", "network"]
        .into_iter()
        .any(|tool| policy.allows(tool))
}

fn sqz_failure(code: AgentSqzFailureCode, stage: SqzStage) -> AgentFailure {
    match (code, stage) {
        (AgentSqzFailureCode::InvalidOutput, SqzStage::Output) => AgentFailure::InvalidOutput,
        (_, SqzStage::Input) => AgentFailure::SqzInputFailed,
        _ => AgentFailure::SqzOutputFailed,
    }
}

fn provider_failure(error: ProviderError) -> AgentFailure {
    match error {
        ProviderError::Timeout => AgentFailure::Timeout,
        ProviderError::Cancelled => AgentFailure::Cancelled,
        ProviderError::InvalidOutput => AgentFailure::InvalidOutput,
        ProviderError::Unavailable => AgentFailure::ProviderUnavailable,
        ProviderError::Failed => AgentFailure::ProviderFailed,
    }
}

fn accepted_sqz(receipt: &SqzReceipt, payload: &str) -> bool {
    matches!(
        receipt.status,
        SqzStatus::Applied | SqzStatus::NotBeneficial
    ) && receipt.failure_reason.is_none()
        && receipt.fidelity_status == FidelityStatus::Passed
        && receipt.dlp_status == DlpStatus::Passed
        && receipt.dlp_findings.is_empty()
        && receipt.sqz_id.as_ref().is_some_and(|id| {
            id.algorithm == ResultId::sha256(payload.as_bytes()).algorithm()
                && id.value == ResultId::sha256(payload.as_bytes()).value()
        })
}

#[allow(clippy::too_many_arguments)]
fn incomplete(
    requested: RequestedExecution,
    effective: EffectiveExecution,
    failure: AgentFailure,
    input: Option<SqzReceipt>,
    output: Option<SqzReceipt>,
    input_bytes: usize,
    output_bytes: usize,
    no_session: bool,
) -> Result<DelegationReceipt, AgentRuntimeInternalError> {
    let mut lifecycle = InvocationLifecycle::configured();
    lifecycle
        .incomplete()
        .map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)?;
    receipt(DelegationReceiptParts {
        outcome: InvocationOutcome::new(
            InvocationState::Incomplete,
            Some(failure),
            InvocationMetrics::new(None, None, input_bytes, output_bytes, 0),
        )
        .map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)?,
        requested,
        effective,
        sqz: SqzStages::new(input, output),
        inline_result: None,
        stored_ref: None,
        no_session,
        provenance: vec!["bran-agent-runtime".to_string()],
    })
}

#[allow(clippy::too_many_arguments)]
fn complete(
    lifecycle: &mut InvocationLifecycle,
    requested: RequestedExecution,
    effective: EffectiveExecution,
    input: SqzReceipt,
    output: SqzReceipt,
    inline: InlineResult,
    stored_ref: StoredResultRef,
    actual_input_tokens: Option<usize>,
    actual_output_tokens: Option<usize>,
    input_bytes: usize,
    output_bytes: usize,
    no_session: bool,
    provider_run_id: Attestation<String>,
) -> Result<DelegationReceipt, AgentRuntimeInternalError> {
    lifecycle
        .complete()
        .map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)?;
    receipt(DelegationReceiptParts {
        outcome: InvocationOutcome::new(
            InvocationState::Complete,
            None,
            InvocationMetrics::new(
                actual_input_tokens,
                actual_output_tokens,
                input_bytes,
                output_bytes,
                0,
            ),
        )
        .map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)?,
        requested,
        effective,
        sqz: SqzStages::new(Some(input), Some(output)),
        inline_result: Some(inline),
        stored_ref: Some(stored_ref),
        no_session,
        provenance: vec!["bran-agent-runtime".to_string()],
    })?
    .with_provider_run_id(provider_run_id)
    .map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)
}

fn provider_run_id(output: &super::runtime::ProviderOutput) -> Attestation<String> {
    output
        .provider_run_id()
        .map(|value| Attestation::Attested(value.to_string()))
        .unwrap_or(Attestation::Unavailable)
}

fn receipt(parts: DelegationReceiptParts) -> Result<DelegationReceipt, AgentRuntimeInternalError> {
    DelegationReceipt::new(parts).map_err(|_| AgentRuntimeInternalError::ReceiptInvariant)
}

fn store_output(
    store: &mut MemoryResultStore,
    answer: &str,
    citations: &[String],
    artifacts: &[super::runtime::LosslessArtifact],
    now_tick: u64,
) -> Option<StoredResultRef> {
    let result_id = store
        .put(encode_result(answer, citations), now_tick)
        .ok()?
        .id;
    let mut artifact_ids = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        let stored = store.put(artifact.bytes(), now_tick).ok()?.id;
        if stored != *artifact.id() {
            return None;
        }
        artifact_ids.push(stored);
    }
    StoredResultRef::new(result_id, artifact_ids).ok()
}

fn encode_result(answer: &str, citations: &[String]) -> Vec<u8> {
    let mut encoded =
        Vec::with_capacity(answer.len() + citations.iter().map(String::len).sum::<usize>() + 32);
    encoded.extend_from_slice(b"bran-agent-result-v1");
    encode_field(&mut encoded, answer.as_bytes());
    encoded.extend_from_slice(&(citations.len() as u64).to_be_bytes());
    for citation in citations {
        encode_field(&mut encoded, citation.as_bytes());
    }
    encoded
}

fn encode_field(encoded: &mut Vec<u8>, field: &[u8]) {
    encoded.extend_from_slice(&(field.len() as u64).to_be_bytes());
    encoded.extend_from_slice(field);
}

#[cfg(test)]
mod tests {
    use super::super::delegate::{DelegationOptions, DelegationRequest};
    use super::super::result_store::MemoryResultStore;
    use super::super::runtime::{
        AgentFailure, ArtifactKind, Attestation, AuthError, AuthStore, InvocationLifecycle,
        InvocationOutcome, InvocationState, LosslessArtifact, ProviderError,
        ProviderExecutionEvidence, ProviderOutput, ProviderPort, ProviderRequest,
        ProviderTokenUsage,
    };
    use super::*;
    use crate::adapters::{
        DlpStatus, FidelityStatus, SqzFailureReason, SqzId, SqzIdentity, SqzPolicy, SqzReceipt,
        SqzStatus,
    };
    use crate::agent::{
        AgentProfile, AgentProfileRegistry, ModelRegistry, ProviderRegistry, ReasoningLevel,
        ToolPolicy,
    };
    use std::cell::Cell;
    use std::time::Duration;

    fn make_sqz_receipt(payload: &str) -> SqzReceipt {
        let id = SqzIdentity::approved();
        let raw_len = payload.len();
        let tok = raw_len / 4 + usize::from(!raw_len.is_multiple_of(4));
        let content_id = ResultId::sha256(payload.as_bytes());
        SqzReceipt {
            schema_version: "1.0.0",
            configured_identity: id.clone(),
            returned_identity: Some(id),
            policy: SqzPolicy::PublicOn,
            status: SqzStatus::Applied,
            failure_reason: None,
            monotonic_call_latency: Duration::ZERO,
            raw_bytes: raw_len,
            candidate_compressed_bytes: None,
            returned_bytes: raw_len,
            raw_token_estimate_bytes_divided_by_four_ceiling: tok,
            candidate_token_estimate_bytes_divided_by_four_ceiling: None,
            returned_token_estimate_bytes_divided_by_four_ceiling: tok,
            actual_input_tokens: None,
            actual_output_tokens: None,
            fidelity_status: FidelityStatus::Passed,
            required_fidelity_anchor_ids: vec![],
            missing_fidelity_anchor_ids: vec![],
            dlp_status: DlpStatus::Passed,
            dlp_findings: vec![],
            requested_max_output_bytes: 65_536,
            effective_max_output_bytes: 65_536,
            sqz_id: Some(SqzId {
                algorithm: content_id.algorithm(),
                value: content_id.value().to_owned(),
            }),
        }
    }

    fn build_registry() -> AgentProfileRegistry {
        let mut pr = ProviderRegistry::new();
        pr.register("fixture-provider").unwrap();
        pr.register("other-provider").unwrap();
        let mut mr = ModelRegistry::new();
        mr.register("fixture-provider", "fixture-sol").unwrap();
        mr.register("fixture-provider", "fixture-luna").unwrap();
        mr.register("other-provider", "other-model").unwrap();
        let mut apr = AgentProfileRegistry::new(pr, mr);
        let sol_policy =
            ToolPolicy::new(["read", "search", "write"], ["edit", "shell", "network"]).unwrap();
        let sol = AgentProfile::new(
            "sol",
            "fixture-provider",
            "fixture-sol",
            "sol-default",
            ReasoningLevel::High,
            sol_policy,
        )
        .unwrap();
        apr.register(sol).unwrap();
        // Restricted profile: denies "search" so default request tp triggers denied_tool
        let restricted =
            ToolPolicy::new(["read"], ["search", "write", "edit", "shell", "network"]).unwrap();
        let luna = AgentProfile::new(
            "luna",
            "fixture-provider",
            "fixture-luna",
            "luna-default",
            ReasoningLevel::Low,
            restricted,
        )
        .unwrap();
        apr.register(luna).unwrap();
        apr
    }

    fn make_request(profile: &str, prompt: &str, opts: DelegationOptions) -> DelegationRequest {
        DelegationRequest::new(profile, prompt, opts).unwrap()
    }

    fn make_trusted_opts() -> DelegationOptions {
        DelegationOptions::new()
    }

    struct FakeAuthStore {
        calls: Cell<usize>,
        fail_handle: Option<String>,
    }

    impl FakeAuthStore {
        fn always_ok() -> Self {
            Self {
                calls: Cell::new(0),
                fail_handle: None,
            }
        }
        fn missing_for(handle: &str) -> Self {
            Self {
                calls: Cell::new(0),
                fail_handle: Some(handle.to_string()),
            }
        }
    }

    impl AuthStore for FakeAuthStore {
        type Credential = String;
        fn resolve(&self, account_handle: &str) -> Result<Self::Credential, AuthError> {
            self.calls.set(self.calls.get() + 1);
            if self.fail_handle.as_deref() == Some(account_handle) {
                Err(AuthError::Missing)
            } else {
                Ok("test-cred".to_string())
            }
        }
    }

    #[derive(Clone)]
    enum ProvOutcome {
        Ok(Box<ProviderOutput>),
        Err(ProviderError),
    }

    struct FakeProviderPort {
        calls: Cell<usize>,
        outcome: ProvOutcome,
    }

    impl FakeProviderPort {
        fn success(out: ProviderOutput) -> Self {
            Self {
                calls: Cell::new(0),
                outcome: ProvOutcome::Ok(Box::new(out)),
            }
        }
        fn fail(err: ProviderError) -> Self {
            Self {
                calls: Cell::new(0),
                outcome: ProvOutcome::Err(err),
            }
        }
    }

    impl ProviderPort<String> for FakeProviderPort {
        fn invoke(
            &self,
            _request: &ProviderRequest,
            _credential: &String,
        ) -> Result<ProviderOutput, ProviderError> {
            self.calls.set(self.calls.get() + 1);
            match &self.outcome {
                ProvOutcome::Ok(o) => Ok((**o).clone()),
                ProvOutcome::Err(e) => Err(*e),
            }
        }
    }

    #[derive(Clone, Copy)]
    enum SqzBehavior {
        Passthrough,
        FailInput,
        FailOutput,
        RewriteOutput,
        DlpOutput,
    }

    struct FakeAgentSqzPort {
        calls: Cell<usize>,
        behavior: SqzBehavior,
    }

    impl FakeAgentSqzPort {
        fn passthrough() -> Self {
            Self {
                calls: Cell::new(0),
                behavior: SqzBehavior::Passthrough,
            }
        }
        fn fail_input() -> Self {
            Self {
                calls: Cell::new(0),
                behavior: SqzBehavior::FailInput,
            }
        }
        fn fail_output() -> Self {
            Self {
                calls: Cell::new(0),
                behavior: SqzBehavior::FailOutput,
            }
        }
        fn rewrite_output() -> Self {
            Self {
                calls: Cell::new(0),
                behavior: SqzBehavior::RewriteOutput,
            }
        }
        fn dlp_output() -> Self {
            Self {
                calls: Cell::new(0),
                behavior: SqzBehavior::DlpOutput,
            }
        }
    }

    impl AgentSqzPort for FakeAgentSqzPort {
        fn evaluate(
            &self,
            stage: SqzStage,
            payload: &str,
            _max_output_bytes: usize,
        ) -> Result<AgentSqzOutput, AgentSqzError> {
            let n = self.calls.get() + 1;
            self.calls.set(n);
            match self.behavior {
                SqzBehavior::FailInput => {
                    return Err(AgentSqzError::new(AgentSqzFailureCode::InputFailed, None));
                }
                SqzBehavior::FailOutput => {
                    if n >= 2 {
                        return Err(AgentSqzError::new(AgentSqzFailureCode::OutputFailed, None));
                    }
                }
                SqzBehavior::Passthrough => {}
                SqzBehavior::RewriteOutput if stage == SqzStage::Output => {
                    let rewritten = "SQZ answer";
                    return AgentSqzOutput::new(rewritten, make_sqz_receipt(rewritten));
                }
                SqzBehavior::DlpOutput if stage == SqzStage::Output => {
                    let canary = "api_key=canary";
                    let mut receipt = make_sqz_receipt(canary);
                    receipt.status = SqzStatus::Failed;
                    receipt.failure_reason = Some(SqzFailureReason::DlpFindings);
                    receipt.dlp_status = DlpStatus::Findings;
                    receipt.dlp_findings = vec!["credential_assignment".to_string()];
                    return AgentSqzOutput::new(canary, receipt);
                }
                SqzBehavior::RewriteOutput | SqzBehavior::DlpOutput => {}
            }
            let receipt = make_sqz_receipt(payload);
            AgentSqzOutput::new(payload.to_owned(), receipt)
        }
    }

    fn make_success_provider_output() -> ProviderOutput {
        let answer = "The answer is 42 with citations.";
        let citations = vec!["src1".to_string(), "doc2".to_string()];
        let artifact = LosslessArtifact::new(
            ArtifactKind::Json,
            "application/json",
            b"{\"patch\":\"diff\"}".to_vec(),
        )
        .unwrap();
        let tokens = ProviderTokenUsage {
            actual_input_tokens: Some(123),
            actual_output_tokens: Some(9),
        };
        ProviderOutput::with_effective_execution(
            answer,
            citations,
            Some("prov-run-xyz"),
            ProviderExecutionEvidence::new(
                Some("sol"),
                Some("fixture-provider"),
                Some("fixture-sol"),
                Some("high"),
            )
            .unwrap(),
            tokens,
            vec![artifact],
        )
        .unwrap()
    }

    #[test]
    fn p3_agent_runtime() {
        let registry = build_registry();
        let success_out = make_success_provider_output();
        let success_answer = success_out.answer().to_string();
        let success_citations = success_out.citations().to_vec();
        let rt = AgentRuntime::new(AgentRuntimeConfig::new(true, 2).unwrap());
        assert!(!AgentRuntimeConfig::default().enabled());
        assert_eq!(AgentRuntimeConfig::default().max_delegation_depth(), 8);

        // --- disabled (runtime disabled): zero calls, incomplete, no success fields, flag passthrough
        {
            let disabled_rt = AgentRuntime::new(AgentRuntimeConfig::new(false, 2).unwrap());
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let factory_calls = Cell::new(0);
            let mut opts = DelegationOptions::new();
            opts.no_session = true;
            let req = make_request("sol", "disabled test", opts);
            let rec = disabled_rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || {
                        factory_calls.set(factory_calls.get() + 1);
                        RuntimePorts::new(&auth, &prov, &sqz, &mut store)
                    },
                    1000,
                )
                .unwrap();
            assert_eq!(factory_calls.get(), 0);
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            assert_eq!(store.receipt().entry_count, 0);
            assert_eq!(store.receipt().total_bytes, 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::AgentDisabled);
                }
                _ => panic!("expected incomplete disabled"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
            assert!(rec.no_session());
            assert!(rec.sqz_stages().input().is_none());
            assert!(rec.sqz_stages().output().is_none());
            assert_eq!(rec.requested().provider(), &Attestation::Unavailable);
            assert_eq!(rec.requested().model(), &Attestation::Unavailable);
            assert_eq!(rec.requested().reasoning(), &Attestation::Unavailable);
            assert_eq!(rec.effective().profile(), &Attestation::Unavailable);
            assert_eq!(rec.provider_run_id(), &Attestation::Unavailable);
        }

        // --- offline: treated as disabled, zero calls before any store/port/auth/sqz
        {
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let factory_calls = Cell::new(0);
            let opts = DelegationOptions::new();
            let req = make_request("sol", "offline test", opts);
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(true, true, false),
                    &registry,
                    || {
                        factory_calls.set(factory_calls.get() + 1);
                        RuntimePorts::new(&auth, &prov, &sqz, &mut store)
                    },
                    1001,
                )
                .unwrap();
            assert_eq!(factory_calls.get(), 0);
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            assert_eq!(store.receipt().entry_count, 0);
            assert_eq!(store.receipt().total_bytes, 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::ExplicitOffline);
                }
                _ => panic!("expected offline disabled"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- !project_trusted: also disabled early
        {
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let factory_calls = Cell::new(0);
            let opts = DelegationOptions::new();
            let req = make_request("sol", "untrusted", opts);
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, false, false),
                    &registry,
                    || {
                        factory_calls.set(factory_calls.get() + 1);
                        RuntimePorts::new(&auth, &prov, &sqz, &mut store)
                    },
                    1002,
                )
                .unwrap();
            assert_eq!(factory_calls.get(), 0);
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::ProjectUntrusted);
                }
                _ => panic!("expected untrusted disabled"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- depth exceeded: early, zero calls
        {
            let depth_rt = AgentRuntime::new(AgentRuntimeConfig::new(true, 1).unwrap());
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let mut opts = make_trusted_opts();
            opts.delegation_depth = 5;
            let req = make_request("sol", "deep prompt", opts);
            let rec = depth_rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1003,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::DepthExceeded);
                }
                _ => panic!("expected depth"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- unknown profile: early, typed, no success result
        {
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("no-such-prof", "prompt", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1004,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::UnknownProfile);
                }
                _ => panic!("expected unknown profile"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- unknown provider (via override): after profile, before auth/sqz
        {
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let mut opts = make_trusted_opts();
            opts.provider_override = Some("no-such-prov".to_string());
            let req = make_request("sol", "prov-override", opts);
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1005,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::UnknownProvider);
                }
                _ => panic!("expected unknown provider"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- unknown model (via override)
        {
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let mut opts = make_trusted_opts();
            opts.model_override = Some("no-such-model".to_string());
            let req = make_request("sol", "model-override", opts);
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1006,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::UnknownModel);
                }
                _ => panic!("expected unknown model"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- model registered only under another provider: rejected before auth/SQZ/provider
        {
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let mut opts = make_trusted_opts();
            opts.model_override = Some("other-model".to_string());
            let req = make_request("sol", "mismatched-model-override", opts);
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1006,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::UnknownModel);
                }
                _ => panic!("expected mismatched model"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- denied tool: request allows search, profile luna does not
        {
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("luna", "search x", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1007,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::DeniedTool);
                }
                _ => panic!("expected denied tool"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- host policy denies requested mutation before ports exist
        {
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let factory_calls = Cell::new(0);
            let mut opts = make_trusted_opts();
            opts.tool_policy =
                ToolPolicy::new(["read", "write"], ["edit", "shell", "network"]).unwrap();
            let req = make_request("sol", "write denied", opts);
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || {
                        factory_calls.set(factory_calls.get() + 1);
                        RuntimePorts::new(&auth, &prov, &sqz, &mut store)
                    },
                    1008,
                )
                .unwrap();
            assert_eq!(factory_calls.get(), 0);
            assert_eq!(auth.calls.get(), 0);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::DeniedTool);
                }
                _ => panic!("expected host mutation denial"),
            }
        }

        // --- missing auth: auth called, sqz/provider not, typed failure, no success result
        {
            let auth = FakeAuthStore::missing_for("sol-default");
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::passthrough();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("sol", "needs auth", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1008,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 1);
            assert_eq!(prov.calls.get(), 0);
            assert_eq!(sqz.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::MissingAuth);
                }
                _ => panic!("expected missing auth"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- sqz input failed: auth yes, sqz once (input), no provider, typed
        {
            let auth = FakeAuthStore::always_ok();
            let prov = FakeProviderPort::success(success_out.clone());
            let sqz = FakeAgentSqzPort::fail_input();
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("sol", "sqz will fail in", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1009,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 1);
            assert_eq!(sqz.calls.get(), 1);
            assert_eq!(prov.calls.get(), 0);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::SqzInputFailed);
                }
                _ => panic!("expected sqz input failed"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- provider timeout: sqz input once, provider once, no output sqz, no success result
        {
            let auth = FakeAuthStore::always_ok();
            let sqz = FakeAgentSqzPort::passthrough();
            let prov = FakeProviderPort::fail(ProviderError::Timeout);
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("sol", "timeout", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1010,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 1);
            assert_eq!(sqz.calls.get(), 1);
            assert_eq!(prov.calls.get(), 1);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::Timeout);
                }
                _ => panic!("expected timeout"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
            // output sqz not reached
            // (input sqz receipt present)
            assert!(rec.sqz_stages().input().is_some());
            assert!(rec.sqz_stages().output().is_none());
        }

        // --- provider cancelled
        {
            let auth = FakeAuthStore::always_ok();
            let sqz = FakeAgentSqzPort::passthrough();
            let prov = FakeProviderPort::fail(ProviderError::Cancelled);
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("sol", "cancel", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1011,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 1);
            assert_eq!(sqz.calls.get(), 1);
            assert_eq!(prov.calls.get(), 1);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::Cancelled);
                }
                _ => panic!("expected cancelled"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- provider failure is distinct from an unavailable provider
        {
            let auth = FakeAuthStore::always_ok();
            let sqz = FakeAgentSqzPort::passthrough();
            let prov = FakeProviderPort::fail(ProviderError::Failed);
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let rec = rt
                .invoke(
                    &make_request("sol", "failed", make_trusted_opts()),
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1011,
                )
                .unwrap();
            assert!(matches!(
                rec.outcome(),
                InvocationOutcome::Incomplete {
                    failure: AgentFailure::ProviderFailed,
                    ..
                }
            ));
        }

        // --- sqz output failed (after input + provider): has input sqz, failure typed, no inline/stored
        {
            let auth = FakeAuthStore::always_ok();
            let sqz = FakeAgentSqzPort::fail_output();
            let prov = FakeProviderPort::success(success_out.clone());
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("sol", "sqz out fail", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1012,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 1);
            assert_eq!(sqz.calls.get(), 2);
            assert_eq!(prov.calls.get(), 1);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::SqzOutputFailed);
                }
                _ => panic!("expected sqz output failed"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
        }

        // --- result store failed: sqz x2 + prov, but store rejects, no inline/stored success
        {
            // small max_item_bytes so encode of result exceeds
            let auth = FakeAuthStore::always_ok();
            let sqz = FakeAgentSqzPort::passthrough();
            let prov = FakeProviderPort::success(success_out.clone());
            let mut store = MemoryResultStore::new(8, 10000, 25, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("sol", "store will fail", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    1013,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 1);
            assert_eq!(sqz.calls.get(), 2);
            assert_eq!(prov.calls.get(), 1);
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::ResultStoreFailed);
                }
                _ => panic!("expected result store failed"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
            // sqz stages present (input and the output one)
            assert!(rec.sqz_stages().input().is_some());
            assert!(rec.sqz_stages().output().is_some());
        }

        // --- success path: sqz x2, tokens, inline exact, sha refs, byte-exact readback, requested/effective
        {
            let auth = FakeAuthStore::always_ok();
            let sqz = FakeAgentSqzPort::passthrough();
            let prov = FakeProviderPort::success(success_out.clone());
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("sol", "success prompt", make_trusted_opts());
            let now = 5000u64;
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    now,
                )
                .unwrap();
            assert_eq!(auth.calls.get(), 1);
            assert_eq!(sqz.calls.get(), 2);
            assert_eq!(prov.calls.get(), 1);
            match rec.outcome() {
                InvocationOutcome::Complete { metrics } => {
                    assert_eq!(metrics.actual_input_tokens(), Some(123));
                    assert_eq!(metrics.actual_output_tokens(), Some(9));
                }
                _ => panic!("expected complete"),
            }
            assert!(rec.sqz_stages().input().is_some());
            assert!(rec.sqz_stages().output().is_some());
            let input_sqz = rec.sqz_stages().input().unwrap();
            assert_eq!(input_sqz.sqz_id.as_ref().unwrap().algorithm, "sha256");
            assert_eq!(
                input_sqz.sqz_id.as_ref().unwrap().value,
                ResultId::sha256(b"success prompt").value()
            );
            let output_sqz = rec.sqz_stages().output().unwrap();
            assert_eq!(output_sqz.sqz_id.as_ref().unwrap().algorithm, "sha256");
            assert_eq!(
                output_sqz.sqz_id.as_ref().unwrap().value,
                ResultId::sha256(success_answer.as_bytes()).value()
            );
            let inline = rec.inline_result().expect("must have inline");
            assert_eq!(inline.answer(), "The answer is 42 with citations.");
            assert_eq!(
                inline.citations(),
                &["src1".to_string(), "doc2".to_string()]
            );
            let sref = rec.stored_result_ref().expect("must have stored ref");
            let expected_result = super::encode_result(&success_answer, &success_citations);
            assert_eq!(
                sref.result_id(),
                &super::super::result_store::ResultId::sha256(&expected_result)
            );
            assert_eq!(sref.artifact_ids().len(), 1);
            assert_eq!(&sref.artifact_ids()[0], success_out.artifacts()[0].id());
            // byte-exact store readback
            let result_back = store.get(sref.result_id(), now).expect("result readback");
            assert_eq!(result_back, expected_result);
            let art_back = store
                .get(&sref.artifact_ids()[0], now)
                .expect("artifact readback");
            assert_eq!(art_back, b"{\"patch\":\"diff\"}");
            // requested/effective evidence
            assert_eq!(rec.requested().profile_name(), "sol");
            assert_eq!(
                rec.requested().provider(),
                &Attestation::Attested("fixture-provider".to_string())
            );
            assert_eq!(
                rec.requested().model(),
                &Attestation::Attested("fixture-sol".to_string())
            );
            match rec.effective().profile() {
                Attestation::Attested(p) => assert_eq!(p.name(), "sol"),
                _ => panic!("expected attested profile"),
            }
            assert_eq!(
                rec.provider_run_id(),
                &Attestation::Attested("prov-run-xyz".to_string())
            );
            assert_eq!(
                rec.effective().provider(),
                &Attestation::Attested("fixture-provider".to_string())
            );
            assert_eq!(
                rec.effective().model(),
                &Attestation::Attested("fixture-sol".to_string())
            );
            assert_eq!(
                rec.effective().reasoning(),
                &Attestation::Attested(ReasoningLevel::High)
            );
            assert!(!rec.no_session());
        }

        // --- output SQZ governs inline content and result storage
        {
            let auth = FakeAuthStore::always_ok();
            let sqz = FakeAgentSqzPort::rewrite_output();
            let prov = FakeProviderPort::success(success_out.clone());
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("sol", "rewrite prompt", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    5001,
                )
                .unwrap();
            let inline = rec.inline_result().unwrap();
            assert_eq!(inline.answer(), "SQZ answer");
            let stored = rec.stored_result_ref().unwrap();
            let expected = super::encode_result("SQZ answer", &success_citations);
            assert_eq!(stored.result_id(), &ResultId::sha256(&expected));
            assert_eq!(store.get(stored.result_id(), 5001).unwrap(), expected);
            assert_eq!(stored.artifact_ids()[0], *success_out.artifacts()[0].id());
        }

        // --- DLP-rejected output never reaches inline content or the result store
        {
            let auth = FakeAuthStore::always_ok();
            let sqz = FakeAgentSqzPort::dlp_output();
            let prov = FakeProviderPort::success(success_out.clone());
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let req = make_request("sol", "dlp prompt", make_trusted_opts());
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    5002,
                )
                .unwrap();
            match rec.outcome() {
                InvocationOutcome::Incomplete { failure, .. } => {
                    assert_eq!(*failure, AgentFailure::SqzOutputFailed);
                }
                _ => panic!("expected SQZ output failure"),
            }
            assert!(rec.inline_result().is_none());
            assert!(rec.stored_result_ref().is_none());
            assert_eq!(store.receipt().entry_count, 0);
        }

        let mut lifecycle = InvocationLifecycle::configured();
        assert!(lifecycle.complete().is_err());
        assert!(lifecycle.advance(InvocationState::PacketReady).is_ok());
        assert!(lifecycle.advance(InvocationState::Running).is_ok());
        assert!(lifecycle.advance(InvocationState::Validating).is_ok());
        assert!(lifecycle.complete().is_ok());
        assert!(lifecycle.incomplete().is_err());

        // --- success with no_session flag: flag set on complete receipt (connected invocation)
        {
            let auth = FakeAuthStore::always_ok();
            let sqz = FakeAgentSqzPort::passthrough();
            let prov = FakeProviderPort::success(success_out.clone());
            let mut store = MemoryResultStore::new(8, 10000, 2000, 10000).unwrap();
            let ports = RuntimePorts::new(&auth, &prov, &sqz, &mut store);
            let mut opts = make_trusted_opts();
            opts.no_session = true;
            let req = make_request("sol", "no session success", opts);
            let rec = rt
                .invoke(
                    &req,
                    AgentRuntimeAuthority::new(false, true, false),
                    &registry,
                    || ports,
                    6000,
                )
                .unwrap();
            assert!(rec.no_session());
            match rec.outcome() {
                InvocationOutcome::Complete { .. } => {}
                _ => panic!("no-session must allow complete success"),
            }
            assert_eq!(sqz.calls.get(), 2);
            assert!(rec.stored_result_ref().is_some());
        }

        // --- ResultStore invariants (straightforward public API): bounded, oldest-first, dedup, ttl, byte exact
        {
            let mut rs = MemoryResultStore::new(2, 1024, 512, 100).unwrap();
            let p1 = rs.put(b"first-bytes", 10).unwrap();
            let _p2 = rs.put(b"second-bytes", 11).unwrap();
            assert_eq!(rs.receipt().entry_count, 2);
            // deduplicating: identical bytes -> same id, no growth
            let p1b = rs.put(b"first-bytes", 12).unwrap();
            assert_eq!(p1.id, p1b.id);
            assert_eq!(rs.receipt().entry_count, 2);
            // deterministic oldest-first eviction on capacity
            let _p3 = rs.put(b"third-bytes", 20).unwrap();
            assert_eq!(rs.receipt().entry_count, 2);
            assert!(rs.get(&p1.id, 20).is_err());
            // ttl-aware eviction on get
            let mut rs2 = MemoryResultStore::new(5, 1024, 512, 5).unwrap();
            let old = rs2.put(b"ttl-old", 0).unwrap().id;
            assert!(rs2.get(&old, 0).is_ok());
            assert!(rs2.get(&old, 10).is_err());
            // byte exact already asserted in success path above
        }
    }
}
