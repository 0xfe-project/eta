use eta_llm::{Context, Model, Provider, ProviderError};
use eta_llm_test_providers::TimeoutErrorLLMProvider;
use tokio_stream::StreamExt;

#[tokio::test]
async fn returns_timeout() {
    let provider = TimeoutErrorLLMProvider;
    let stream = provider.stream(&Model::new("m"), &Context::default(), None);
    let items: Vec<_> = stream.collect().await;
    assert_eq!(items.len(), 1);
    assert!(matches!(&items[0], Err(ProviderError::Timeout)));
}
