use eta_llm::{Context, Provider, ProviderError};
use eta_llm_test_providers::ModelNotFoundErrorLLMProvider;

#[test]
fn returns_model_not_found() {
    let provider = ModelNotFoundErrorLLMProvider;
    let result = provider.stream("gpt-99", &Context::default(), None);
    assert!(matches!(result, Err(ProviderError::ModelNotFound(_))));
}
