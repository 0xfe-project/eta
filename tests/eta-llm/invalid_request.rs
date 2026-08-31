use eta_llm::{Context, Provider, ProviderError};
use eta_llm_test_providers::InvalidRequestErrorLLMProvider;

#[test]
fn returns_invalid_request() {
    let provider = InvalidRequestErrorLLMProvider;
    let result = provider.stream("m", &Context::default(), None);
    assert!(matches!(result, Err(ProviderError::InvalidRequest(_))));
}
