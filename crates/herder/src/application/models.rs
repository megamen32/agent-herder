//! Model catalogs are read from one concrete configured harness instance.
//!
//! A missing provider limit stays unknown. This projection neither fills
//! defaults nor shares cache identity between profiles.

use std::collections::{HashMap, HashSet};

use crate::domain::address::InstanceRef;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: Option<String>,
    /// Provider-reported token limits; `None` means the source did not report it.
    pub context_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCatalog {
    pub instance: InstanceRef,
    pub models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelCatalogError {
    Source(String),
    InstanceMismatch {
        expected: InstanceRef,
        observed: InstanceRef,
    },
    EmptyModelId,
    DuplicateModelId(String),
}

impl std::fmt::Display for ModelCatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Source(message) => write!(f, "model catalog source failed: {message}"),
            Self::InstanceMismatch { .. } => {
                f.write_str("model catalog belongs to a different instance")
            }
            Self::EmptyModelId => f.write_str("model catalog contains an empty model ID"),
            Self::DuplicateModelId(id) => {
                write!(f, "model catalog contains duplicate model ID {id:?}")
            }
        }
    }
}

impl std::error::Error for ModelCatalogError {}

/// The legacy quota reader reports these states; absence of telemetry is not
/// a zero allowance and does not establish an unlimited allowance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuotaState {
    Reported,
    Exhausted,
    Unknown,
}

/// A numeric allowance or unlimited status must be explicitly reported by the
/// source. The legacy state alone does not establish either value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuotaAllowance {
    Unknown,
    Limited(u64),
    Unlimited,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderQuota {
    pub provider: String,
    pub state: QuotaState,
    pub allowance: QuotaAllowance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaSnapshot {
    pub instance: InstanceRef,
    pub providers: Vec<ProviderQuota>,
    /// Milliseconds since the Unix epoch, supplied by the source.
    pub checked_at_ms: u64,
    /// Provider deadline, distinct from the local cache freshness window.
    pub valid_until_ms: Option<u64>,
}

#[allow(async_fn_in_trait)]
pub trait QuotaReader {
    fn instance(&self) -> &InstanceRef;
    async fn read_quota(&self) -> Result<QuotaSnapshot, ModelCatalogError>;
}

/// Caller-owned cache. A failed refresh evicts the old value: an unavailable
/// source must not silently turn a previous observation into current quota.
#[derive(Debug, Default)]
pub struct QuotaCache {
    entries: HashMap<InstanceRef, QuotaSnapshot>,
}

impl QuotaCache {
    pub fn get(
        &self,
        instance: &InstanceRef,
        now_ms: u64,
        max_age_ms: u64,
    ) -> Option<&QuotaSnapshot> {
        self.entries.get(instance).filter(|snapshot| {
            now_ms >= snapshot.checked_at_ms
                && now_ms - snapshot.checked_at_ms <= max_age_ms
                && snapshot
                    .valid_until_ms
                    .is_none_or(|deadline| now_ms < deadline)
        })
    }

    pub async fn refresh<R: QuotaReader>(
        &mut self,
        expected: &InstanceRef,
        reader: &R,
    ) -> Result<&QuotaSnapshot, ModelCatalogError> {
        if reader.instance() != expected {
            self.entries.remove(expected);
            return Err(ModelCatalogError::InstanceMismatch {
                expected: expected.clone(),
                observed: reader.instance().clone(),
            });
        }
        let snapshot = match reader.read_quota().await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.entries.remove(expected);
                return Err(error);
            }
        };
        if snapshot.instance != *expected {
            self.entries.remove(expected);
            return Err(ModelCatalogError::InstanceMismatch {
                expected: expected.clone(),
                observed: snapshot.instance,
            });
        }
        Ok(self
            .entries
            .entry(expected.clone())
            .insert_entry(snapshot)
            .into_mut())
    }
}

/// Native readers are bound to one configured instance and return its raw
/// catalog. The application checks that binding before exposing the result.
#[allow(async_fn_in_trait)]
pub trait ModelCatalogReader {
    fn instance(&self) -> &InstanceRef;
    async fn read_catalog(&self) -> Result<Vec<ModelInfo>, ModelCatalogError>;
}

/// Read and validate a catalog for the exact requested node and instance.
pub async fn read_model_catalog<R: ModelCatalogReader>(
    expected: &InstanceRef,
    reader: &R,
) -> Result<ModelCatalog, ModelCatalogError> {
    let observed = reader.instance();
    if observed != expected {
        return Err(ModelCatalogError::InstanceMismatch {
            expected: expected.clone(),
            observed: observed.clone(),
        });
    }
    let models = reader.read_catalog().await?;
    let mut ids = HashSet::with_capacity(models.len());
    for model in &models {
        if model.id.trim().is_empty() {
            return Err(ModelCatalogError::EmptyModelId);
        }
        if !ids.insert(model.id.as_str()) {
            return Err(ModelCatalogError::DuplicateModelId(model.id.clone()));
        }
    }
    Ok(ModelCatalog {
        instance: observed.clone(),
        models,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::NodeRef;
    use std::cell::Cell;

    struct FixtureReader {
        instance: InstanceRef,
        calls: Cell<usize>,
        models: Vec<ModelInfo>,
    }

    impl ModelCatalogReader for FixtureReader {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }

        async fn read_catalog(&self) -> Result<Vec<ModelInfo>, ModelCatalogError> {
            self.calls.set(self.calls.get() + 1);
            Ok(self.models.clone())
        }
    }

    fn instance(node: &str, profile: &str) -> InstanceRef {
        InstanceRef {
            node: NodeRef(node.into()),
            instance_id: profile.into(),
        }
    }

    struct FixtureQuotaReader {
        instance: InstanceRef,
        result: Result<QuotaSnapshot, ModelCatalogError>,
        calls: Cell<usize>,
    }

    impl QuotaReader for FixtureQuotaReader {
        fn instance(&self) -> &InstanceRef {
            &self.instance
        }
        async fn read_quota(&self) -> Result<QuotaSnapshot, ModelCatalogError> {
            self.calls.set(self.calls.get() + 1);
            self.result.clone()
        }
    }

    fn quota_reader(
        bound: InstanceRef,
        actual: InstanceRef,
        state: QuotaState,
    ) -> FixtureQuotaReader {
        FixtureQuotaReader {
            instance: bound,
            calls: Cell::new(0),
            result: Ok(QuotaSnapshot {
                instance: actual,
                providers: vec![ProviderQuota {
                    provider: "codex".into(),
                    state,
                    allowance: QuotaAllowance::Unknown,
                }],
                checked_at_ms: 100,
                valid_until_ms: Some(200),
            }),
        }
    }

    #[tokio::test]
    async fn quota_cache_is_scoped_to_full_instance_and_unknown_stays_unknown() {
        let a = instance("node-a", "profile-a");
        let b = instance("node-a", "profile-b");
        let c = instance("node-b", "profile-a");
        let mut cache = QuotaCache::default();
        for (target, state, allowance) in [
            (&a, QuotaState::Unknown, QuotaAllowance::Unknown),
            (&b, QuotaState::Exhausted, QuotaAllowance::Limited(0)),
            (&c, QuotaState::Reported, QuotaAllowance::Unlimited),
        ] {
            let mut reader = quota_reader(target.clone(), target.clone(), state);
            reader.result.as_mut().unwrap().providers[0].allowance = allowance;
            cache.refresh(target, &reader).await.unwrap();
        }
        assert_eq!(
            cache.get(&a, 150, 100).unwrap().providers[0].state,
            QuotaState::Unknown
        );
        assert_eq!(
            cache.get(&a, 150, 100).unwrap().providers[0].allowance,
            QuotaAllowance::Unknown
        );
        assert_ne!(QuotaAllowance::Unknown, QuotaAllowance::Limited(0));
        assert_ne!(QuotaAllowance::Unknown, QuotaAllowance::Unlimited);
        assert_eq!(
            cache.get(&b, 150, 100).unwrap().providers[0].allowance,
            QuotaAllowance::Limited(0)
        );
        assert_eq!(
            cache.get(&c, 150, 100).unwrap().providers[0].allowance,
            QuotaAllowance::Unlimited
        );
        assert_eq!(
            cache.get(&b, 150, 100).unwrap().providers[0].state,
            QuotaState::Exhausted
        );
        assert_eq!(
            cache.get(&c, 150, 100).unwrap().providers[0].state,
            QuotaState::Reported
        );
        assert!(cache.get(&a, 99, 100).is_none());
        assert!(cache.get(&a, 151, 50).is_none());
        assert!(cache.get(&a, 200, 1000).is_none());
    }

    #[tokio::test]
    async fn quota_refresh_rejects_foreign_instance_and_unavailable_source() {
        let a = instance("node-a", "profile-a");
        let b = instance("node-b", "profile-a");
        let mut cache = QuotaCache::default();
        cache
            .refresh(
                &a,
                &quota_reader(a.clone(), a.clone(), QuotaState::Reported),
            )
            .await
            .unwrap();
        let foreign = quota_reader(b.clone(), b.clone(), QuotaState::Exhausted);
        assert!(matches!(
            cache.refresh(&a, &foreign).await,
            Err(ModelCatalogError::InstanceMismatch { .. })
        ));
        assert_eq!(foreign.calls.get(), 0);
        let wrong_payload = quota_reader(a.clone(), b, QuotaState::Exhausted);
        assert!(matches!(
            cache.refresh(&a, &wrong_payload).await,
            Err(ModelCatalogError::InstanceMismatch { .. })
        ));
        assert!(cache.get(&a, 150, 100).is_none());
        cache
            .refresh(
                &a,
                &quota_reader(a.clone(), a.clone(), QuotaState::Reported),
            )
            .await
            .unwrap();
        let unavailable = FixtureQuotaReader {
            instance: a.clone(),
            calls: Cell::new(0),
            result: Err(ModelCatalogError::Source("unavailable".into())),
        };
        assert_eq!(
            cache.refresh(&a, &unavailable).await.unwrap_err(),
            ModelCatalogError::Source("unavailable".into())
        );
        assert!(cache.get(&a, 150, 100).is_none());
    }

    #[tokio::test]
    async fn reads_only_the_exact_instance_and_preserves_unknown_limits() {
        let target = instance("node-a", "profile-a");
        let reader = FixtureReader {
            instance: target.clone(),
            calls: Cell::new(0),
            models: vec![ModelInfo {
                id: "provider/model-a".into(),
                display_name: Some("Model A".into()),
                context_tokens: None,
                output_tokens: Some(8192),
            }],
        };
        let catalog = read_model_catalog(&target, &reader).await.unwrap();
        assert_eq!(catalog.instance, target);
        assert_eq!(catalog.models[0].context_tokens, None);
        assert_eq!(catalog.models[0].output_tokens, Some(8192));
        assert_eq!(reader.calls.get(), 1);
    }

    #[tokio::test]
    async fn rejects_a_catalog_from_another_profile_before_reading_it() {
        let requested = instance("node-a", "profile-a");
        let reader = FixtureReader {
            instance: instance("node-b", "profile-a"),
            calls: Cell::new(0),
            models: vec![],
        };
        assert!(matches!(
            read_model_catalog(&requested, &reader).await,
            Err(ModelCatalogError::InstanceMismatch { .. })
        ));
        assert_eq!(reader.calls.get(), 0);
    }

    #[tokio::test]
    async fn rejects_invalid_or_duplicate_native_ids() {
        let target = instance("node-a", "profile-a");
        let model = ModelInfo {
            id: "same".into(),
            display_name: None,
            context_tokens: None,
            output_tokens: None,
        };
        let reader = FixtureReader {
            instance: target.clone(),
            calls: Cell::new(0),
            models: vec![model.clone(), model],
        };
        assert_eq!(
            read_model_catalog(&target, &reader).await.unwrap_err(),
            ModelCatalogError::DuplicateModelId("same".into())
        );
    }
}
