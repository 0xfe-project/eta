use eta_llm::{Context, Provider, ProviderError};
use eta_llm_test_providers::AuthenticationErrorLLMProvider;

#[test]
fn returns_authentication_error() {
    let provider = AuthenticationErrorLLMProvider;
    let result = provider.stream("m", &Context::default(), None);
    assert!(matches!(result, Err(ProviderError::Authentication(_))));
}
