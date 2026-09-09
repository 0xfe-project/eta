//! `Usage::cache_rate` — cache accounting.

use eta_llm::Usage;

#[test]
fn cache_rate() {
    let u = Usage {
        input: 50,
        output: 100,
        cache_read: 50,
        cache_write: 0,
    };
    assert_eq!(u.cache_rate(), 0.5);

    let no_input = Usage {
        input: 0,
        output: 100,
        cache_read: 0,
        cache_write: 0,
    };
    assert_eq!(no_input.cache_rate(), 0.0);

    let all_cache = Usage {
        input: 0,
        output: 0,
        cache_read: 100,
        cache_write: 0,
    };
    assert_eq!(all_cache.cache_rate(), 1.0);
}
