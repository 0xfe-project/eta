//! Humantime duration parsing.

use std::time::Duration;

use eta_core::parse_duration;

#[test]
fn parses_single_units() {
    assert_eq!(parse_duration("5s").unwrap(), Duration::from_secs(5));
    assert_eq!(parse_duration("2m").unwrap(), Duration::from_secs(120));
    assert_eq!(parse_duration("1h").unwrap(), Duration::from_secs(3600));
    assert_eq!(parse_duration("1d").unwrap(), Duration::from_secs(86400));
    assert_eq!(parse_duration("500ms").unwrap(), Duration::from_millis(500));
}

#[test]
fn parses_compound_durations() {
    assert_eq!(parse_duration("1h30m").unwrap(), Duration::from_secs(5400));
    assert_eq!(parse_duration("1h 30m").unwrap(), Duration::from_secs(5400));
    assert_eq!(parse_duration("2h 15m").unwrap(), Duration::from_secs(8100));
}

#[test]
fn parses_long_unit_names() {
    assert_eq!(parse_duration("1 hour").unwrap(), Duration::from_secs(3600));
    assert_eq!(
        parse_duration("30 minutes").unwrap(),
        Duration::from_secs(1800)
    );
}

#[test]
fn rejects_bad_input() {
    assert!(parse_duration("").is_err());
    assert!(parse_duration("5").is_err());
    assert!(parse_duration("5xx").is_err());
    assert!(parse_duration("abc").is_err());
}
