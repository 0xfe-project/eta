//! Zero-copy ONNX Runtime C-API binding with pre-allocated I/O tensor buffers
//! for the 3 edge models (`ui_detector_embed.onnx`, `ocr_rec.onnx`, `openjev_system1.onnx`).

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fs;
use std::path::Path;
use std::ptr;
use std::time::Instant;

use crate::bpe::ModernBertBpeTokenizer;

#[cfg(unix)]
extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlerror() -> *const c_char;
}

#[repr(C)]
struct OrtApiBase {
    get_api: extern "C" fn(version: u32) -> *const *const c_void,
    get_version_string: extern "C" fn() -> *const c_char,
}

type FnGetErrorMessage = extern "C" fn(status: *const c_void) -> *const c_char;
type FnCreateEnv = extern "C" fn(log_level: c_int, logid: *const c_char, out: *mut *mut c_void) -> *mut c_void;
type FnCreateSession = extern "C" fn(
    env: *const c_void,
    model_path: *const c_char,
    opts: *const c_void,
    out: *mut *mut c_void,
) -> *mut c_void;
type FnRun = extern "C" fn(
    sess: *mut c_void,
    run_opts: *const c_void,
    input_names: *const *const c_char,
    inputs: *const *const c_void,
    input_len: usize,
    output_names: *const *const c_char,
    output_names_len: usize,
    outputs: *mut *mut c_void,
) -> *mut c_void;
type FnCreateSessionOptions = extern "C" fn(out: *mut *mut c_void) -> *mut c_void;
type FnSetIntraOpNumThreads = extern "C" fn(opts: *mut c_void, threads: c_int) -> *mut c_void;
type FnSetSessionGraphOptimizationLevel = extern "C" fn(opts: *mut c_void, level: c_int) -> *mut c_void;
type FnCreateTensorWithDataAsOrtValue = extern "C" fn(
    info: *const c_void,
    p_data: *mut c_void,
    p_data_len: usize,
    shape: *const i64,
    shape_len: usize,
    elem_type: c_int,
    out: *mut *mut c_void,
) -> *mut c_void;
type FnCreateCpuMemoryInfo =
    extern "C" fn(alloc_type: c_int, mem_type: c_int, out: *mut *mut c_void) -> *mut c_void;
type FnReleaseEnv = extern "C" fn(ptr: *mut c_void);
type FnReleaseStatus = extern "C" fn(ptr: *mut c_void);
type FnReleaseMemoryInfo = extern "C" fn(ptr: *mut c_void);
type FnReleaseSession = extern "C" fn(ptr: *mut c_void);
type FnReleaseValue = extern "C" fn(ptr: *mut c_void);
type FnReleaseSessionOptions = extern "C" fn(ptr: *mut c_void);

const ONNX_TENSOR_FLOAT: c_int = 1;
const ONNX_TENSOR_INT64: c_int = 7;

pub struct OrtFunctions {
    pub version: String,
    get_error_message: FnGetErrorMessage,
    create_env: FnCreateEnv,
    create_session: FnCreateSession,
    run: FnRun,
    create_session_options: FnCreateSessionOptions,
    set_intra_op_num_threads: FnSetIntraOpNumThreads,
    set_graph_opt_level: FnSetSessionGraphOptimizationLevel,
    create_tensor: FnCreateTensorWithDataAsOrtValue,
    create_cpu_mem_info: FnCreateCpuMemoryInfo,
    release_env: FnReleaseEnv,
    release_status: FnReleaseStatus,
    release_mem_info: FnReleaseMemoryInfo,
    release_session: FnReleaseSession,
    release_value: FnReleaseValue,
    release_session_options: FnReleaseSessionOptions,
}

impl OrtFunctions {
    pub unsafe fn load(lib_path: &str) -> Result<Self, String> {
        let c_path = CString::new(lib_path).map_err(|e| e.to_string())?;
        // RTLD_NOW | RTLD_LOCAL = 2
        let handle = dlopen(c_path.as_ptr(), 2);
        if handle.is_null() {
            let err = dlerror();
            let msg = if err.is_null() {
                "unknown dlopen error".to_string()
            } else {
                CStr::from_ptr(err).to_string_lossy().into_owned()
            };
            return Err(format!("dlopen({}) failed: {}", lib_path, msg));
        }
        let sym_name = CString::new("OrtGetApiBase").unwrap();
        let sym = dlsym(handle, sym_name.as_ptr());
        if sym.is_null() {
            return Err("OrtGetApiBase symbol not found".to_string());
        }
        let get_base: extern "C" fn() -> *const OrtApiBase = std::mem::transmute(sym);
        let base_ptr = get_base();
        if base_ptr.is_null() {
            return Err("OrtGetApiBase returned null".to_string());
        }
        let base = &*base_ptr;
        let ver_ptr = (base.get_version_string)();
        let version = if ver_ptr.is_null() {
            "unknown".to_string()
        } else {
            CStr::from_ptr(ver_ptr).to_string_lossy().into_owned()
        };
        let vtable = (base.get_api)(17);
        if vtable.is_null() {
            return Err("GetApi(17) returned null".to_string());
        }

        macro_rules! slot {
            ($idx:expr, $ty:ty) => {
                std::mem::transmute::<*const c_void, $ty>(*vtable.add($idx))
            };
        }

        Ok(Self {
            version,
            get_error_message: slot!(2, FnGetErrorMessage),
            create_env: slot!(3, FnCreateEnv),
            create_session: slot!(7, FnCreateSession),
            run: slot!(9, FnRun),
            create_session_options: slot!(10, FnCreateSessionOptions),
            set_graph_opt_level: slot!(23, FnSetSessionGraphOptimizationLevel),
            set_intra_op_num_threads: slot!(24, FnSetIntraOpNumThreads),
            create_tensor: slot!(49, FnCreateTensorWithDataAsOrtValue),
            create_cpu_mem_info: slot!(69, FnCreateCpuMemoryInfo),
            release_env: slot!(92, FnReleaseEnv),
            release_status: slot!(93, FnReleaseStatus),
            release_mem_info: slot!(94, FnReleaseMemoryInfo),
            release_session: slot!(95, FnReleaseSession),
            release_value: slot!(96, FnReleaseValue),
            release_session_options: slot!(100, FnReleaseSessionOptions),
        })
    }

    unsafe fn check(&self, status: *mut c_void) -> Result<(), String> {
        if status.is_null() {
            return Ok(());
        }
        let msg_ptr = (self.get_error_message)(status);
        let msg = if msg_ptr.is_null() {
            "ORT error".to_string()
        } else {
            CStr::from_ptr(msg_ptr).to_string_lossy().into_owned()
        };
        (self.release_status)(status);
        Err(msg)
    }
}

/// Pre-bound zero-allocation session bundle for the 3 edge models.
pub struct EdgeModelTriad {
    pub api: OrtFunctions,
    pub is_real_pretrained: bool,
    pub bpe: Option<ModernBertBpeTokenizer>,
    pub ocr_vocab: Vec<String>,
    env: *mut c_void,
    mem_info: *mut c_void,

    // Model 1: ui_detector_embed.onnx
    // Real OmniParser (11.73 MB): `images [1, 3, 640, 640] -> output0 [1, 5, 8400], neck_embed [1, 64, 80, 80]`
    sess_detector: *mut c_void,
    pub det_input_atlas: Vec<f32>,      // [1, 3, 640, 640]
    pub det_out_boxes: Vec<f32>,        // [1, 5, 8400] (real) or [1, 1600, 20] (synthetic)
    pub det_out_neck_embed: Vec<f32>,   // [1, 64, 80, 80]
    det_in_val: *mut c_void,
    det_out_vals: [*mut c_void; 2],
    det_in_name: CString,
    det_out_names: [CString; 2],

    // Model 2: ocr_rec.onnx
    // Real PaddleOCR (7.47 MB): `x [B, 3, 48, 320] -> fetch_name_0 [B, 40, 438]`
    sess_ocr: *mut c_void,
    pub ocr_input_crops: Vec<f32>,      // [8, 3, 48, 320]
    pub ocr_out_logits: Vec<f32>,       // [8, 40, 438]
    ocr_in_name: CString,
    ocr_out_name: CString,

    // Model 3: openjev_system1.onnx
    // Real OpenJev Verdict 151.4M (289.71 MB): `input_ids [1, L], attention_mask [1, L] -> logits [1, 25]`
    sess_jev: *mut c_void,
    pub jev_out_logits25: [f32; 25],
    jev_in_names: [CString; 2],
    jev_out_name: CString,
    /// Decisions already made for an identical prompt, keyed by the token sequence's hash.
    /// A GUI loop re-plans the same state many times (retries, re-renders); reusing the
    /// verdict is what keeps a warm step off the 151M encoder entirely.
    jev_cache: std::collections::HashMap<u64, [f32; 25]>,
}

unsafe impl Send for EdgeModelTriad {}

impl EdgeModelTriad {
    pub fn load(ort_lib_path: &str, models_dir: &str) -> Result<Self, String> {
        unsafe {
            let api = OrtFunctions::load(ort_lib_path)?;
            let dir_trimmed = models_dir.trim_end_matches('/');
            let is_real_pretrained = Path::new(&format!("{}/bpe_vocab.tsv", dir_trimmed)).exists();

            let bpe = if is_real_pretrained {
                Some(ModernBertBpeTokenizer::load(dir_trimmed)?)
            } else {
                None
            };

            let mut ocr_vocab = vec!["blank".to_string()];
            let dict_path = format!("{}/ocr_dict.txt", dir_trimmed);
            if let Ok(raw_dict) = fs::read_to_string(&dict_path) {
                for line in raw_dict.lines() {
                    ocr_vocab.push(line.trim_end_matches('\r').to_string());
                }
                ocr_vocab.push(" ".to_string());
            }

            let mut env: *mut c_void = ptr::null_mut();
            let log_id = CString::new("eta_computer").unwrap();
            api.check((api.create_env)(3, log_id.as_ptr(), &mut env))?;

    // Detector: four ORT threads measured fastest inside a Bun process on this class of
    // machine (4 -> 24.6ms, 6 -> 19.8ms detector but 39.9ms encoder, 8 -> 70ms, 16 -> 236ms),
    // so the default follows cores/4 rather than cores/2.
    let threads = std::env::var("ETA_COMPUTER_THREADS")
        .ok()
        .and_then(|v| v.parse::<c_int>().ok())
        .unwrap_or_else(|| {
            let cores = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(8);
            (cores / 4).clamp(2, 6) as c_int
        });

            let mut opts: *mut c_void = ptr::null_mut();
            api.check((api.create_session_options)(&mut opts))?;
            api.check((api.set_graph_opt_level)(opts, 99))?;
            api.check((api.set_intra_op_num_threads)(opts, threads))?;

            let mut mem_info: *mut c_void = ptr::null_mut();
            api.check((api.create_cpu_mem_info)(1, 0, &mut mem_info))?;

            let load_sess = |filename: &str| -> Result<*mut c_void, String> {
                let p = format!("{}/{}", dir_trimmed, filename);
                let cp = CString::new(p).map_err(|e| e.to_string())?;
                let mut s: *mut c_void = ptr::null_mut();
                api.check((api.create_session)(env, cp.as_ptr(), opts, &mut s))?;
                Ok(s)
            };

            let sess_detector = load_sess("ui_detector_embed.onnx")?;
            let sess_ocr = load_sess("ocr_rec.onnx")?;
            let sess_jev = load_sess("openjev_system1.onnx")?;
            (api.release_session_options)(opts);

            let bind_f32 = |buf: &mut [f32], shape: &[i64]| -> Result<*mut c_void, String> {
                let mut val: *mut c_void = ptr::null_mut();
                api.check((api.create_tensor)(
                    mem_info,
                    buf.as_mut_ptr() as *mut c_void,
                    buf.len() * std::mem::size_of::<f32>(),
                    shape.as_ptr(),
                    shape.len(),
                    ONNX_TENSOR_FLOAT,
                    &mut val,
                ))?;
                Ok(val)
            };

            let mut det_input_atlas = vec![0.0f32; 1 * 3 * 640 * 640];
            let mut det_out_boxes = vec![0.0f32; 1 * 5 * 8400];
            let mut det_out_neck_embed = vec![0.0f32; 1 * 64 * 80 * 80];
            let det_in_val = bind_f32(&mut det_input_atlas, &[1, 3, 640, 640])?;
            let det_out_vals = [
                bind_f32(&mut det_out_boxes, &[1, 5, 8400])?,
                bind_f32(&mut det_out_neck_embed, &[1, 64, 80, 80])?,
            ];

            let ocr_input_crops = vec![0.0f32; 8 * 3 * 48 * 320];
            let ocr_out_logits = vec![0.0f32; 8 * 40 * 438];

            let mut triad = Self {
                api,
                is_real_pretrained,
                bpe,
                ocr_vocab,
                env,
                mem_info,
                sess_detector,
                det_input_atlas,
                det_out_boxes,
                det_out_neck_embed,
                det_in_val,
                det_out_vals,
                det_in_name: CString::new("images").unwrap(),
                det_out_names: [
                    CString::new("output0").unwrap(),
                    CString::new("neck_embed").unwrap(),
                ],
                sess_ocr,
                ocr_input_crops,
                ocr_out_logits,
                ocr_in_name: CString::new("x").unwrap(),
                ocr_out_name: CString::new("fetch_name_0").unwrap(),
                sess_jev,
                jev_out_logits25: [0.0f32; 25],
                jev_in_names: [
                    CString::new("input_ids").unwrap(),
                    CString::new("attention_mask").unwrap(),
                ],
                jev_out_name: CString::new("logits").unwrap(),
                jev_cache: std::collections::HashMap::new(),
            };

            // Warm-up all 3 real models at startup to eliminate first-frame compilation jitter
            triad.run_detector()?;
            triad.run_ocr_batch(1)?;
            triad.run_real_jev(&[50281, 50368, 8982, 50369, 2548, 50282])?;

            Ok(triad)
        }
    }

    pub fn run_detector(&mut self) -> Result<f64, String> {
        let t0 = Instant::now();
        unsafe {
            let in_names = [self.det_in_name.as_ptr()];
            let in_vals = [self.det_in_val as *const c_void];
            let out_names = [
                self.det_out_names[0].as_ptr(),
                self.det_out_names[1].as_ptr(),
            ];
            self.api.check((self.api.run)(
                self.sess_detector,
                ptr::null(),
                in_names.as_ptr(),
                in_vals.as_ptr(),
                1,
                out_names.as_ptr(),
                2,
                self.det_out_vals.as_mut_ptr(),
            ))?;
        }
        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }

    /// Run real PaddleOCR recognition on exact dynamic batch size `batch_count` (1..=8).
    pub fn run_ocr_batch(&mut self, batch_count: usize) -> Result<f64, String> {
        let b = batch_count.clamp(1, 8);
        let t0 = Instant::now();
        unsafe {
            let in_shape = [b as i64, 3, 48, 320];
            let out_shape = [b as i64, 40, 438];
            let mut in_val: *mut c_void = ptr::null_mut();
            let mut out_val: *mut c_void = ptr::null_mut();

            self.api.check((self.api.create_tensor)(
                self.mem_info,
                self.ocr_input_crops.as_mut_ptr() as *mut c_void,
                b * 3 * 48 * 320 * std::mem::size_of::<f32>(),
                in_shape.as_ptr(),
                4,
                ONNX_TENSOR_FLOAT,
                &mut in_val,
            ))?;

            let res = (|| -> Result<(), String> {
                self.api.check((self.api.create_tensor)(
                    self.mem_info,
                    self.ocr_out_logits.as_mut_ptr() as *mut c_void,
                    b * 40 * 438 * std::mem::size_of::<f32>(),
                    out_shape.as_ptr(),
                    3,
                    ONNX_TENSOR_FLOAT,
                    &mut out_val,
                ))?;

                let in_names = [self.ocr_in_name.as_ptr()];
                let in_vals = [in_val as *const c_void];
                let out_names = [self.ocr_out_name.as_ptr()];
                let mut out_vals = [out_val];
                self.api.check((self.api.run)(
                    self.sess_ocr,
                    ptr::null(),
                    in_names.as_ptr(),
                    in_vals.as_ptr(),
                    1,
                    out_names.as_ptr(),
                    1,
                    out_vals.as_mut_ptr(),
                ))
            })();

            if !out_val.is_null() {
                (self.api.release_value)(out_val);
            }
            if !in_val.is_null() {
                (self.api.release_value)(in_val);
            }
            res?;
        }
        Ok(t0.elapsed().as_secs_f64() * 1000.0)
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
        let mut ids_buf = input_ids.to_vec();
        let mut mask_buf = vec![1i64; seq_len];
        let t0 = Instant::now();

        unsafe {
            let in_shape = [1i64, seq_len as i64];
            let out_shape = [1i64, 25i64];
            let mut id_val: *mut c_void = ptr::null_mut();
            let mut mask_val: *mut c_void = ptr::null_mut();
            let mut out_val: *mut c_void = ptr::null_mut();

            self.api.check((self.api.create_tensor)(
                self.mem_info,
                ids_buf.as_mut_ptr() as *mut c_void,
                seq_len * std::mem::size_of::<i64>(),
                in_shape.as_ptr(),
                2,
                ONNX_TENSOR_INT64,
                &mut id_val,
            ))?;

            let res = (|| -> Result<(), String> {
                self.api.check((self.api.create_tensor)(
                    self.mem_info,
                    mask_buf.as_mut_ptr() as *mut c_void,
                    seq_len * std::mem::size_of::<i64>(),
                    in_shape.as_ptr(),
                    2,
                    ONNX_TENSOR_INT64,
                    &mut mask_val,
                ))?;

                self.api.check((self.api.create_tensor)(
                    self.mem_info,
                    self.jev_out_logits25.as_mut_ptr() as *mut c_void,
                    25 * std::mem::size_of::<f32>(),
                    out_shape.as_ptr(),
                    2,
                    ONNX_TENSOR_FLOAT,
                    &mut out_val,
                ))?;

                let in_names = [self.jev_in_names[0].as_ptr(), self.jev_in_names[1].as_ptr()];
                let in_vals = [id_val as *const c_void, mask_val as *const c_void];
                let out_names = [self.jev_out_name.as_ptr()];
                let mut out_vals = [out_val];
                self.api.check((self.api.run)(
                    self.sess_jev,
                    ptr::null(),
                    in_names.as_ptr(),
                    in_vals.as_ptr(),
                    2,
                    out_names.as_ptr(),
                    1,
                    out_vals.as_mut_ptr(),
                ))
            })();

            if !out_val.is_null() {
                (self.api.release_value)(out_val);
            }
            if !mask_val.is_null() {
                (self.api.release_value)(mask_val);
            }
            if !id_val.is_null() {
                (self.api.release_value)(id_val);
            }
            res?;
        }
        if self.jev_cache.len() >= 512 {
            self.jev_cache.clear();
        }
        self.jev_cache.insert(key, self.jev_out_logits25);
        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }
}

impl Drop for EdgeModelTriad {
    fn drop(&mut self) {
        (self.api.release_value)(self.det_in_val);
        for v in self.det_out_vals {
            (self.api.release_value)(v);
        }
        (self.api.release_session)(self.sess_detector);
        (self.api.release_session)(self.sess_ocr);
        (self.api.release_session)(self.sess_jev);
        (self.api.release_mem_info)(self.mem_info);
        (self.api.release_env)(self.env);
    }
}
