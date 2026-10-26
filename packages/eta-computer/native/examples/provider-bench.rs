//! Per-model latency per execution provider, straight through the Rust API.
//!
//! The JS-level benchmark (`bun run bench`) measures whole agent steps; this one isolates the three
//! graphs so the provider policy in `src/ort_backend.rs` can be checked against numbers rather than
//! guessed. Build and run it against the same ONNX Runtime the cdylib uses:
//!
//!   cargo run --release --example provider-bench
//!
//! `ETA_COMPUTER_PROVIDER` / `ETA_COMPUTER_ENCODER_PROVIDER` and `ETA_COMPUTER_MODELS_DIR` apply as
//! usual, so `ETA_COMPUTER_PROVIDER=cuda ETA_COMPUTER_ENCODER_PROVIDER=cuda cargo run ...` measures
//! the encoder on the GPU too.

use std::time::Instant;

use eta_computer::ort_backend::EdgeModelTriad;

fn quantify(mut samples: Vec<f64>) -> (f64, f64) {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = samples[samples.len() / 2];
    let p95 = samples[(samples.len() - 1) * 95 / 100];
    (median, p95)
}

fn report_variant(mut run: impl FnMut() -> Result<f64, String>) {
    let mut samples = Vec::with_capacity(21);
    for _ in 0..21 {
        match run() {
            Ok(ms) => samples.push(ms),
            Err(err) => {
                println!("    error: {err}");
                return;
            }
        }
    }
    let (median, p95) = quantify(samples);
    print!("{median:8.2} ms  (p95 {p95:6.2})");
}

fn main() -> Result<(), String> {
    let models_dir = std::env::var("ETA_COMPUTER_MODELS_DIR").unwrap_or_else(|_| {
        let mut path = std::env::current_dir().expect("cwd");
        path.push("models");
        path.to_string_lossy().into_owned()
    });

    let load_started = Instant::now();
    let mut triad = EdgeModelTriad::load(&models_dir, None)?;
    println!(
        "onnxruntime {} | detector {} | ocr {} | encoder {} | load {:.0} ms",
        triad.version,
        triad.provider.label(),
        triad.ocr_provider.label(),
        triad.encoder_provider.label(),
        load_started.elapsed().as_secs_f64() * 1000.0
    );

    print!("  detector [1,3,640,640]   ");
    report_variant(|| triad.run_detector());
    println!();

    for batch in [1usize, 2, 4, 8] {
        print!("  ocr      [{batch},3,48,320]   ");
        report_variant(|| triad.run_ocr_batch(batch));
        println!();
    }

    for len in [32usize, 48, 64] {
        // Distinct ids per length keep the verdict cache from answering for the encoder.
        let ids: Vec<i64> = (1..=len as i64).map(|id| id + len as i64).collect();
        print!("  encoder  [1,{len}]         ");
        report_variant(|| {
            triad.clear_jev_cache();
            triad.run_real_jev(&ids)
        });
        println!();
    }

    Ok(())
}
