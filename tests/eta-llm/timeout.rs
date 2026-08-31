use eta_llm::{Context, Provider, ProviderError};
use eta_llm_test_providers::TimeoutErrorLLMProvider;

#[test]
fn returns_timeout() {
    let provider = TimeoutErrorLLMProvider;
    let result = provider.stream("m", &Context::default(), None);
    assert!(matches!(result, Err(ProviderError::Timeout)));
}
