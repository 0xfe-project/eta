use eta_llm::{Context, Model, Provider, ProviderError};
use eta_llm_test_providers::ModelNotFoundErrorLLMProvider;
use tokio_stream::StreamExt;

#[tokio::test]
async fn returns_model_not_found() {
    let provider = ModelNotFoundErrorLLMProvider;
    let stream = provider.stream(&Model::new("gpt-99"), &Context::default(), None);
    let items: Vec<_> = stream.collect().await;
    assert_eq!(items.len(), 1);
    assert!(matches!(&items[0], Err(ProviderError::ModelNotFound(_))));
}
