//! Humantime duration parsing (for cron intervals).

use std::time::Duration;

/// An error parsing a human-friendly duration.
#[derive(Debug, PartialEq, thiserror::Error)]
pub enum DurationParseError {
    #[error("value was empty")]
    Empty,
    #[error("expected a number")]
    NumberExpected,
    #[error("time unit needed after {0}")]
    UnitNeeded(u64),
    #[error("unknown time unit {unit:?}")]
    UnknownUnit { unit: String },
    #[error("number too large")]
    Overflow,
}

/// Nanoseconds per unit.
fn unit_nanos(unit: &str) -> Option<u64> {
    Some(match unit {
        "ns" | "nsec" | "nanos" => 1,
        "us" | "usec" | "µs" => 1_000,
        "ms" | "msec" | "millis" => 1_000_000,
        "s" | "sec" | "secs" | "second" | "seconds" => 1_000_000_000,
        "m" | "min" | "mins" | "minute" | "minutes" => 60 * 1_000_000_000,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600 * 1_000_000_000,
        "d" | "day" | "days" => 86_400 * 1_000_000_000,
        "w" | "week" | "weeks" | "wk" | "wks" => 7 * 86_400 * 1_000_000_000,
        "M" | "month" | "months" => 2_630_016 * 1_000_000_000, // 30.44 days
        "y" | "year" | "years" | "yr" | "yrs" => 31_557_600 * 1_000_000_000, // 365.25 days
        _ => return None,
    })
}

/// Parse a human-friendly duration like `1hour 12min 5s` or `1h30m`.
pub fn parse_duration(s: &str) -> Result<Duration, DurationParseError> {
    let mut iter = s.chars().peekable();
    let mut total = Duration::ZERO;
    let mut any = false;

    loop {
        // Skip leading whitespace.
        while iter.peek().is_some_and(|c| c.is_whitespace()) {
            iter.next();
        }
        let Some(&first) = iter.peek() else {
            break;
        };
        if !first.is_ascii_digit() {
            return Err(DurationParseError::NumberExpected);
        }
        any = true;

        // Integer part.
        let mut n: u64 = 0;
        while let Some(&c) = iter.peek() {
            if c.is_ascii_digit() {
                n = n
                    .checked_mul(10)
                    .and_then(|x| x.checked_add((c as u8 - b'0') as u64))
                    .ok_or(DurationParseError::Overflow)?;
                iter.next();
            } else {
                break;
            }
        }

        // Skip whitespace between the number and its unit.
        while iter.peek().is_some_and(|c| c.is_whitespace()) {
            iter.next();
        }

        // Unit part (alphabetic or µ).
        let mut unit = String::new();
        while let Some(&c) = iter.peek() {
            if c.is_alphabetic() || c == 'µ' {
                unit.push(c);
                iter.next();
            } else {
                break;
            }
        }

        if unit.is_empty() {
            // A bare `0` contributes nothing (humantime allows it).
            if n == 0 {
                continue;
            }
            return Err(DurationParseError::UnitNeeded(n));
        }

        let nanos = unit_nanos(&unit)
            .ok_or_else(|| DurationParseError::UnknownUnit { unit: unit.clone() })?;
        let add = n.checked_mul(nanos).ok_or(DurationParseError::Overflow)?;
        total = total
            .checked_add(Duration::from_nanos(add))
            .ok_or(DurationParseError::Overflow)?;
    }

    if !any {
        return Err(DurationParseError::Empty);
    }
    Ok(total)
}
