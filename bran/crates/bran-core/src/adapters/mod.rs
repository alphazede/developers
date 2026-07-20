//! Provider-neutral boundaries for runtime integrations.

pub mod sqz;

#[allow(unused_imports)]
pub use sqz::{
    DlpStatus, FidelityStatus, SqzAdapter, SqzAdapterConfig, SqzError, SqzEvaluation,
    SqzFailureReason, SqzId, SqzIdentity, SqzPolicy, SqzPort, SqzPortError, SqzPortErrorCode,
    SqzPortOutput, SqzReceipt, SqzStatus, APPROVED_SQZ_SHA256, APPROVED_SQZ_SOURCE,
    APPROVED_SQZ_VERSION,
};
