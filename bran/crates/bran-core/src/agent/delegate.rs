//! Immutable delegation request contract.

use super::{ReasoningLevel, ToolPolicy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DelegationRequestError {
    _p: (),
}

/// Immutable value object bundling delegation configuration.
/// Provides safe constructor and defaults for overrides, tool policy,
/// flags, max output, and depth.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationOptions {
    pub provider_override: Option<String>,
    pub model_override: Option<String>,
    pub reasoning_override: Option<ReasoningLevel>,
    pub tool_policy: ToolPolicy,
    pub no_session: bool,
    pub max_output_bytes: usize,
    pub delegation_depth: usize,
}

impl Default for DelegationOptions {
    fn default() -> Self {
        Self {
            provider_override: None,
            model_override: None,
            reasoning_override: None,
            tool_policy: ToolPolicy::read_only_default(),
            no_session: false,
            max_output_bytes: 65_536,
            delegation_depth: 0,
        }
    }
}

impl DelegationOptions {
    /// Safe constructor using secure defaults:
    /// - no overrides
    /// - ToolPolicy::read_only_default()
    /// - flags all false
    /// - max_output_bytes: 65536 (within 1..=1048576)
    /// - delegation_depth: 0
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationRequest {
    profile: String,
    prompt: String,
    provider_override: Option<String>,
    model_override: Option<String>,
    reasoning_override: Option<ReasoningLevel>,
    tool_policy: ToolPolicy,
    no_session: bool,
    max_output_bytes: usize,
    delegation_depth: usize,
}

impl DelegationRequest {
    pub fn new(
        profile: impl Into<String>,
        prompt: impl Into<String>,
        options: DelegationOptions,
    ) -> Result<Self, DelegationRequestError> {
        let profile = profile.into();
        if !is_valid_identity(&profile) {
            return Err(DelegationRequestError { _p: () });
        }

        let prompt = prompt.into();
        if prompt.trim().is_empty() || prompt.len() > 65536 {
            return Err(DelegationRequestError { _p: () });
        }

        let provider_override = options.provider_override;
        if let Some(ref v) = provider_override {
            if !is_valid_identity(v) {
                return Err(DelegationRequestError { _p: () });
            }
        }

        let model_override = options.model_override;
        if let Some(ref v) = model_override {
            if !is_valid_identity(v) {
                return Err(DelegationRequestError { _p: () });
            }
        }

        let tool_policy = options.tool_policy;
        let no_session = options.no_session;
        let max_output_bytes = options.max_output_bytes;
        let delegation_depth = options.delegation_depth;
        let reasoning_override = options.reasoning_override;

        if !(1..=1_048_576).contains(&max_output_bytes) {
            return Err(DelegationRequestError { _p: () });
        }

        if delegation_depth > 8 {
            return Err(DelegationRequestError { _p: () });
        }

        Ok(Self {
            profile,
            prompt,
            provider_override,
            model_override,
            reasoning_override,
            tool_policy,
            no_session,
            max_output_bytes,
            delegation_depth,
        })
    }

    pub fn profile(&self) -> &str {
        &self.profile
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
    }

    pub fn provider_override(&self) -> Option<&str> {
        self.provider_override.as_deref()
    }

    pub fn model_override(&self) -> Option<&str> {
        self.model_override.as_deref()
    }

    pub fn reasoning_override(&self) -> Option<ReasoningLevel> {
        self.reasoning_override
    }

    pub fn tool_policy(&self) -> &ToolPolicy {
        &self.tool_policy
    }

    pub fn no_session(&self) -> bool {
        self.no_session
    }

    pub fn max_output_bytes(&self) -> usize {
        self.max_output_bytes
    }

    pub fn delegation_depth(&self) -> usize {
        self.delegation_depth
    }
}

fn is_valid_identity(s: &str) -> bool {
    let bytes = s.as_bytes();
    let len = bytes.len();
    (1..=64).contains(&len)
        && bytes
            .iter()
            .all(|&b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}
