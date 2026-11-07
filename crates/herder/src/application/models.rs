//! Model catalogs are read from one concrete configured harness instance.
//!
//! A missing provider limit stays unknown. This projection neither fills
//! defaults nor shares cache identity between profiles.

use std::collections::HashSet;

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
