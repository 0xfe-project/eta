//! Pure-Vision Desktop Grounding Engine powered by `onnxruntime-genai` (`Oga*` C-ABI)
//! and the slimmed/quantized `WeVisOne-VL-2B` (INT8 DeepStack ViT + INT4 GatherBlockQuantized
//! Embedding + INT4 28-Layer Decoder with 1,012-token pruned `lm_head`).
//!
//! Key acceleration mechanisms for pure CPU / NPU execution:
//!   1. **Adaptive Resolution & ROI Cropping**: Bilinearly resizes the screen or dirty/candidate ROI
//!      onto a compact `224x128` (28 visual tokens) or `256x160` (40 visual tokens) grid, then packs
//!      `[num_patches, 1536]` in Qwen3-VL block-major order (`< 0.4ms` in native Rust).
//!   2. **Visual Prefix KV-Cache Reuse (`OgaGenerator_RewindTo`)**: When the screen (or cropped ROI)
//!      hash is unchanged (`fnv1a_rgb`), the `OgaGenerator` rewinds its KV cache back to the end of
//!      the `<|vision_start|>...<|vision_end|>` prefix (`prefix_token_count`), skipping the entire
//!      24-layer ViT + visual token prefill on subsequent queries (`~195ms` per query on CPU).
//!   3. **Prefix-Forced Structured Decoding**: Appends `<ref>{query}</ref><point>` or
//!      `<ref>{query}</ref><box>` to the prompt so the model emits only 2–4 coordinate tokens
//!      (`<0>`..`<1000>`) or `none` (token ID `6697`) before terminating.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::ptr;
use std::time::Instant;

use crate::vision::Rect;

#[repr(C)]
pub struct OgaResult {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OgaConfig {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OgaModel {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OgaTokenizer {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OgaSequences {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OgaGeneratorParams {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OgaGenerator {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OgaTensor {
    _private: [u8; 0],
}

const OGA_ELEMENT_TYPE_FLOAT32: i32 = 1;
const OGA_ELEMENT_TYPE_INT64: i32 = 7;

const TOKEN_IM_END: i32 = 151645;
const TOKEN_NONE_LOWER: i32 = 6697;
const TOKEN_COORD_ZERO: i32 = 151669; // `<0>` .. `<1000>` = 151669 .. 152669
const TOKEN_COORD_MAX: i32 = 152669;
const TOKEN_REF_END: i32 = 152671; // `</ref>`
const TOKEN_BOX_END: i32 = 152673; // `</box>`
const TOKEN_POINT_END: i32 = 152675; // `</point>`

#[link(name = "onnxruntime-genai")]
extern "C" {
    fn OgaResultGetError(result: *const OgaResult) -> *const c_char;
    fn OgaDestroyResult(result: *mut OgaResult);
    fn OgaDestroyString(str_ptr: *const c_char);

    fn OgaCreateConfig(config_path: *const c_char, out: *mut *mut OgaConfig) -> *mut OgaResult;
    fn OgaConfigClearProviders(config: *mut OgaConfig) -> *mut OgaResult;
    fn OgaConfigAppendProvider(config: *mut OgaConfig, provider: *const c_char) -> *mut OgaResult;
    fn OgaDestroyConfig(config: *mut OgaConfig);

    fn OgaCreateModelFromConfig(
        config: *const OgaConfig,
        out: *mut *mut OgaModel,
    ) -> *mut OgaResult;
    fn OgaDestroyModel(model: *mut OgaModel);

    fn OgaCreateTokenizer(
        model: *const OgaModel,
        out: *mut *mut OgaTokenizer,
    ) -> *mut OgaResult;
    fn OgaDestroyTokenizer(tokenizer: *mut OgaTokenizer);
    fn OgaTokenizerEncode(
        tokenizer: *const OgaTokenizer,
        str_ptr: *const c_char,
        sequences: *mut OgaSequences,
    ) -> *mut OgaResult;
    fn OgaTokenizerDecode(
        tokenizer: *const OgaTokenizer,
        tokens: *const i32,
        token_count: usize,
        out_string: *mut *const c_char,
    ) -> *mut OgaResult;

    fn OgaCreateSequences(out: *mut *mut OgaSequences) -> *mut OgaResult;
    fn OgaDestroySequences(sequences: *mut OgaSequences);
    fn OgaSequencesGetSequenceCount(
        sequences: *const OgaSequences,
        sequence_index: usize,
    ) -> usize;
    fn OgaSequencesGetSequenceData(
        sequences: *const OgaSequences,
        sequence_index: usize,
    ) -> *const i32;

    fn OgaCreateGeneratorParams(
        model: *const OgaModel,
        out: *mut *mut OgaGeneratorParams,
    ) -> *mut OgaResult;
    fn OgaDestroyGeneratorParams(params: *mut OgaGeneratorParams);
    fn OgaGeneratorParamsSetSearchNumber(
        params: *mut OgaGeneratorParams,
        name: *const c_char,
        value: f64,
    ) -> *mut OgaResult;
    fn OgaGeneratorParamsSetSearchBool(
        params: *mut OgaGeneratorParams,
        name: *const c_char,
        value: bool,
    ) -> *mut OgaResult;

    fn OgaCreateGenerator(
        model: *const OgaModel,
        params: *const OgaGeneratorParams,
        out: *mut *mut OgaGenerator,
    ) -> *mut OgaResult;
    fn OgaDestroyGenerator(generator: *mut OgaGenerator);
    fn OgaGenerator_SetModelInput(
        generator: *mut OgaGenerator,
        name: *const c_char,
        tensor: *mut OgaTensor,
    ) -> *mut OgaResult;
    fn OgaGenerator_AppendTokens(
        generator: *mut OgaGenerator,
        input_ids: *const i32,
        input_ids_count: usize,
    ) -> *mut OgaResult;
    fn OgaGenerator_TokenCount(generator: *const OgaGenerator) -> usize;
    fn OgaGenerator_GenerateNextToken(generator: *mut OgaGenerator) -> *mut OgaResult;
    fn OgaGenerator_GetNextTokens(
        generator: *const OgaGenerator,
        out: *mut *const i32,
        out_count: *mut usize,
    ) -> *mut OgaResult;
    fn OgaGenerator_IsDone(generator: *mut OgaGenerator) -> bool;
    fn OgaGenerator_RewindTo(
        generator: *mut OgaGenerator,
        new_length: usize,
    ) -> *mut OgaResult;

    fn OgaCreateTensorFromBuffer(
        data: *mut c_void,
        shape_dims: *const i64,
        shape_dims_count: usize,
        element_type: i32,
        out: *mut *mut OgaTensor,
    ) -> *mut OgaResult;
    fn OgaDestroyTensor(tensor: *mut OgaTensor);
}

unsafe fn check_oga(res: *mut OgaResult) -> Result<(), String> {
    if res.is_null() {
        return Ok(());
    }
    let msg_ptr = OgaResultGetError(res);
    let msg = if msg_ptr.is_null() {
        "Unknown onnxruntime-genai error".to_string()
    } else {
        CStr::from_ptr(msg_ptr).to_string_lossy().into_owned()
    };
    OgaDestroyResult(res);
    Err(msg)
}

#[derive(Clone, Debug)]
pub struct WeVisOneGroundOutcome {
    pub task: String,
    pub query: String,
    pub rejected: bool,
    pub point: Option<(f32, f32)>,
    pub bbox: Option<Rect>,
    pub norm_coords: Vec<u32>,
    pub raw_response: String,
    pub visual_tokens: usize,
    pub kv_cache_reused: bool,
    pub foveated_refined: bool,
    pub coarse_point: Option<(f32, f32)>,
    pub refined_roi: Option<Rect>,
    pub preprocess_ms: f64,
    pub vision_and_prefill_ms: f64,
    pub query_prefill_ms: f64,
    pub decode_ms: f64,
    pub refine_ms: f64,
    pub total_ms: f64,
}

/// Qwen3-VL dynamic aspect-ratio-preserving smart resize (`factor = 32` = `patch_size(16) * merge(2)`).
/// Scales `(src_w, src_h)` so `tw * th <= max_visual_tokens * 1024` while preserving aspect ratio
/// and rounding both dimensions to multiples of 32.
pub fn smart_resize_qwen3_vl(
    src_w: usize,
    src_h: usize,
    min_visual_tokens: usize,
    max_visual_tokens: usize,
) -> (usize, usize) {
    let factor = 32.0f64;
    let w = (src_w.max(32)) as f64;
    let h = (src_h.max(32)) as f64;
    let min_pixels = (min_visual_tokens.max(4) * 1024) as f64;
    let max_pixels = (max_visual_tokens.max(min_visual_tokens.max(4)) * 1024) as f64;

    let mut h_bar = ((h / factor).round() as usize).max(2) * 32;
    let mut w_bar = ((w / factor).round() as usize).max(2) * 32;

    if ((h_bar * w_bar) as f64) > max_pixels {
        let beta = ((h * w) / max_pixels).sqrt();
        h_bar = (((h / beta / factor).floor() as usize).max(2)) * 32;
        w_bar = (((w / beta / factor).floor() as usize).max(2)) * 32;
    } else if ((h_bar * w_bar) as f64) < min_pixels {
        let beta = (min_pixels / (h * w)).sqrt();
        h_bar = (((h * beta / factor).ceil() as usize).max(2)) * 32;
        w_bar = (((w * beta / factor).ceil() as usize).max(2)) * 32;
    }
    (w_bar, h_bar)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroundingProtocol {
    /// `tencent/WeVisOne-VL-2B` (`<ref>...</ref><point><x><y>` with special `<0>..<1000>` tokens)
    WeVisOne,
    /// `mPLUG/GUI-Owl-1.5-2B-Instruct` or `Qwen/Qwen3-VL-2B-Instruct` (`computer_use` JSON `[x, y]` in 0..1000)
    GuiOwl,
}

pub struct WeVisOneOgaEngine {
    model: *mut OgaModel,
    tokenizer: *mut OgaTokenizer,
    params: *mut OgaGeneratorParams,
    cached_generator: *mut OgaGenerator,
    cached_frame_sig: u64,
    cached_prefix_len: usize,
    cached_visual_tokens: usize,
    pixel_values_buf: Vec<f32>,
    pub protocol: GroundingProtocol,
}

unsafe impl Send for WeVisOneOgaEngine {}

impl WeVisOneOgaEngine {
    pub fn load(model_dir: &str, provider: Option<&str>) -> Result<Self, String> {
        let dir_path = Path::new(model_dir);
        let cfg_path = dir_path.join("genai_config.json");
        if !cfg_path.exists() {
            return Err(format!(
                "WeVisOne-VL-2B OGA model not found at {} (missing genai_config.json)",
                model_dir
            ));
        }
        let manifest_raw = std::fs::read_to_string(dir_path.join("manifest.json")).unwrap_or_default();
        let env_proto = std::env::var("ETA_WEVISONE_PROTOCOL").unwrap_or_default();
        let protocol = if env_proto.eq_ignore_ascii_case("gui_owl")
            || manifest_raw.contains("\"groundingProtocol\": \"gui_owl\"")
            || manifest_raw.contains("GUI-Owl")
        {
            GroundingProtocol::GuiOwl
        } else {
            GroundingProtocol::WeVisOne
        };

        let c_dir = CString::new(model_dir).map_err(|e| e.to_string())?;
        unsafe {
            let mut config: *mut OgaConfig = ptr::null_mut();
            check_oga(OgaCreateConfig(c_dir.as_ptr(), &mut config))?;

            if let Some(ep) = provider.map(str::trim).filter(|s| !s.is_empty() && *s != "cpu") {
                if let Ok(c_ep) = CString::new(ep) {
                    let _ = check_oga(OgaConfigClearProviders(config));
                    let _ = check_oga(OgaConfigAppendProvider(config, c_ep.as_ptr()));
                }
            }

            let mut model: *mut OgaModel = ptr::null_mut();
            if let Err(err) = check_oga(OgaCreateModelFromConfig(config, &mut model)) {
                OgaDestroyConfig(config);
                // Fallback to default CPU config if requested accelerator provider is unavailable
                let mut cpu_cfg: *mut OgaConfig = ptr::null_mut();
                check_oga(OgaCreateConfig(c_dir.as_ptr(), &mut cpu_cfg))?;
                let res = check_oga(OgaCreateModelFromConfig(cpu_cfg, &mut model));
                OgaDestroyConfig(cpu_cfg);
                if res.is_err() {
                    return Err(err);
                }
            } else {
                OgaDestroyConfig(config);
            }

            let mut tokenizer: *mut OgaTokenizer = ptr::null_mut();
            if let Err(e) = check_oga(OgaCreateTokenizer(model, &mut tokenizer)) {
                OgaDestroyModel(model);
                return Err(e);
            }

            let mut params: *mut OgaGeneratorParams = ptr::null_mut();
            if let Err(e) = check_oga(OgaCreateGeneratorParams(model, &mut params)) {
                OgaDestroyTokenizer(tokenizer);
                OgaDestroyModel(model);
                return Err(e);
            }

            let c_do_sample = CString::new("do_sample").unwrap();
            let c_max_len = CString::new("max_length").unwrap();
            let _ = check_oga(OgaGeneratorParamsSetSearchBool(
                params,
                c_do_sample.as_ptr(),
                false,
            ));
            // `max_length` caps the *total* sequence: visual tokens + prompt + decoded
            // coordinates. A desktop screenshot needs ~510 visual tokens at native resolution
            // (1920x1080 / 64px patches), so a 512 cap left no room and the prefill was refused.
            // The prepared model's RoPE cache covers 4096 positions.
            let max_len = std::env::var("ETA_WEVISONE_MAX_LEN")
                .ok()
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| *v >= 512.0)
                .unwrap_or(2048.0);
            let _ = check_oga(OgaGeneratorParamsSetSearchNumber(
                params,
                c_max_len.as_ptr(),
                max_len,
            ));

            Ok(Self {
                model,
                tokenizer,
                params,
                cached_generator: ptr::null_mut(),
                cached_frame_sig: 0,
                cached_prefix_len: 0,
                cached_visual_tokens: 0,
                pixel_values_buf: Vec::new(),
                protocol,
            })
        }
    }

    fn encode_text(&self, text: &str) -> Result<Vec<i32>, String> {
        let c_text = CString::new(text).map_err(|e| e.to_string())?;
        unsafe {
            let mut seq: *mut OgaSequences = ptr::null_mut();
            check_oga(OgaCreateSequences(&mut seq))?;
            if let Err(e) = check_oga(OgaTokenizerEncode(self.tokenizer, c_text.as_ptr(), seq)) {
                OgaDestroySequences(seq);
                return Err(e);
            }
            let count = OgaSequencesGetSequenceCount(seq, 0);
            let data_ptr = OgaSequencesGetSequenceData(seq, 0);
            let out = if count > 0 && !data_ptr.is_null() {
                std::slice::from_raw_parts(data_ptr, count).to_vec()
            } else {
                Vec::new()
            };
            OgaDestroySequences(seq);
            Ok(out)
        }
    }

    fn decode_tokens(&self, tokens: &[i32]) -> String {
        if tokens.is_empty() {
            return String::new();
        }
        unsafe {
            let mut out_ptr: *const c_char = ptr::null();
            if check_oga(OgaTokenizerDecode(
                self.tokenizer,
                tokens.as_ptr(),
                tokens.len(),
                &mut out_ptr,
            ))
            .is_ok()
                && !out_ptr.is_null()
            {
                let s = CStr::from_ptr(out_ptr).to_string_lossy().into_owned();
                OgaDestroyString(out_ptr);
                s
            } else {
                String::new()
            }
        }
    }

    /// Run pure-vision grounding (`task` = `"point"` | `"referring"` | `"ocr_grounding"`) on an
    /// RGB frame `[width * height * 3]`, supporting:
    ///   1. **Aspect-Ratio-Preserving Smart Resize**: When `target_w == 0` or `target_h == 0`,
    ///      automatically computes `(tw, th)` from `(cw, ch)` and `max_visual_tokens` (default 512).
    ///   2. **Two-Stage Coarse-to-Fine Foveated Zoom**: When `foveated_refine` is enabled and the
    ///      source crop is high-resolution (`max(cw, ch) > max(tw, th) * 2`, e.g. 1080p / 1440p / 4K),
    ///      first runs a coarse global localization, then crops a native-resolution 1:1 foveated
    ///      window around the coarse prediction and runs a second pass so sub-12px icons/glyphs are
    ///      never lost to downsampling.
    #[allow(clippy::too_many_arguments)]
    pub fn ground(
        &mut self,
        rgb: &[u8],
        width: usize,
        height: usize,
        task: &str,
        query: &str,
        target_w: usize,
        target_h: usize,
        roi: Option<Rect>,
    ) -> Result<WeVisOneGroundOutcome, String> {
        self.ground_with_options(
            rgb, width, height, task, query, target_w, target_h, roi, 512, false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ground_with_options(
        &mut self,
        rgb: &[u8],
        width: usize,
        height: usize,
        task: &str,
        query: &str,
        target_w: usize,
        target_h: usize,
        roi: Option<Rect>,
        max_visual_tokens: usize,
        foveated_refine: bool,
    ) -> Result<WeVisOneGroundOutcome, String> {
        let t_total_start = Instant::now();
        let mut stage1 = self.ground_single_pass(
            rgb,
            width,
            height,
            task,
            query,
            target_w,
            target_h,
            roi,
            max_visual_tokens,
        )?;

        let crop = roi.unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            w: width as f32,
            h: height as f32,
        });

        // If `point` mode prematurely emitted `none` or a truncated 1-coordinate tag (`<962></ref>`),
        // retry once as `referring` (`<box>`) using the already-warm visual KV cache (~150ms).
        if stage1.rejected && task.eq_ignore_ascii_case("point") {
            if let Ok(box_fallback) = self.ground_single_pass(
                rgb,
                width,
                height,
                "referring",
                query,
                target_w,
                target_h,
                roi,
                max_visual_tokens,
            ) {
                if !box_fallback.rejected {
                    if let Some(b) = box_fallback.bbox {
                        if b.area() < crop.area() * 0.45 && b.w >= 8.0 && b.h >= 8.0 {
                            stage1.rejected = false;
                            stage1.point = box_fallback.point;
                            stage1.bbox = Some(b);
                            stage1.norm_coords = box_fallback.norm_coords;
                            stage1.raw_response = box_fallback.raw_response;
                            stage1.query_prefill_ms += box_fallback.query_prefill_ms;
                            stage1.decode_ms += box_fallback.decode_ms;
                        }
                    }
                }
            }
        }
        let downsample_ratio = (crop.w.max(crop.h)) / (256.0f32);

        if foveated_refine && !stage1.rejected && downsample_ratio >= 2.2 {
            if let Some((coarse_px, coarse_py)) = stage1.point {
                let t_ref = Instant::now();
                // Extract a high-resolution foveated window around `(coarse_px, coarse_py)`.
                // Window spans ~30% of the screen (clamped to [320, 640] px) so 1:1 details are crisp.
                let fov_w = (crop.w * 0.30).clamp(320.0, 640.0).min(width as f32);
                let fov_h = (crop.h * 0.30).clamp(224.0, 448.0).min(height as f32);
                let fov_x = (coarse_px - fov_w * 0.5).clamp(0.0, (width as f32 - fov_w).max(0.0));
                let fov_y = (coarse_py - fov_h * 0.5).clamp(0.0, (height as f32 - fov_h).max(0.0));
                let fov_rect = Rect {
                    x: fov_x,
                    y: fov_y,
                    w: fov_w,
                    h: fov_h,
                };

                // Save the global KV cache before running the foveated crop pass
                let saved_gen = self.cached_generator;
                let saved_sig = self.cached_frame_sig;
                let saved_prefix = self.cached_prefix_len;
                let saved_vtoks = self.cached_visual_tokens;
                self.cached_generator = ptr::null_mut();
                self.cached_frame_sig = 0;

                let stage2_res = self.ground_single_pass(
                    rgb,
                    width,
                    height,
                    task,
                    query,
                    0,
                    0,
                    Some(fov_rect),
                    max_visual_tokens.clamp(128, 256),
                );

                // Restore the global KV cache so subsequent queries on the full screen stay warm!
                unsafe {
                    if !self.cached_generator.is_null() {
                        OgaDestroyGenerator(self.cached_generator);
                    }
                }
                self.cached_generator = saved_gen;
                self.cached_frame_sig = saved_sig;
                self.cached_prefix_len = saved_prefix;
                self.cached_visual_tokens = saved_vtoks;

                let ref_ms = t_ref.elapsed().as_secs_f64() * 1000.0;
                stage1.refine_ms = ref_ms;
                stage1.coarse_point = Some((coarse_px, coarse_py));
                stage1.refined_roi = Some(fov_rect);

                if let Ok(stage2) = stage2_res {
                    if !stage2.rejected && stage2.point.is_some() {
                        stage1.foveated_refined = true;
                        stage1.point = stage2.point;
                        stage1.bbox = stage2.bbox;
                        stage1.norm_coords = stage2.norm_coords;
                        stage1.raw_response = stage2.raw_response;
                        stage1.visual_tokens += stage2.visual_tokens;
                    }
                }
                stage1.total_ms = t_total_start.elapsed().as_secs_f64() * 1000.0;
            }
        }

        Ok(stage1)
    }

    #[allow(clippy::too_many_arguments)]
    fn ground_single_pass(
        &mut self,
        rgb: &[u8],
        width: usize,
        height: usize,
        task: &str,
        query: &str,
        target_w: usize,
        target_h: usize,
        roi: Option<Rect>,
        max_visual_tokens: usize,
    ) -> Result<WeVisOneGroundOutcome, String> {
        if width == 0 || height == 0 || rgb.len() < width * height * 3 {
            return Err("Invalid RGB buffer dimensions".to_string());
        }
        let t_start = Instant::now();

        let crop = roi.unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            w: width as f32,
            h: height as f32,
        });
        let cx0 = (crop.x.max(0.0) as usize).min(width.saturating_sub(1));
        let cy0 = (crop.y.max(0.0) as usize).min(height.saturating_sub(1));
        let cw = ((crop.w.max(1.0) as usize).min(width - cx0)).max(1);
        let ch = ((crop.h.max(1.0) as usize).min(height - cy0)).max(1);

        // When target_w / target_h are 0, dynamically compute aspect-ratio-preserving Qwen3-VL grid
        let (tw, th) = if target_w == 0 || target_h == 0 {
            smart_resize_qwen3_vl(cw, ch, 16, max_visual_tokens.max(16))
        } else {
            (
                ((target_w.max(64) + 15) / 32 * 32).max(64),
                ((target_h.max(64) + 15) / 32 * 32).max(64),
            )
        };
        let gh = th / 16;
        let gw = tw / 16;
        let num_patches = gh * gw;
        let num_visual_tokens = num_patches / 4;

        // Compute fast FNV-1a signature over the sampled ROI + target grid so repeated queries on
        // the same screen reuse the prefilled KV cache via `OgaGenerator_RewindTo`.
        let frame_sig = compute_roi_signature(rgb, width, cx0, cy0, cw, ch, tw, th);
        let can_reuse_kv = !self.cached_generator.is_null()
            && self.cached_frame_sig == frame_sig
            && self.cached_prefix_len > 0
            && self.cached_visual_tokens == num_visual_tokens;

        let mut preprocess_ms = 0.0;
        let mut vision_and_prefill_ms = 0.0;

        unsafe {
            if !can_reuse_kv {
                if !self.cached_generator.is_null() {
                    OgaDestroyGenerator(self.cached_generator);
                    self.cached_generator = ptr::null_mut();
                }

                let t_pre = Instant::now();
                pack_qwen3_vl_patches(
                    rgb,
                    width,
                    height,
                    cx0,
                    cy0,
                    cw,
                    ch,
                    tw,
                    th,
                    &mut self.pixel_values_buf,
                );
                preprocess_ms = t_pre.elapsed().as_secs_f64() * 1000.0;

                let t_vis = Instant::now();
                let mut gen: *mut OgaGenerator = ptr::null_mut();
                check_oga(OgaCreateGenerator(self.model, self.params, &mut gen))?;

                let pv_shape: [i64; 2] = [num_patches as i64, 1536];
                let mut pv_tensor: *mut OgaTensor = ptr::null_mut();
                check_oga(OgaCreateTensorFromBuffer(
                    self.pixel_values_buf.as_mut_ptr() as *mut c_void,
                    pv_shape.as_ptr(),
                    pv_shape.len(),
                    OGA_ELEMENT_TYPE_FLOAT32,
                    &mut pv_tensor,
                ))?;

                let mut grid_data: [i64; 3] = [1, gh as i64, gw as i64];
                let grid_shape: [i64; 2] = [1, 3];
                let mut grid_tensor: *mut OgaTensor = ptr::null_mut();
                check_oga(OgaCreateTensorFromBuffer(
                    grid_data.as_mut_ptr() as *mut c_void,
                    grid_shape.as_ptr(),
                    grid_shape.len(),
                    OGA_ELEMENT_TYPE_INT64,
                    &mut grid_tensor,
                ))?;

                let mut n_tok_data: [i64; 1] = [num_visual_tokens as i64];
                let n_tok_shape: [i64; 1] = [1];
                let mut n_tok_tensor: *mut OgaTensor = ptr::null_mut();
                check_oga(OgaCreateTensorFromBuffer(
                    n_tok_data.as_mut_ptr() as *mut c_void,
                    n_tok_shape.as_ptr(),
                    n_tok_shape.len(),
                    OGA_ELEMENT_TYPE_INT64,
                    &mut n_tok_tensor,
                ))?;

                let c_pv = CString::new("pixel_values").unwrap();
                let c_grid = CString::new("image_grid_thw").unwrap();
                let c_ntok = CString::new("num_image_tokens").unwrap();

                let r1 = check_oga(OgaGenerator_SetModelInput(gen, c_pv.as_ptr(), pv_tensor));
                let r2 = check_oga(OgaGenerator_SetModelInput(gen, c_grid.as_ptr(), grid_tensor));
                let r3 = check_oga(OgaGenerator_SetModelInput(gen, c_ntok.as_ptr(), n_tok_tensor));

                OgaDestroyTensor(pv_tensor);
                OgaDestroyTensor(grid_tensor);
                OgaDestroyTensor(n_tok_tensor);

                if let Err(e) = r1.and(r2).and(r3) {
                    OgaDestroyGenerator(gen);
                    return Err(e);
                }

                let mut prefix_prompt = String::with_capacity(512 + num_visual_tokens * 13);
                if self.protocol == GroundingProtocol::GuiOwl {
                    prefix_prompt.push_str(
                        "<|im_start|>system\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\n\
                        You are provided with function signatures within <tools></tools> XML tags:\n<tools>\n\
                        {\"type\": \"function\", \"function\": {\"name\": \"computer_use\", \"description\": \"Use a mouse to interact with a computer.\\n\
                        * The screen's resolution is 1000x1000.\\n\
                        * Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.\\n\
                        * don't use any other computer use tool like type, key, scroll, left_click_drag and so on.\\n\
                        * you can only use the left_click and mouse_move action to interact with the computer. if you can't find the element, you should terminate the task and report the failure.\", \
                        \"parameters\": {\"properties\": {\"action\": {\"description\": \"The action to perform. The available actions are:\\n\
                        * `mouse_move`: Move the cursor to a specified (x, y) pixel coordinate on the screen.\\n\
                        * `left_click`: Click the left mouse button with coordinate (x, y) pixel coordinate on the screen.\", \
                        \"enum\": [\"mouse_move\", \"left_click\"], \"type\": \"string\"}, \"coordinate\": {\"description\": \"(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates to move the mouse to. Required only by `action=mouse_move` and `action=left_click`.\", \"type\": \"array\"}}, \"required\": [\"action\"], \"type\": \"object\"}}}\n\
                        </tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n\
                        <tool_call>\n{\"name\": <function-name>, \"arguments\": <args-json-object>}\n</tool_call><|im_end|>\n"
                    );
                }
                prefix_prompt.push_str("<|im_start|>user\n<|vision_start|>");
                for _ in 0..num_visual_tokens {
                    prefix_prompt.push_str("<|image_pad|>");
                }
                prefix_prompt.push_str("<|vision_end|>");

                let prefix_ids = match self.encode_text(&prefix_prompt) {
                    Ok(ids) => ids,
                    Err(e) => {
                        OgaDestroyGenerator(gen);
                        return Err(e);
                    }
                };
                if let Err(e) = check_oga(OgaGenerator_AppendTokens(
                    gen,
                    prefix_ids.as_ptr(),
                    prefix_ids.len(),
                )) {
                    OgaDestroyGenerator(gen);
                    return Err(e);
                }

                self.cached_prefix_len = OgaGenerator_TokenCount(gen);
                self.cached_frame_sig = frame_sig;
                self.cached_visual_tokens = num_visual_tokens;
                self.cached_generator = gen;
                vision_and_prefill_ms = t_vis.elapsed().as_secs_f64() * 1000.0;
            } else {
                check_oga(OgaGenerator_RewindTo(
                    self.cached_generator,
                    self.cached_prefix_len,
                ))?;
            }

            // Append query + structured prefix tag so decoding emits only coordinates or `none`
            let t_q = Instant::now();
            let clean_q = query.trim().trim_end_matches('.');
            let norm_task = task.trim().to_ascii_lowercase();
            let (prompt_body, open_tag, max_new_tokens) = match self.protocol {
                GroundingProtocol::GuiOwl => {
                    let allow_reject = norm_task != "point";
                    let body = if allow_reject {
                        format!(
                            "If the target is completely absent from the image, return \
                             <tool_call>\n{{\"name\": \"computer_use\", \"arguments\": {{\"action\": \"terminate\", \"status\": \"failure\"}}}}\n</tool_call>\n\
                             Otherwise click: {clean_q}"
                        )
                    } else {
                        clean_q.to_string()
                    };
                    let open = if allow_reject {
                        "<tool_call>\n{\"name\": \"computer_use\", \"arguments\": {\"action\": \"".to_string()
                    } else {
                        "<tool_call>\n{\"name\": \"computer_use\", \"arguments\": {\"action\": \"left_click\", \"coordinate\": [".to_string()
                    };
                    (body, open, 16usize)
                }
                GroundingProtocol::WeVisOne => match norm_task.as_str() {
                    "point" => (
                        format!("point to: {clean_q}"),
                        format!("<ref>{clean_q}</ref><point>"),
                        4usize,
                    ),
                    "ocr_grounding" => (
                        format!("Locate the following text in the image: {clean_q}"),
                        format!("<ref>{clean_q}</ref><box>"),
                        6usize,
                    ),
                    _ => (
                        format!("Locate a single instance that best matches the following description: {clean_q}."),
                        format!("<ref>{clean_q}</ref><box>"),
                        6usize,
                    ),
                },
            };

            let suffix_prompt = format!("{prompt_body}<|im_end|>\n<|im_start|>assistant\n{open_tag}");
            let suffix_ids = self.encode_text(&suffix_prompt)?;
            check_oga(OgaGenerator_AppendTokens(
                self.cached_generator,
                suffix_ids.as_ptr(),
                suffix_ids.len(),
            ))?;
            let query_prefill_ms = t_q.elapsed().as_secs_f64() * 1000.0;

            let t_dec = Instant::now();
            let mut out_tokens: Vec<i32> = Vec::with_capacity(max_new_tokens);
            let mut norm_coords: Vec<u32> = Vec::with_capacity(4);
            let mut rejected = false;

            for _ in 0..max_new_tokens {
                if OgaGenerator_IsDone(self.cached_generator) {
                    break;
                }
                check_oga(OgaGenerator_GenerateNextToken(self.cached_generator))?;
                let mut next_ptr: *const i32 = ptr::null();
                let mut next_cnt: usize = 0;
                check_oga(OgaGenerator_GetNextTokens(
                    self.cached_generator,
                    &mut next_ptr,
                    &mut next_cnt,
                ))?;
                if next_cnt == 0 || next_ptr.is_null() {
                    break;
                }
                let tok = *next_ptr;
                if tok == TOKEN_IM_END {
                    break;
                }
                out_tokens.push(tok);
                if tok == TOKEN_NONE_LOWER {
                    rejected = true;
                    break;
                }
                if (TOKEN_COORD_ZERO..=TOKEN_COORD_MAX).contains(&tok) {
                    norm_coords.push((tok - TOKEN_COORD_ZERO) as u32);
                    // In `point` mode, stop immediately once `<x><y>` (2 coords) are emitted!
                    if norm_task == "point" && norm_coords.len() >= 2 {
                        break;
                    }
                    // In `referring`/`box` mode, stop immediately once `<x1><y1><x2><y2>` (4 coords) are emitted!
                    if norm_task != "point" && norm_coords.len() >= 4 {
                        break;
                    }
                } else if tok == TOKEN_BOX_END || tok == TOKEN_POINT_END || tok == TOKEN_REF_END || tok == 151658 {
                    if norm_coords.len() < 2 && self.protocol == GroundingProtocol::WeVisOne {
                        rejected = true;
                    }
                    break;
                }
            }
            let decoded_tail = self.decode_tokens(&out_tokens);
            if self.protocol == GroundingProtocol::GuiOwl && norm_coords.len() < 2 {
                let tail_low = decoded_tail.to_ascii_lowercase();
                if tail_low.contains("terminate") || tail_low.contains("none") || tail_low.contains("failure") {
                    rejected = true;
                } else {
                    for num_str in decoded_tail.split(|c: char| !c.is_ascii_digit()) {
                        if !num_str.is_empty() {
                            if let Ok(v) = num_str.parse::<u32>() {
                                if v <= 1000 {
                                    norm_coords.push(v);
                                    if (norm_task == "point" && norm_coords.len() >= 2)
                                        || norm_coords.len() >= 4
                                    {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let decode_ms = t_dec.elapsed().as_secs_f64() * 1000.0;

            if norm_coords.len() < 2 {
                rejected = true;
            }

            let (point, bbox) = if rejected {
                (None, None)
            } else if norm_coords.len() >= 4 {
                let x1 = cx0 as f32 + (norm_coords[0] as f32 / 1000.0) * (cw as f32);
                let y1 = cy0 as f32 + (norm_coords[1] as f32 / 1000.0) * (ch as f32);
                let x2 = cx0 as f32 + (norm_coords[2] as f32 / 1000.0) * (cw as f32);
                let y2 = cy0 as f32 + (norm_coords[3] as f32 / 1000.0) * (ch as f32);
                let bx = x1.min(x2);
                let by = y1.min(y2);
                let bw = (x2 - x1).abs().max(4.0);
                let bh = (y2 - y1).abs().max(4.0);
                (
                    Some((bx + bw * 0.5, by + bh * 0.5)),
                    Some(Rect {
                        x: bx,
                        y: by,
                        w: bw,
                        h: bh,
                    }),
                )
            } else {
                let px = cx0 as f32 + (norm_coords[0] as f32 / 1000.0) * (cw as f32);
                let py = cy0 as f32 + (norm_coords[1] as f32 / 1000.0) * (ch as f32);
                let bw = 48.0f32.min( width as f32);
                let bh = 32.0f32.min(height as f32);
                (
                    Some((px, py)),
                    Some(Rect {
                        x: (px - bw * 0.5).clamp(0.0, (width as f32 - bw).max(0.0)),
                        y: (py - bh * 0.5).clamp(0.0, (height as f32 - bh).max(0.0)),
                        w: bw,
                        h: bh,
                    }),
                )
            };

            let raw_response = format!("{open_tag}{decoded_tail}");
            let total_ms = t_start.elapsed().as_secs_f64() * 1000.0;

            Ok(WeVisOneGroundOutcome {
                task: norm_task,
                query: clean_q.to_string(),
                rejected,
                point,
                bbox,
                norm_coords,
                raw_response,
                visual_tokens: num_visual_tokens,
                kv_cache_reused: can_reuse_kv,
                foveated_refined: false,
                coarse_point: None,
                refined_roi: None,
                preprocess_ms,
                vision_and_prefill_ms,
                query_prefill_ms,
                decode_ms,
                refine_ms: 0.0,
                total_ms,
            })
        }
    }
}

impl Drop for WeVisOneOgaEngine {
    fn drop(&mut self) {
        unsafe {
            if !self.cached_generator.is_null() {
                OgaDestroyGenerator(self.cached_generator);
                self.cached_generator = ptr::null_mut();
            }
            if !self.params.is_null() {
                OgaDestroyGeneratorParams(self.params);
                self.params = ptr::null_mut();
            }
            if !self.tokenizer.is_null() {
                OgaDestroyTokenizer(self.tokenizer);
                self.tokenizer = ptr::null_mut();
            }
            if !self.model.is_null() {
                OgaDestroyModel(self.model);
                self.model = ptr::null_mut();
            }
        }
    }
}

fn compute_roi_signature(
    rgb: &[u8],
    width: usize,
    cx0: usize,
    cy0: usize,
    cw: usize,
    ch: usize,
    tw: usize,
    th: usize,
) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for v in [cx0, cy0, cw, ch, tw, th] {
        h ^= v as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let step_y = (ch / 16).max(1);
    let step_x = (cw / 16).max(1);
    let mut y = cy0;
    while y < cy0 + ch {
        let mut x = cx0;
        while x < cx0 + cw {
            let idx = (y * width + x) * 3;
            if idx + 2 < rgb.len() {
                let pack = (rgb[idx] as u64)
                    | ((rgb[idx + 1] as u64) << 8)
                    | ((rgb[idx + 2] as u64) << 16);
                h ^= pack;
                h = h.wrapping_mul(0x100000001b3);
            }
            x += step_x;
        }
        y += step_y;
    }
    h
}

/// Bilinearly resize `[cx0..cx0+cw, cy0..cy0+ch]` to `(tw, th)`, normalize to `[-1, 1]`,
/// and pack into Qwen3-VL's block-major layout `[gh//2, gw//2, 2, 2, 3(C), 2(T), 16, 16]`
/// flattened as `[num_patches, 1536]`.
#[allow(clippy::too_many_arguments)]
fn pack_qwen3_vl_patches(
    rgb: &[u8],
    width: usize,
    height: usize,
    cx0: usize,
    cy0: usize,
    cw: usize,
    ch: usize,
    tw: usize,
    th: usize,
    out: &mut Vec<f32>,
) {
    let gh = th / 16;
    let gw = tw / 16;
    let num_patches = gh * gw;
    out.resize(num_patches * 1536, 0.0);

    // First bilinearly sample into a planar `[3, th, tw]` buffer normalized to `[-1, 1]`
    let plane_len = th * tw;
    let mut planar = vec![0.0f32; 3 * plane_len];
    let scale_x = cw as f32 / tw as f32;
    let scale_y = ch as f32 / th as f32;

    for ty in 0..th {
        let sy_f = (ty as f32 + 0.5) * scale_y - 0.5;
        let y0 = (cx_clamp(sy_f.floor() as isize, ch) + cy0).min(height - 1);
        let y1 = (cx_clamp(sy_f.floor() as isize + 1, ch) + cy0).min(height - 1);
        let wy = sy_f - sy_f.floor();

        for tx in 0..tw {
            let sx_f = (tx as f32 + 0.5) * scale_x - 0.5;
            let x0 = (cx_clamp(sx_f.floor() as isize, cw) + cx0).min(width - 1);
            let x1 = (cx_clamp(sx_f.floor() as isize + 1, cw) + cx0).min(width - 1);
            let wx = sx_f - sx_f.floor();

            let w00 = (1.0 - wx) * (1.0 - wy);
            let w01 = wx * (1.0 - wy);
            let w10 = (1.0 - wx) * wy;
            let w11 = wx * wy;

            let i00 = (y0 * width + x0) * 3;
            let i01 = (y0 * width + x1) * 3;
            let i10 = (y1 * width + x0) * 3;
            let i11 = (y1 * width + x1) * 3;

            let dst_idx = ty * tw + tx;
            for c in 0..3 {
                let v = w00 * (rgb[i00 + c] as f32)
                    + w01 * (rgb[i01 + c] as f32)
                    + w10 * (rgb[i10 + c] as f32)
                    + w11 * (rgb[i11 + c] as f32);
                planar[c * plane_len + dst_idx] = v * (1.0 / 127.5) - 1.0;
            }
        }
    }

    // Qwen3-VL block-major patch order:
    //   outer: by in 0..gh/2, bx in 0..gw/2, iy in 0..2, ix in 0..2
    //   inner (1536 floats): c in 0..3, t in 0..2, py in 0..16, px in 0..16
    let mut patch_idx = 0usize;
    for by in 0..(gh / 2) {
        for bx in 0..(gw / 2) {
            for iy in 0..2 {
                for ix in 0..2 {
                    let row_patch = by * 2 + iy;
                    let col_patch = bx * 2 + ix;
                    let y_base = row_patch * 16;
                    let x_base = col_patch * 16;
                    let dst_patch = &mut out[patch_idx * 1536..(patch_idx + 1) * 1536];
                    let mut write_pos = 0usize;
                    for c in 0..3 {
                        let c_plane = &planar[c * plane_len..(c + 1) * plane_len];
                        for _t in 0..2 {
                            for py in 0..16 {
                                let src_row = &c_plane[(y_base + py) * tw + x_base
                                    ..(y_base + py) * tw + x_base + 16];
                                dst_patch[write_pos..write_pos + 16].copy_from_slice(src_row);
                                write_pos += 16;
                            }
                        }
                    }
                    patch_idx += 1;
                }
            }
        }
    }
}

#[inline]
fn cx_clamp(v: isize, len: usize) -> usize {
    if v <= 0 {
        0
    } else if (v as usize) >= len {
        len.saturating_sub(1)
    } else {
        v as usize
    }
}
