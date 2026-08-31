use eta_llm::{Context, Provider, ProviderError};
use eta_llm_test_providers::UnavailableErrorLLMProvider;

#[test]
fn returns_unavailable() {
    let provider = UnavailableErrorLLMProvider;
    let result = provider.stream("m", &Context::default(), None);
    assert!(matches!(result, Err(ProviderError::Unavailable)));
}
