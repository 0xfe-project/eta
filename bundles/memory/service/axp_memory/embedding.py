"""The embedding model, computed on the CPU.

``python -m axp_memory.embedding`` downloads it into FASTEMBED_CACHE_PATH; the
build does this once, so the service never reaches the network for it.
"""

# Mixed Chinese and English, long inputs (prompts are queries), 768 dims.
# Changing it means re-embedding every memory.
MODEL = "jinaai/jina-embeddings-v2-base-zh"
DIMS = 768

if __name__ == "__main__":
    from fastembed import TextEmbedding

    TextEmbedding(model_name=MODEL)
