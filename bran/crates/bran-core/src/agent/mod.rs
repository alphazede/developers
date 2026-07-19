//! Provider-neutral connected-agent contracts.

pub mod coordinator;
pub mod delegate;
pub mod receipt;
pub mod result_store;
pub mod runtime;
pub mod synthetic;

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReasoningLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReasoningLevelError {
    _p: (),
}

impl ReasoningLevel {
    pub fn parse(s: &str) -> Result<Self, ReasoningLevelError> {
        match s {
            "off" => Ok(Self::Off),
            "minimal" => Ok(Self::Minimal),
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "xhigh" => Ok(Self::Xhigh),
            _ => Err(ReasoningLevelError { _p: () }),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match *self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }
}

impl std::fmt::Display for ReasoningLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPolicy {
    allow: BTreeSet<String>,
    deny: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPolicyError {
    TooMany,
    InvalidName,
    Duplicate,
    Conflict,
}

fn is_valid_tool_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let len = bytes.len();
    (1..=32).contains(&len)
        && bytes
            .iter()
            .all(|&b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
}

impl ToolPolicy {
    pub fn new(
        allow: impl IntoIterator<Item = impl AsRef<str>>,
        deny: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Result<Self, ToolPolicyError> {
        let mut allow_set = BTreeSet::<String>::new();
        for item in allow {
            let name = item.as_ref();
            if !is_valid_tool_name(name) {
                return Err(ToolPolicyError::InvalidName);
            }
            if !allow_set.insert(name.to_string()) {
                return Err(ToolPolicyError::Duplicate);
            }
            if allow_set.len() > 32 {
                return Err(ToolPolicyError::TooMany);
            }
        }
        let mut deny_set = BTreeSet::<String>::new();
        for item in deny {
            let name = item.as_ref();
            if !is_valid_tool_name(name) {
                return Err(ToolPolicyError::InvalidName);
            }
            if !deny_set.insert(name.to_string()) {
                return Err(ToolPolicyError::Duplicate);
            }
            if deny_set.len() > 32 {
                return Err(ToolPolicyError::TooMany);
            }
        }
        for name in &allow_set {
            if deny_set.contains(name) {
                return Err(ToolPolicyError::Conflict);
            }
        }
        Ok(Self {
            allow: allow_set,
            deny: deny_set,
        })
    }

    pub fn read_only_default() -> Self {
        Self::new(["read", "search"], ["write", "edit", "shell", "network"]).unwrap()
    }

    pub fn allows(&self, name: &str) -> bool {
        self.allow.contains(name) && !self.deny.contains(name)
    }

    pub fn allowed(&self) -> impl ExactSizeIterator<Item = &str> {
        self.allow.iter().map(String::as_str)
    }

    pub fn denied(&self) -> impl ExactSizeIterator<Item = &str> {
        self.deny.iter().map(String::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfile {
    name: String,
    provider: String,
    model: String,
    account_handle: String,
    default_reasoning_level: ReasoningLevel,
    tool_policy: ToolPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentProfileError {
    InvalidIdentity,
}

fn is_valid_identity(s: &str) -> bool {
    let bytes = s.as_bytes();
    let len = bytes.len();
    (1..=64).contains(&len)
        && bytes
            .iter()
            .all(|&b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

impl AgentProfile {
    pub fn new(
        name: impl Into<String>,
        provider: impl Into<String>,
        model: impl Into<String>,
        account_handle: impl Into<String>,
        default_reasoning_level: ReasoningLevel,
        tool_policy: ToolPolicy,
    ) -> Result<Self, AgentProfileError> {
        let name = name.into();
        let provider = provider.into();
        let model = model.into();
        let account_handle = account_handle.into();
        if !is_valid_identity(&name)
            || !is_valid_identity(&provider)
            || !is_valid_identity(&model)
            || !is_valid_identity(&account_handle)
        {
            return Err(AgentProfileError::InvalidIdentity);
        }
        Ok(Self {
            name,
            provider,
            model,
            account_handle,
            default_reasoning_level,
            tool_policy,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn account_handle(&self) -> &str {
        &self.account_handle
    }

    pub fn default_reasoning_level(&self) -> ReasoningLevel {
        self.default_reasoning_level
    }

    pub fn tool_policy(&self) -> &ToolPolicy {
        &self.tool_policy
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryError {
    InvalidIdentity,
    DuplicateProvider,
    DuplicateModel,
    UnknownProvider,
    UnknownModel,
    DuplicateProfile,
    UnknownProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProviderRegistry {
    providers: BTreeSet<String>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, identity: impl Into<String>) -> Result<(), RegistryError> {
        let id = identity.into();
        if !is_valid_identity(&id) {
            return Err(RegistryError::InvalidIdentity);
        }
        if !self.providers.insert(id) {
            return Err(RegistryError::DuplicateProvider);
        }
        Ok(())
    }

    pub fn contains(&self, identity: &str) -> bool {
        self.providers.contains(identity)
    }

    pub fn require(&self, identity: &str) -> Result<(), RegistryError> {
        if self.contains(identity) {
            Ok(())
        } else {
            Err(RegistryError::UnknownProvider)
        }
    }

    pub fn names(&self) -> Vec<&str> {
        self.providers.iter().map(|s| s.as_str()).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModelRegistry {
    models: BTreeMap<String, BTreeSet<String>>,
}

impl ModelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &mut self,
        provider: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<(), RegistryError> {
        let provider = provider.into();
        let model = model.into();
        if !is_valid_identity(&provider) || !is_valid_identity(&model) {
            return Err(RegistryError::InvalidIdentity);
        }
        if !self.models.entry(provider).or_default().insert(model) {
            return Err(RegistryError::DuplicateModel);
        }
        Ok(())
    }

    pub fn contains(&self, model: &str) -> bool {
        self.models.values().any(|models| models.contains(model))
    }

    pub fn contains_for_provider(&self, provider: &str, model: &str) -> bool {
        self.models
            .get(provider)
            .is_some_and(|models| models.contains(model))
    }

    pub fn require_for_provider(&self, provider: &str, model: &str) -> Result<(), RegistryError> {
        if self.contains_for_provider(provider, model) {
            Ok(())
        } else {
            Err(RegistryError::UnknownModel)
        }
    }

    pub fn names(&self) -> Vec<&str> {
        self.models
            .values()
            .flat_map(|models| models.iter().map(String::as_str))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfileRegistry {
    provider_registry: ProviderRegistry,
    model_registry: ModelRegistry,
    profiles: BTreeMap<String, AgentProfile>,
}

impl AgentProfileRegistry {
    pub fn new(provider_registry: ProviderRegistry, model_registry: ModelRegistry) -> Self {
        Self {
            provider_registry,
            model_registry,
            profiles: BTreeMap::new(),
        }
    }

    pub fn register(&mut self, profile: AgentProfile) -> Result<(), RegistryError> {
        self.provider_registry.require(profile.provider())?;
        self.model_registry
            .require_for_provider(profile.provider(), profile.model())?;
        if self.profiles.contains_key(profile.name()) {
            return Err(RegistryError::DuplicateProfile);
        }
        self.profiles.insert(profile.name().to_string(), profile);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Result<&AgentProfile, RegistryError> {
        self.profiles.get(name).ok_or(RegistryError::UnknownProfile)
    }

    pub fn profiles(&self) -> Vec<&AgentProfile> {
        self.profiles.values().collect()
    }

    pub fn provider_registry(&self) -> &ProviderRegistry {
        &self.provider_registry
    }

    pub fn model_registry(&self) -> &ModelRegistry {
        &self.model_registry
    }
}

pub fn synthetic_builtin_profiles() -> AgentProfileRegistry {
    let mut pr = ProviderRegistry::new();
    pr.register("fixture-provider").expect("");
    let mut mr = ModelRegistry::new();
    mr.register("fixture-provider", "fixture-sol").expect("");
    mr.register("fixture-provider", "fixture-luna").expect("");
    let mut apr = AgentProfileRegistry::new(pr, mr);
    let sol = AgentProfile::new(
        "sol",
        "fixture-provider",
        "fixture-sol",
        "sol-default",
        ReasoningLevel::High,
        ToolPolicy::read_only_default(),
    )
    .expect("");
    apr.register(sol).expect("");
    let luna = AgentProfile::new(
        "luna",
        "fixture-provider",
        "fixture-luna",
        "luna-default",
        ReasoningLevel::Low,
        ToolPolicy::read_only_default(),
    )
    .expect("");
    apr.register(luna).expect("");
    apr
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p3_agent_profile_contract() {
        // ReasoningLevel: all six exact lowercase parses + canonical strings, plus invalid uppercase/unknown
        assert_eq!(ReasoningLevel::parse("off").unwrap(), ReasoningLevel::Off);
        assert_eq!(ReasoningLevel::parse("off").unwrap().as_str(), "off");
        assert_eq!(
            ReasoningLevel::parse("minimal").unwrap(),
            ReasoningLevel::Minimal
        );
        assert_eq!(
            ReasoningLevel::parse("minimal").unwrap().as_str(),
            "minimal"
        );
        assert_eq!(ReasoningLevel::parse("low").unwrap(), ReasoningLevel::Low);
        assert_eq!(ReasoningLevel::parse("low").unwrap().as_str(), "low");
        assert_eq!(
            ReasoningLevel::parse("medium").unwrap(),
            ReasoningLevel::Medium
        );
        assert_eq!(ReasoningLevel::parse("medium").unwrap().as_str(), "medium");
        assert_eq!(ReasoningLevel::parse("high").unwrap(), ReasoningLevel::High);
        assert_eq!(ReasoningLevel::parse("high").unwrap().as_str(), "high");
        assert_eq!(
            ReasoningLevel::parse("xhigh").unwrap(),
            ReasoningLevel::Xhigh
        );
        assert_eq!(ReasoningLevel::parse("xhigh").unwrap().as_str(), "xhigh");
        assert_eq!(
            ReasoningLevel::parse("High"),
            Err(ReasoningLevelError { _p: () })
        );
        assert_eq!(
            ReasoningLevel::parse("foo"),
            Err(ReasoningLevelError { _p: () })
        );

        // ToolPolicy read-only default allows read/search, rejects write/edit/shell/network
        let ro = ToolPolicy::read_only_default();
        assert!(ro.allows("read"));
        assert!(ro.allows("search"));
        assert!(!ro.allows("write"));
        assert!(!ro.allows("edit"));
        assert!(!ro.allows("shell"));
        assert!(!ro.allows("network"));
        assert_eq!(ro.allowed().collect::<Vec<_>>(), vec!["read", "search"]);
        assert_eq!(
            ro.denied().collect::<Vec<_>>(),
            vec!["edit", "network", "shell", "write"]
        );

        let connected = synthetic::connected_receipt();
        let connected_json = connected.to_json();
        let unattested = synthetic::connected_unattested_receipt();
        assert_eq!(connected.outcome(), unattested.outcome());
        assert!(matches!(
            unattested.effective().profile(),
            runtime::Attestation::Unavailable
        ));
        assert!(connected.no_session());
        assert!(connected_json.contains("\"schema_version\":\"bran-agent-receipt-v1\""));
        assert!(connected_json.contains("\"fidelity_status\":\"passed\""));
        assert!(connected_json.contains("\"dlp_status\":\"passed\""));
        assert!(connected_json.contains("\"provider_run_id\":{\"state\":\"attested\""));
        assert!(!connected_json.contains("synthetic connected request"));
        let luna_request = delegate::DelegationRequest::new(
            "luna",
            "synthetic luna request",
            delegate::DelegationOptions {
                no_session: true,
                provider_override: Some("fixture-provider".to_string()),
                model_override: Some("fixture-sol".to_string()),
                reasoning_override: Some(ReasoningLevel::Medium),
                ..delegate::DelegationOptions::new()
            },
        )
        .unwrap();
        let luna = synthetic::connected_receipt_for(&luna_request, true);
        assert!(luna.no_session());
        assert!(matches!(
            luna.effective().profile(),
            runtime::Attestation::Attested(profile) if profile.name() == "luna"
        ));
        assert!(matches!(
            luna.effective().model(),
            runtime::Attestation::Attested(model) if model == "fixture-sol"
        ));

        // invalid name, duplicate, and conflict
        assert_eq!(
            ToolPolicy::new(vec!["Read"] as Vec<&str>, vec![] as Vec<&str>),
            Err(ToolPolicyError::InvalidName)
        );
        assert_eq!(
            ToolPolicy::new(vec!["a", "a"] as Vec<&str>, vec![] as Vec<&str>),
            Err(ToolPolicyError::Duplicate)
        );
        assert_eq!(
            ToolPolicy::new(vec!["a"] as Vec<&str>, vec!["a"] as Vec<&str>),
            Err(ToolPolicyError::Conflict)
        );

        // synthetic_builtin_profiles: deterministic names luna then sol
        let apr = synthetic_builtin_profiles();
        let ps = apr.profiles();
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[0].name(), "luna");
        assert_eq!(ps[1].name(), "sol");

        // exact provider/model/account/default reasoning + read/search allowed, mutation denied
        let luna_p = apr.get("luna").unwrap();
        assert_eq!(luna_p.provider(), "fixture-provider");
        assert_eq!(luna_p.model(), "fixture-luna");
        assert_eq!(luna_p.account_handle(), "luna-default");
        assert_eq!(luna_p.default_reasoning_level(), ReasoningLevel::Low);
        let lp = luna_p.tool_policy();
        assert!(lp.allows("read"));
        assert!(lp.allows("search"));
        assert!(!lp.allows("write"));
        assert!(!lp.allows("edit"));
        assert!(!lp.allows("shell"));
        assert!(!lp.allows("network"));

        let sol_p = apr.get("sol").unwrap();
        assert_eq!(sol_p.provider(), "fixture-provider");
        assert_eq!(sol_p.model(), "fixture-sol");
        assert_eq!(sol_p.account_handle(), "sol-default");
        assert_eq!(sol_p.default_reasoning_level(), ReasoningLevel::High);
        let sp = sol_p.tool_policy();
        assert!(sp.allows("read"));
        assert!(sp.allows("search"));
        assert!(!sp.allows("write"));
        assert!(!sp.allows("edit"));
        assert!(!sp.allows("shell"));
        assert!(!sp.allows("network"));

        // ProviderRegistry rejects invalid and duplicate, returns typed unknown
        let mut pr = ProviderRegistry::new();
        assert_eq!(pr.register("bad name"), Err(RegistryError::InvalidIdentity));
        pr.register("good-p").unwrap();
        assert_eq!(pr.register("good-p"), Err(RegistryError::DuplicateProvider));
        assert_eq!(pr.require("nope"), Err(RegistryError::UnknownProvider));

        // ModelRegistry rejects invalid and duplicate pairs, returns typed unknown
        let mut mr = ModelRegistry::new();
        assert_eq!(
            mr.register("good-p", "bad@name"),
            Err(RegistryError::InvalidIdentity)
        );
        mr.register("good-p", "good-m").unwrap();
        assert_eq!(
            mr.register("good-p", "good-m"),
            Err(RegistryError::DuplicateModel)
        );
        assert_eq!(
            mr.require_for_provider("good-p", "nope"),
            Err(RegistryError::UnknownModel)
        );

        // AgentProfileRegistry rejects unknown provider, unknown model, duplicate profile, unknown lookup (no silent fallback)
        let mut pr1 = ProviderRegistry::new();
        pr1.register("prov-x").unwrap();
        let mut mr1 = ModelRegistry::new();
        mr1.register("prov-x", "mod-y").unwrap();
        let mut apr1 = AgentProfileRegistry::new(pr1, mr1);
        let bad_prov_p = AgentProfile::new(
            "p1",
            "unknown-prov",
            "mod-y",
            "a",
            ReasoningLevel::Off,
            ToolPolicy::read_only_default(),
        )
        .unwrap();
        assert_eq!(
            apr1.register(bad_prov_p),
            Err(RegistryError::UnknownProvider)
        );

        let mut pr2 = ProviderRegistry::new();
        pr2.register("prov-x").unwrap();
        let mut mr2 = ModelRegistry::new();
        mr2.register("prov-x", "mod-y").unwrap();
        let mut apr2 = AgentProfileRegistry::new(pr2, mr2);
        let bad_mod_p = AgentProfile::new(
            "p2",
            "prov-x",
            "unknown-mod",
            "a",
            ReasoningLevel::Off,
            ToolPolicy::read_only_default(),
        )
        .unwrap();
        assert_eq!(apr2.register(bad_mod_p), Err(RegistryError::UnknownModel));

        let mut pr3 = ProviderRegistry::new();
        pr3.register("prov-x").unwrap();
        let mut mr3 = ModelRegistry::new();
        mr3.register("prov-x", "mod-y").unwrap();
        let mut apr3 = AgentProfileRegistry::new(pr3, mr3);
        let dup1 = AgentProfile::new(
            "dup-p",
            "prov-x",
            "mod-y",
            "a1",
            ReasoningLevel::Off,
            ToolPolicy::read_only_default(),
        )
        .unwrap();
        apr3.register(dup1).unwrap();
        let dup2 = AgentProfile::new(
            "dup-p",
            "prov-x",
            "mod-y",
            "a2",
            ReasoningLevel::High,
            ToolPolicy::read_only_default(),
        )
        .unwrap();
        assert_eq!(apr3.register(dup2), Err(RegistryError::DuplicateProfile));

        let mut pr4 = ProviderRegistry::new();
        pr4.register("prov-x").unwrap();
        let mut mr4 = ModelRegistry::new();
        mr4.register("prov-x", "mod-y").unwrap();
        let mut apr4 = AgentProfileRegistry::new(pr4, mr4);
        let okp = AgentProfile::new(
            "ok-p",
            "prov-x",
            "mod-y",
            "a",
            ReasoningLevel::Low,
            ToolPolicy::read_only_default(),
        )
        .unwrap();
        apr4.register(okp).unwrap();
        assert_eq!(apr4.get("no-such"), Err(RegistryError::UnknownProfile));

        let mut pr5 = ProviderRegistry::new();
        pr5.register("prov-x").unwrap();
        pr5.register("prov-z").unwrap();
        let mut mr5 = ModelRegistry::new();
        mr5.register("prov-z", "mod-y").unwrap();
        let mut apr5 = AgentProfileRegistry::new(pr5, mr5);
        let mismatched_pair = AgentProfile::new(
            "p5",
            "prov-x",
            "mod-y",
            "a",
            ReasoningLevel::Low,
            ToolPolicy::read_only_default(),
        )
        .unwrap();
        assert_eq!(
            apr5.register(mismatched_pair),
            Err(RegistryError::UnknownModel)
        );
    }
}
