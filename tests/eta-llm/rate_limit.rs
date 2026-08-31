use eta_llm::{Context, Provider, ProviderError};
use eta_llm_test_providers::RateLimitErrorLLMProvider;

#[test]
fn returns_rate_limit() {
    let provider = RateLimitErrorLLMProvider;
    let result = provider.stream("m", &Context::default(), None);
    assert!(matches!(result, Err(ProviderError::RateLimit)));
}
