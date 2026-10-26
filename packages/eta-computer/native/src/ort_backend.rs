//! ONNX Runtime sessions for the 3 edge models (`ui_detector_embed.onnx`, `ocr_rec.onnx`,
//! `openjev_system1.onnx`), delegated to the `ort` crate, plus the execution-provider chain that
//! decides which accelerator each session runs on.
//!
//! Each model resolves its own provider by committing a session on the first candidate that accepts
//! it, because the three graphs do not share an optimum: perception wants the GPU, the 151M INT8
//! encoder is faster on the CPU. CPU is always the last resort, so a machine without CUDA/cuDNN
//! still loads — it just loads slower.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use ort::environment::Environment;
use ort::ep::{self, ExecutionProviderDispatch};
use ort::inputs;
use ort::session::builder::{GraphOptimizationLevel, SessionBuilder};
use ort::session::Session;
use ort::value::TensorRef;

use crate::bpe::ModernBertBpeTokenizer;

const DETECTOR_SIDE: i64 = 640;

/// Frames an agent loop actually issues: exact batch sizes keep OCR off padding work, and the
/// verdict encoder runs on the unpadded token sequence.
const OCR_MAX_BATCH: usize = 8;
const OCR_HEIGHT: usize = 48;
const OCR_WIDTH: usize = 320;
const OCR_STEPS: usize = 40;
const OCR_CLASSES: usize = 438;
const JEV_SLOTS: usize = 25;

fn to_err(err: impl std::fmt::Display) -> String {
    err.to_string()
}

/// One accelerator the runtime can bind a session to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    Cuda,
    DirectML,
    CoreML,
    Cpu,
}

impl Provider {
    pub const fn label(self) -> &'static str {
        match self {
            Provider::Cuda => "cuda",
            Provider::DirectML => "directml",
            Provider::CoreML => "coreml",
            Provider::Cpu => "cpu",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "cuda" | "nvidia" => Some(Provider::Cuda),
            "directml" | "dml" => Some(Provider::DirectML),
            "coreml" | "ane" => Some(Provider::CoreML),
            "cpu" => Some(Provider::Cpu),
            _ => None,
        }
    }

    fn dispatch(self, device_id: i32) -> Option<ExecutionProviderDispatch> {
        match self {
            Provider::Cuda => cuda_dispatch(device_id),
            Provider::DirectML => directml_dispatch(device_id),
            Provider::CoreML => coreml_dispatch(),
            Provider::Cpu => Some(ep::CPU::default().build()),
        }
    }
}

// The feature sets below mirror the per-target `ort` dependency table in `Cargo.toml`; that is
// what decides which accelerator-specific ONNX Runtime build `ort-sys` links against.
#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn cuda_dispatch(device_id: i32) -> Option<ExecutionProviderDispatch> {
    Some(
        ep::CUDA::default()
            .with_device_id(device_id)
            // Exhaustive cuDNN autotuning spends seconds on the detector's first frame.
            .with_conv_algorithm_search(ep::cuda::ConvAlgorithmSearch::Heuristic)
            .build(),
    )
}

#[cfg(not(any(target_os = "windows", all(unix, not(target_os = "macos")))))]
fn cuda_dispatch(_device_id: i32) -> Option<ExecutionProviderDispatch> {
    None
}

#[cfg(target_os = "windows")]
fn directml_dispatch(device_id: i32) -> Option<ExecutionProviderDispatch> {
    Some(ep::DirectML::default().with_device_id(device_id).build())
}

#[cfg(not(target_os = "windows"))]
fn directml_dispatch(_device_id: i32) -> Option<ExecutionProviderDispatch> {
    None
}

#[cfg(target_os = "macos")]
fn coreml_dispatch() -> Option<ExecutionProviderDispatch> {
    Some(ep::CoreML::default().build())
}

#[cfg(not(target_os = "macos"))]
fn coreml_dispatch() -> Option<ExecutionProviderDispatch> {
    None
}

/// Preference chain, most-preferred accelerator first. `ETA_COMPUTER_PROVIDER` overrides it with a
/// comma-separated list (e.g. `directml,cpu`); `cpu` is appended when the list omits it, so a
/// session can always fall back.
fn provider_chain(override_spec: Option<&str>) -> Vec<Provider> {
    let configured = override_spec
        .map(|s| s.to_string())
        .or_else(|| std::env::var("ETA_COMPUTER_PROVIDER").ok());
    let mut chain: Vec<Provider> = Vec::new();
    match configured.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(spec) => {
            for name in spec.split(',') {
                if name.trim().is_empty() {
                    continue;
                }
                match Provider::parse(name) {
                    Some(provider) => chain.push(provider),
                    None => eprintln!("[eta-computer] ignoring unknown ETA_COMPUTER_PROVIDER entry `{name}`"),
                }
            }
        }
        None => {
            if cfg!(target_os = "windows") {
                chain.push(Provider::Cuda);
                chain.push(Provider::DirectML);
            } else if cfg!(target_os = "macos") {
                chain.push(Provider::CoreML);
            } else {
                chain.push(Provider::Cuda);
            }
        }
    }
    if !chain.contains(&Provider::Cpu) {
        chain.push(Provider::Cpu);
    }
    chain
}

/// The verdict encoder's own preference chain.
///
/// Measured on an RTX 3080, the 48-token INT8 encoder takes ~23 ms on CUDA versus ~15 ms on the
/// CPU: at this size every kernel launch and quantize/dequantize pair costs more than the GEMMs
/// save. So when perception lands on an accelerator, the encoder is pinned to the CPU unless
/// `ETA_COMPUTER_ENCODER_PROVIDER` says otherwise (an explicit provider request also wins, since
/// the caller asked for it).
fn encoder_chain(
    requested: Option<&str>,
    perception: &[Provider],
    detector_provider: Provider,
) -> Vec<Provider> {
    let configured = std::env::var("ETA_COMPUTER_ENCODER_PROVIDER").ok();
    let spec = configured
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| requested.map(str::trim).filter(|s| !s.is_empty()));
    if let Some(spec) = spec {
        return provider_chain(Some(spec));
    }
    if detector_provider == Provider::Cpu {
        return perception.to_vec();
    }
    vec![Provider::Cpu]
}

fn device_id() -> i32 {
    std::env::var("ETA_COMPUTER_DEVICE_ID")
        .ok()
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(0)
}

/// ONNX Runtime allows a single environment per process, while the engine may be created more
/// than once (one per test/consumer), so the environment is process-global.
fn environment() -> Result<Environment, String> {
    static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        ort::init()
            .with_name("eta_computer")
            .with_telemetry(false)
            .build()
            .map_err(|e| format!("ort environment init failed: {e}"))
    })
    .clone()
}

/// `1.22.0`-style runtime version, read from the loaded ONNX Runtime rather than from the crate so
/// a developer-supplied runtime is reported truthfully.
fn runtime_version() -> String {
    unsafe {
        let base = ort::sys::OrtGetApiBase();
        if base.is_null() {
            return "unknown".to_string();
        }
        let ptr = ((*base).GetVersionString)();
        if ptr.is_null() {
            return "unknown".to_string();
        }
        std::ffi::CStr::from_ptr(ptr)
            .to_string_lossy()
            .into_owned()
    }
}

/// ORT intra-op threads. Swept on the i7-13700K used for the current measurements (24 logical
/// cores): the encoder lands at 18.7 ms with 6 threads, 17.3 ms with 8 and 15.8 ms with 12, and OCR
/// at batch 8 goes 50 ms -> 38 ms -> 31 ms, so the default is half the logical cores. The cap keeps
/// a many-core box from oversubscribing; `ETA_COMPUTER_THREADS` overrides it either way, which
/// matters because the previous benchmark machine (Intel 285H) fell off a cliff above 6 threads.
fn cpu_threads() -> usize {
    std::env::var("ETA_COMPUTER_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or_else(|| {
            let cores = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(8);
            (cores / 2).clamp(2, 12)
        })
}

fn build_session(
    env: &Environment,
    model_path: &str,
    providers: &[ExecutionProviderDispatch],
    threads: usize,
) -> Result<Session, String> {
    let builder: SessionBuilder = Session::builder(env).map_err(to_err)?;
    builder
        .with_optimization_level(GraphOptimizationLevel::All)
        .map_err(to_err)?
        .with_intra_threads(threads)
        .map_err(to_err)?
        .with_execution_providers(providers)
        .map_err(to_err)?
        .commit_from_file(model_path)
        .map_err(to_err)
}

/// Commits one model onto the first provider in `chain` that accepts it. A rejected provider is
/// reported and the next one is tried, ending at CPU — so a machine without a working accelerator
/// still loads, just slower.
fn commit_with_chain(
    env: &Environment,
    model_path: &str,
    chain: &[Provider],
    device: i32,
    threads: usize,
) -> Result<(Provider, Session, Vec<String>), String> {
    let mut attempts: Vec<String> = Vec::new();
    for candidate in chain.iter().copied().filter(|p| *p != Provider::Cpu) {
        let Some(dispatch) = candidate.dispatch(device) else {
            attempts.push(format!("{}(not compiled in)", candidate.label()));
            continue;
        };
        let providers = [dispatch.error_on_failure(), cpu_dispatch()];
        match build_session(env, model_path, &providers, threads) {
            Ok(session) => return Ok((candidate, session, attempts)),
            Err(err) => {
                eprintln!(
                    "[eta-computer] execution provider `{}` unavailable, falling back: {err}",
                    candidate.label()
                );
                attempts.push(format!("{}: {err}", candidate.label()));
            }
        }
    }
    let session = build_session(env, model_path, &[cpu_dispatch()], threads)?;
    Ok((Provider::Cpu, session, attempts))
}

/// Pre-bound zero-allocation session bundle for the 3 edge models.
pub struct EdgeModelTriad {
    pub version: String,
    /// Provider the detector (and thus the per-frame perception path) actually runs on.
    pub provider: Provider,
    /// Provider the OCR head ended up on.
    pub ocr_provider: Provider,
    /// Provider the 151M verdict encoder ended up on. Kept separate from `provider` because the
    /// INT8 encoder is *slower* on CUDA than on CPU (see `DESIGN.md`), so it is deliberately pinned
    /// to the CPU unless the caller asks otherwise.
    pub encoder_provider: Provider,
    /// Preference chain that was attempted, with the probe failure inlined per rejected provider.
    pub provider_chain: Vec<String>,
    pub is_real_pretrained: bool,
    pub bpe: Option<ModernBertBpeTokenizer>,
    pub ocr_vocab: Vec<String>,
    #[allow(dead_code)]
    env: Environment,

    // Model 1: ui_detector_embed.onnx
    // Real OmniParser (11.73 MB): `images [1, 3, 640, 640] -> output0 [1, 5, 8400], neck_embed [1, 64, 80, 80]`
    sess_detector: Session,
    pub det_input_atlas: Vec<f32>, // [1, 3, 640, 640]
    pub det_out_boxes: Vec<f32>,   // [1, 5, 8400]
    pub det_out_neck_embed: Vec<f32>, // [1, 64, 80, 80]

    // Model 2: ocr_rec.onnx
    // Real PaddleOCR (7.47 MB): `x [B, 3, 48, 320] -> fetch_name_0 [B, 40, 438]`
    sess_ocr: Session,
    pub ocr_input_crops: Vec<f32>, // [8, 3, 48, 320]
    pub ocr_out_logits: Vec<f32>,  // [8, 40, 438]

    // Model 3: openjev_system1.onnx
    // Real OpenJev Verdict 151.4M (289.71 MB FP32 / 145.65 MB INT8):
    // `input_ids [1, L], attention_mask [1, L] -> logits [1, 25]`
    sess_jev: Session,
    pub jev_out_logits25: [f32; JEV_SLOTS],
    /// Decisions already made for an identical prompt, keyed by the token sequence's hash.
    /// A GUI loop re-plans the same state many times (retries, re-renders); reusing the
    /// verdict is what keeps a warm step off the 151M encoder entirely.
    jev_cache: HashMap<u64, [f32; JEV_SLOTS]>,
}

impl EdgeModelTriad {
    pub fn load(models_dir: &str, provider_spec: Option<&str>) -> Result<Self, String> {
        let dir = models_dir.trim_end_matches(['/', '\\']);
        let env = environment()?;
        let threads = cpu_threads();
        let device = device_id();

        let is_real_pretrained = Path::new(dir).join("bpe_vocab.tsv").exists();
        let bpe = if is_real_pretrained {
            Some(ModernBertBpeTokenizer::load(dir)?)
        } else {
            None
        };

        let mut ocr_vocab = vec!["blank".to_string()];
        if let Ok(raw_dict) = fs::read_to_string(Path::new(dir).join("ocr_dict.txt")) {
            for line in raw_dict.lines() {
                ocr_vocab.push(line.trim_end_matches('\r').to_string());
            }
            ocr_vocab.push(" ".to_string());
        }

        let model_path = |name: &str| -> String {
            Path::new(dir)
                .join(name)
                .to_string_lossy()
                .into_owned()
        };

        // Probe each model on the perception chain: committing a session is what actually loads the
        // provider library, so a missing CUDA/cuDNN surfaces here instead of on the first frame.
        let perception_chain = provider_chain(provider_spec);
        let (provider, sess_detector, detector_attempts) = commit_with_chain(
            &env,
            &model_path("ui_detector_embed.onnx"),
            &perception_chain,
            device,
            threads,
        )?;
        let (ocr_provider, sess_ocr, _) = commit_with_chain(
            &env,
            &model_path("ocr_rec.onnx"),
            &perception_chain,
            device,
            threads,
        )?;

        // The verdict encoder gets its own chain: a GPU machine keeps perception on the accelerator
        // but leaves this graph on the CPU, where a 48-token INT8 forward beats the kernel-launch
        // overhead of running it on the device.
        let encoder_chain = encoder_chain(provider_spec, &perception_chain, provider);
        let (encoder_provider, sess_jev, _) = commit_with_chain(
            &env,
            &model_path("openjev_system1.onnx"),
            &encoder_chain,
            device,
            threads,
        )?;

        let mut triad = Self {
            version: runtime_version(),
            provider,
            ocr_provider,
            encoder_provider,
            provider_chain: {
                let mut names: Vec<String> = perception_chain
                    .iter()
                    .map(|p| p.label().to_string())
                    .collect();
                names.extend(detector_attempts);
                names
            },
            is_real_pretrained,
            bpe,
            ocr_vocab,
            env,
            sess_detector,
            det_input_atlas: vec![0.0f32; (DETECTOR_SIDE * DETECTOR_SIDE * 3) as usize],
            det_out_boxes: vec![0.0f32; 5 * 8400],
            det_out_neck_embed: vec![0.0f32; 64 * 80 * 80],
            sess_ocr,
            ocr_input_crops: vec![0.0f32; OCR_MAX_BATCH * 3 * OCR_HEIGHT * OCR_WIDTH],
            ocr_out_logits: vec![0.0f32; OCR_MAX_BATCH * OCR_STEPS * OCR_CLASSES],
            sess_jev,
            jev_out_logits25: [0.0f32; JEV_SLOTS],
            jev_cache: HashMap::new(),
        };

        // Warm up all 3 models. ORT allocates arenas and spins up intra-op threads on the first
        // run, and a new input shape costs an extra planning pass, so every batch size the OCR head
        // accepts and a couple of encoder sequence lengths are exercised up front — otherwise the
        // first real frame pays roughly double.
        for batch in 1..=OCR_MAX_BATCH {
            triad.run_ocr_batch(batch)?;
        }
        triad.run_detector()?;
        triad.run_real_jev(&(1..=32i64).collect::<Vec<_>>())?;
        triad.run_detector()?;
        triad.run_real_jev(&(1..=64i64).collect::<Vec<_>>())?;

        Ok(triad)
    }

    pub fn run_detector(&mut self) -> Result<f64, String> {
        let t0 = Instant::now();
        let input = TensorRef::from_array_view((
            [1i64, 3, DETECTOR_SIDE, DETECTOR_SIDE],
            &self.det_input_atlas[..],
        ))
        .map_err(to_err)?;
        let outputs = self
            .sess_detector
            .run(inputs!["images" => input])
            .map_err(to_err)?;
        let (_, boxes) = outputs["output0"]
            .try_extract_tensor::<f32>()
            .map_err(to_err)?;
        self.det_out_boxes.copy_from_slice(boxes);
        let (_, neck) = outputs["neck_embed"]
            .try_extract_tensor::<f32>()
            .map_err(to_err)?;
        self.det_out_neck_embed.copy_from_slice(neck);
        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }

    /// Run real PaddleOCR recognition on exact dynamic batch size `batch_count` (1..=8).
    pub fn run_ocr_batch(&mut self, batch_count: usize) -> Result<f64, String> {
        let b = batch_count.clamp(1, OCR_MAX_BATCH);
        let in_len = b * 3 * OCR_HEIGHT * OCR_WIDTH;
        let out_len = b * OCR_STEPS * OCR_CLASSES;
        let t0 = Instant::now();
        let input = TensorRef::from_array_view((
            [b as i64, 3, OCR_HEIGHT as i64, OCR_WIDTH as i64],
            &self.ocr_input_crops[..in_len],
        ))
        .map_err(to_err)?;
        let outputs = self
            .sess_ocr
            .run(inputs!["x" => input])
            .map_err(to_err)?;
        let (_, logits) = outputs["fetch_name_0"]
            .try_extract_tensor::<f32>()
            .map_err(to_err)?;
        if logits.len() != out_len {
            return Err(format!(
                "ocr_rec.onnx returned {} logits, expected {out_len} for batch {b}",
                logits.len()
            ));
        }
        self.ocr_out_logits[..out_len].copy_from_slice(logits);
        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }

    /// Drops memoized verdicts. Only the benchmark needs this: it forces the encoder to actually
    /// run for a sequence it has already seen.
    pub fn clear_jev_cache(&mut self) {
        self.jev_cache.clear();
    }

    /// Run real 151.4M parameter OpenJev Verdict (`heman10x/rlcd-modernbert-151m`)
    /// on the exact token sequence `input_ids` without wasteful padding.
    pub fn run_real_jev(&mut self, input_ids: &[i64]) -> Result<f64, String> {
        let key = {
            let mut h: u64 = 0xcbf29ce484222325;
            for &id in input_ids {
                h ^= id as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            h
        };
        if let Some(cached) = self.jev_cache.get(&key) {
            self.jev_out_logits25 = *cached;
            return Ok(0.0);
        }

        let seq_len = input_ids.len().max(1);
        let mask = vec![1i64; seq_len];
        let t0 = Instant::now();
        let shape = [1i64, seq_len as i64];
        let ids = TensorRef::from_array_view((shape, input_ids)).map_err(to_err)?;
        let mask = TensorRef::from_array_view((shape, &mask[..])).map_err(to_err)?;
        let outputs = self
            .sess_jev
            .run(inputs!["input_ids" => ids, "attention_mask" => mask])
            .map_err(to_err)?;
        let (_, logits) = outputs["logits"].try_extract_tensor::<f32>().map_err(to_err)?;
        let slots = logits.len().min(JEV_SLOTS);
        self.jev_out_logits25[..slots].copy_from_slice(&logits[..slots]);
        for slot in &mut self.jev_out_logits25[slots..] {
            *slot = 0.0;
        }

        if self.jev_cache.len() >= 512 {
            self.jev_cache.clear();
        }
        self.jev_cache.insert(key, self.jev_out_logits25);
        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }
}

fn cpu_dispatch() -> ExecutionProviderDispatch {
    ep::CPU::default().build()
}

unsafe impl Send for EdgeModelTriad {}
