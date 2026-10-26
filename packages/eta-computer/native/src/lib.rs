//! Native C-ABI entrypoint for `@eta/computer`, loaded by Bun via `bun:ffi`.

pub mod bpe;
pub mod fusion;
pub mod oga_grounding;
pub mod ort_backend;
pub mod predictor;
pub mod vision;

use std::collections::HashMap;
use std::ffi::{c_char, CStr, CString};
use std::path::Path;
use std::ptr;
use std::slice;
use std::time::Instant;

use fusion::{FusionSnapshot, PersistentAnchorTracker, StructuralNodeInput};
use oga_grounding::{WeVisOneGroundOutcome, WeVisOneOgaEngine};
use ort_backend::EdgeModelTriad;
use predictor::{
    evaluate_and_decide, predict_forward_delta, ExpectedStateDelta, PlannedAction,
};
use vision::{compute_dirty_rects, run_vision_pipeline, Rect};

pub struct ComputerEngine {
    pub models_dir: String,
    pub triad: EdgeModelTriad,
    pub wevisone_oga: Option<WeVisOneOgaEngine>,
    pub tracker: PersistentAnchorTracker,
    pub ocr_cache: HashMap<u64, String>,
    pub last_expected_delta: Option<ExpectedStateDelta>,
    pub last_fusion: Option<FusionSnapshot>,
    /// Landmarks from the last frame that actually ran the detector, and the structural
    /// signature they were seen with. Reused while nothing about the widget set changed.
    pub last_landmarks: Vec<vision::VisualLandmark>,
    pub last_structural_sig: u64,
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

/// Minimal, zero-dependency parser for the step input parameters passed from TypeScript.
/// Format is line-oriented TSV for zero parsing overhead (`< 0.02ms`):
///   Line 0: `META\t<subgoal>\t<cursor>\t<stagnation_steps>\t<now_ms>\t<max_anchors>\t<reset_delta:0|1>`
///   Line 1: `NEXT\t<action_type>\t<target_anchor_id_or_0>\t<target_label_hint>\t<text_arg>`
///   Line 2+: `NODE\t<role>\t<label>\t<x>\t<y>\t<w>\t<h>\t<focused:0|1>\t<enabled:0|1>\t<region>\t<z_layer>`
struct ParsedStepInput {
    subgoal: String,
    cursor: String,
    stagnation_steps: u32,
    now_ms: u64,
    max_anchors: usize,
    reset_delta: bool,
    enable_wevisone_fallback: bool,
    next_hint: Option<PlannedAction>,
    nodes: Vec<StructuralNodeInput>,
}

fn parse_step_spec(spec: &str) -> ParsedStepInput {
    let mut subgoal = String::new();
    let mut cursor = "arrow".to_string();
    let mut stagnation_steps = 0u32;
    let mut now_ms = 1000u64;
    let mut max_anchors = 32usize;
    let mut reset_delta = false;
    let mut enable_wevisone_fallback = false;
    let mut next_hint: Option<PlannedAction> = None;
    let mut nodes: Vec<StructuralNodeInput> = Vec::new();

    for line in spec.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        match parts[0] {
            "META" if parts.len() >= 7 => {
                subgoal = parts[1].to_string();
                cursor = parts[2].to_string();
                stagnation_steps = parts[3].parse().unwrap_or(0);
                now_ms = parts[4].parse().unwrap_or(1000);
                max_anchors = parts[5].parse().unwrap_or(32);
                reset_delta = parts[6] == "1";
                if parts.len() >= 8 {
                    enable_wevisone_fallback = parts[7] == "1";
                }
            }
            "NEXT" if parts.len() >= 5 => {
                let act = parts[1].to_string();
                if !act.is_empty() {
                    let id_val: u32 = parts[2].parse().unwrap_or(0);
                    next_hint = Some(PlannedAction {
                        action_type: act,
                        target_anchor_id: if id_val > 0 { Some(id_val) } else { None },
                        target_label_hint: parts[3].to_string(),
                        text_arg: if parts[4].is_empty() {
                            None
                        } else {
                            Some(parts[4].to_string())
                        },
                    });
                }
            }
            "NODE" if parts.len() >= 11 => {
                nodes.push(StructuralNodeInput {
                    role: parts[1].to_string(),
                    label: parts[2].to_string(),
                    bbox: Rect {
                        x: parts[3].parse().unwrap_or(0.0),
                        y: parts[4].parse().unwrap_or(0.0),
                        w: parts[5].parse().unwrap_or(32.0),
                        h: parts[6].parse().unwrap_or(24.0),
                    },
                    focused: parts[7] == "1",
                    enabled: parts[8] != "0",
                    region: parts[9].to_string(),
                    z_layer: parts[10].parse().unwrap_or(0),
                });
            }
            _ => {}
        }
    }

    ParsedStepInput {
        subgoal,
        cursor,
        stagnation_steps,
        now_ms,
        max_anchors,
        reset_delta,
        enable_wevisone_fallback,
        next_hint,
        nodes,
    }
}

impl ComputerEngine {
    pub fn ensure_wevisone_oga(&mut self) -> Result<&mut WeVisOneOgaEngine, String> {
        if self.wevisone_oga.is_none() {
            let oga_dir = std::env::var("ETA_WEVISONE_OGA_DIR")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    Path::new(&self.models_dir)
                        .join("wevisone_vl_2b_oga")
                        .to_string_lossy()
                        .into_owned()
                });
            let oga_ep = std::env::var("ETA_WEVISONE_PROVIDER").ok();
            let engine = WeVisOneOgaEngine::load(&oga_dir, oga_ep.as_deref())?;
            self.wevisone_oga = Some(engine);
        }
        Ok(self.wevisone_oga.as_mut().unwrap())
    }
}

#[no_mangle]
pub unsafe extern "C" fn EtaComputerCreate(
    models_dir: *const c_char,
    provider_spec: *const c_char,
) -> *mut ComputerEngine {
    if models_dir.is_null() {
        return ptr::null_mut();
    }
    let dir_str = CStr::from_ptr(models_dir).to_string_lossy().into_owned();
    // The provider preference is normally already in the environment; the argument exists so one
    // process can build engines on different accelerators (tests, benchmarks).
    let spec = if provider_spec.is_null() {
        None
    } else {
        Some(
            CStr::from_ptr(provider_spec)
                .to_string_lossy()
                .into_owned(),
        )
    }
    .filter(|s| !s.trim().is_empty());
    match EdgeModelTriad::load(&dir_str, spec.as_deref()) {
        Ok(triad) => Box::into_raw(Box::new(ComputerEngine {
            models_dir: dir_str,
            triad,
            wevisone_oga: None,
            tracker: PersistentAnchorTracker::new(),
            ocr_cache: HashMap::new(),
            last_expected_delta: None,
            last_fusion: None,
            last_landmarks: Vec::new(),
            last_structural_sig: 0,
        })),
        Err(err) => {
            eprintln!("[eta-computer-native] EtaComputerCreate failed: {}", err);
            ptr::null_mut()
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn EtaComputerMarkClicked(
    engine: *mut ComputerEngine,
    anchor_id: u32,
    now_ms: u64,
) {
    if engine.is_null() {
        return;
    }
    (*engine).tracker.mark_clicked(anchor_id, now_ms);
}

#[no_mangle]
pub unsafe extern "C" fn EtaComputerStep(
    engine: *mut ComputerEngine,
    prev_rgb_ptr: *const u8,
    curr_rgb_ptr: *const u8,
    rgb_len: u64,
    width: u32,
    height: u32,
    spec_ptr: *const c_char,
) -> *mut c_char {
    if engine.is_null() || curr_rgb_ptr.is_null() || spec_ptr.is_null() {
        return ptr::null_mut();
    }
    let eng = &mut *engine;
    let total_t0 = Instant::now();

    let len = rgb_len as usize;
    let curr_rgb = slice::from_raw_parts(curr_rgb_ptr, len);
    let prev_rgb = if prev_rgb_ptr.is_null() {
        &[][..]
    } else {
        slice::from_raw_parts(prev_rgb_ptr, len)
    };
    let spec_str = CStr::from_ptr(spec_ptr).to_string_lossy();
    let parsed = parse_step_spec(&spec_str);

    if parsed.reset_delta {
        eng.last_expected_delta = None;
    }

    // Stage 1: 8x8 Grid Dirty Rects + Onset/Settle State Machine
    let t_dirty = Instant::now();
    let dirty = compute_dirty_rects(
        prev_rgb,
        curr_rgb,
        width as usize,
        height as usize,
        0.03,
    );
    let dirty_diff_ms = t_dirty.elapsed().as_secs_f64() * 1000.0;

    // Stage 2 & 3: Vision Pipeline (`ui_detector_embed.onnx` + `ocr_rec.onnx`)
    //
    // The detector costs ~20ms on a laptop CPU, and most steps of a GUI loop do not change
    // which widgets exist: typing into a field, a checkbox toggling, a caret blinking. When
    // the structural tree is unchanged and the frame barely moved, the landmarks from the
    // last detection still describe the screen, so the convolutions are skipped entirely.
    let structural_sig = {
        let mut h: u64 = 0xcbf29ce484222325;
        for node in &parsed.nodes {
            for byte in node.role.bytes().chain(node.label.bytes()) {
                h ^= byte as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            h ^= node.bbox.w as u64 ^ ((node.bbox.h as u64) << 32);
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    };
    let can_reuse_landmarks = !eng.last_landmarks.is_empty()
        && !parsed.reset_delta
        && structural_sig == eng.last_structural_sig
        && dirty.dirty_area_ratio < 0.03
        && !dirty.active_spinner_detected;

    let (visual_landmarks, vision_stats) = if can_reuse_landmarks {
        (
            eng.last_landmarks.clone(),
            vision::VisionPerceptionStats {
                atlas_pack_ms: 0.0,
                detector_ort_ms: 0.0,
                nms_and_embed_ms: 0.0,
                ocr_ort_ms: 0.0,
                // Every landmark this frame was resolved without running the recogniser.
                ocr_cache_hits: eng.last_landmarks.len(),
                ocr_cache_misses: 0,
                atlas_tiles_packed: 0,
            },
        )
    } else {
        let labeled_boxes: Vec<Rect> = parsed
            .nodes
            .iter()
            .filter(|n| !n.label.trim().is_empty() && n.enabled)
            .map(|n| n.bbox)
            .collect();
        match run_vision_pipeline(
            &mut eng.triad,
            curr_rgb,
            width as usize,
            height as usize,
            &dirty.dirty_rects,
            dirty.dirty_area_ratio,
            &mut eng.ocr_cache,
            &labeled_boxes,
            0.25,
            32,
        ) {
            Ok(res) => {
                eng.last_structural_sig = structural_sig;
                eng.last_landmarks = res.0.clone();
                res
            }
            Err(e) => {
                let err_json = format!("{{\"ok\":false,\"error\":\"{}\"}}", json_escape(&e));
                return CString::new(err_json).unwrap().into_raw();
            }
        }
    };

    // Stage 4: Multi-Modal IoU Fusion + Rigid-Body Scroll Compensation + Persistent Tracking + Foveated Folding
    let t_fuse = Instant::now();
    let mut fusion = eng.tracker.fuse_and_track(
        &parsed.nodes,
        &visual_landmarks,
        &parsed.subgoal,
        parsed.max_anchors,
    );
    let fusion_ms = t_fuse.elapsed().as_secs_f64() * 1000.0;

    // Stage 5 & 6: UI-JEPA Surprise Evaluation + OpenJev System-1 Single-Pass Calibrated Decision
    let mut decision = match evaluate_and_decide(
        &mut eng.triad,
        &parsed.subgoal,
        parsed.next_hint.as_ref(),
        eng.last_expected_delta.as_ref(),
        &dirty,
        &fusion,
        &parsed.cursor,
        parsed.stagnation_steps,
        parsed.now_ms,
    ) {
        Ok(d) => d,
        Err(e) => {
            let err_json = format!("{{\"ok\":false,\"error\":\"{}\"}}", json_escape(&e));
            return CString::new(err_json).unwrap().into_raw();
        }
    };

    // Optional Stage 6.5: Pure-Vision Medium Path (`WeVisOne-VL-2B` via `onnxruntime-genai`)
    // Triggered when `enable_wevisone_fallback` is true and either:
    //   1. System-1 returned `slow_escalation`, OR
    //   2. No structural A11y nodes were supplied (`parsed.nodes.is_empty()`), no explicit
    //      `target_anchor_id` was pinned, and the chosen anchor has generic/unmatched text.
    let mut wevisone_outcome: Option<WeVisOneGroundOutcome> = None;
    let mut wevisone_ms = 0.0f64;
    let query_str = parsed
        .next_hint
        .as_ref()
        .map(|h| h.target_label_hint.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| parsed.subgoal.trim())
        .to_string();
    let has_explicit_id = parsed
        .next_hint
        .as_ref()
        .and_then(|h| h.target_anchor_id)
        .is_some();
    let chosen_is_unmatched = decision.chosen_anchor_id.map_or(true, |cid| {
        fusion
            .active_anchors
            .iter()
            .find(|a| a.persistent_id == cid)
            .map_or(true, |a| {
                a.label.is_empty()
                    || a.label.eq_ignore_ascii_case(&a.role)
                    || !a
                        .label
                        .to_ascii_lowercase()
                        .contains(&query_str.to_ascii_lowercase())
            })
    });
    let should_run_wevisone = parsed.enable_wevisone_fallback
        && !query_str.is_empty()
        && (decision.gate == "slow_escalation"
            || (parsed.nodes.is_empty() && !has_explicit_id && chosen_is_unmatched));

    if should_run_wevisone {
        let act_type = parsed
            .next_hint
            .as_ref()
            .map(|h| h.action_type.as_str())
            .unwrap_or("click")
            .to_string();

        if let Ok(oga) = eng.ensure_wevisone_oga() {
            // If dirty area is localized (e.g. a newly popped-up dropdown or dialog < 35% of screen),
            // crop around `dirty.union_dirty` (padded by 48px) for 1:1 native detail; otherwise
            // enable 2-stage coarse-to-fine foveated refinement when the screen exceeds 1080p.
            let localized_roi = if dirty.dirty_area_ratio > 0.002 && dirty.dirty_area_ratio < 0.35 {
                dirty.union_dirty.map(|u| {
                    let rx = (u.x - 48.0).max(0.0);
                    let ry = (u.y - 48.0).max(0.0);
                    let rw = (u.w + 96.0).min(width as f32 - rx);
                    let rh = (u.h + 96.0).min(height as f32 - ry);
                    Rect {
                        x: rx,
                        y: ry,
                        w: rw,
                        h: rh,
                    }
                })
            } else {
                None
            };
            let auto_foveated = localized_roi.is_none() && (width >= 1600 || height >= 900);

            if let Ok(grounded) = oga.ground_with_options(
                curr_rgb,
                width as usize,
                height as usize,
                "referring",
                &query_str,
                0,
                0,
                localized_roi,
                32,
                auto_foveated,
            ) {
                wevisone_ms = grounded.total_ms;
                if !grounded.rejected {
                    if let (Some(bbox), Some(pt)) = (grounded.bbox, grounded.point) {
                        let fused_anchor = eng.tracker.upsert_grounded_anchor(
                            &mut fusion,
                            &query_str,
                            bbox,
                            pt,
                        );
                        decision.gate = "fast_commit";
                        decision.chosen_anchor_id = Some(fused_anchor.persistent_id);
                        decision.chosen_bbox = Some(fused_anchor.bbox);
                        decision.chosen_action =
                            format!("{}:#{}", act_type, fused_anchor.persistent_id);
                        decision.chosen_probability = 0.96;
                        decision.confidence_margin = 0.85;
                    }
                } else {
                    decision.gate = "slow_escalation";
                    decision.chosen_action = "escalate_to_slow_vlm".to_string();
                    decision.chosen_anchor_id = None;
                    decision.chosen_bbox = None;
                }
                wevisone_outcome = Some(grounded);
            }
        }
    }

    // Stage 7: Active Forward Prediction for the chosen next action
    let t_pred = Instant::now();
    let chosen_act_type = decision
        .chosen_action
        .split(':')
        .next()
        .unwrap_or("click")
        .to_string();
    let next_planned = PlannedAction {
        action_type: chosen_act_type,
        target_anchor_id: decision.chosen_anchor_id,
        target_label_hint: String::new(),
        text_arg: parsed.next_hint.as_ref().and_then(|h| h.text_arg.clone()),
    };
    let next_expected = predict_forward_delta(
        &fusion,
        &next_planned,
        width as f32,
        height as f32,
    );
    let forward_pred_ms = t_pred.elapsed().as_secs_f64() * 1000.0;

    // If we committed a click action, record the debounce timestamp
    if decision.gate == "fast_commit" || decision.gate == "local_micro_correction" {
        if let Some(cid) = decision.chosen_anchor_id {
            if decision.chosen_action.starts_with("click:") {
                eng.tracker.mark_clicked(cid, parsed.now_ms);
            }
        }
    }

    eng.last_expected_delta = Some(next_expected.clone());
    let total_step_ms = total_t0.elapsed().as_secs_f64() * 1000.0;

    // Serialize JSON response
    let mut anchors_json = String::from("[");
    for (i, a) in fusion.active_anchors.iter().enumerate() {
        if i > 0 {
            anchors_json.push(',');
        }
        anchors_json.push_str(&format!(
            "{{\"id\":{},\"role\":\"{}\",\"label\":\"{}\",\"region\":\"{}\",\"bbox\":{{\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1}}},\"focused\":{},\"confidence\":{:.3},\"movedDelta\":[{:.1},{:.1}]}}",
            a.persistent_id,
            json_escape(&a.role),
            json_escape(&a.label),
            json_escape(&a.region),
            a.bbox.x,
            a.bbox.y,
            a.bbox.w,
            a.bbox.h,
            a.focused,
            a.confidence,
            a.moved_delta.0,
            a.moved_delta.1
        ));
    }
    anchors_json.push(']');

    let mut collapsed_json = String::from("[");
    for (i, c) in fusion.collapsed_regions.iter().enumerate() {
        if i > 0 {
            collapsed_json.push(',');
        }
        collapsed_json.push_str(&format!(
            "{{\"region\":\"{}\",\"itemCount\":{},\"sampleLabels\":\"{}\"}}",
            json_escape(&c.region),
            c.item_count,
            json_escape(&c.sample_labels)
        ));
    }
    collapsed_json.push(']');

    let chosen_bbox_json = match decision.chosen_bbox {
        Some(b) => format!("{{\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1}}}", b.x, b.y, b.w, b.h),
        None => "null".to_string(),
    };

    let regime_name = match next_expected.regime {
        predictor::TransitionRegime::LocalPerturbation => "local_perturbation",
        predictor::TransitionRegime::StructuralRegimeShift => "structural_regime_shift",
    };

    let wevisone_json = match &wevisone_outcome {
        Some(w) => serialize_wevisone_outcome(w),
        None => "null".to_string(),
    };

    let json = format!(
        "{{\"ok\":true,\
        \"ortVersion\":\"{}\",\
        \"provider\":\"{}\",\
        \"ocrProvider\":\"{}\",\
        \"encoderProvider\":\"{}\",\
        \"providerChain\":[{}],\
        \"gate\":\"{}\",\
        \"chosenAction\":\"{}\",\
        \"chosenAnchorId\":{},\
        \"chosenBbox\":{},\
        \"chosenProbability\":{:.4},\
        \"confidenceMargin\":{:.4},\
        \"noul\":{{\"postconditionMet\":{:.4},\"unexpectedBlocker\":{:.4},\"irreversibleRisk\":{:.4}}},\
        \"goalProgressScore\":{:.4},\
        \"surprise\":{{\"totalEnergy\":{:.4},\"structuralError\":{:.4},\"roiEscapeError\":{:.4},\"latentResidual\":{:.4},\"dirtyRoiIou\":{:.4},\"latentCosineSim\":{:.4}}},\
        \"forwardPrediction\":{{\"regime\":\"{}\",\"expectedFocusId\":{},\"expectedCursor\":\"{}\",\"predictedRoi\":{{\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1}}},\"expectsDropdownOrPopup\":{}}},\
        \"dirty\":{{\"rectCount\":{},\"dirtyAreaRatio\":{:.4},\"actionOnsetDetected\":{},\"activeSpinnerDetected\":{},\"visualSettled\":{}}},\
        \"fusion\":{{\"activeAnchorCount\":{},\"collapsedRegionCount\":{},\"rigidScrollDetected\":{},\"rigidScrollDelta\":[{:.1},{:.1}],\"modalIsolated\":{},\"retainedIdCount\":{},\"newlyAddedCount\":{},\"visualLandmarkCount\":{},\"landmarkReused\":{}}},\
        \"activeAnchors\":{},\
        \"collapsedRegions\":{},\
        \"wevisoneGrounding\":{},\
        \"timingsMs\":{{\"dirtyDiff\":{:.3},\"atlasPack\":{:.3},\"detectorOrt\":{:.3},\"nmsAndEmbed\":{:.3},\"ocrOrt\":{:.3},\"fusion\":{:.3},\"jevOrt\":{:.3},\"wevisoneOga\":{:.3},\"forwardPred\":{:.3},\"totalStep\":{:.3}}},\
        \"ocrCache\":{{\"hits\":{},\"misses\":{},\"totalEntries\":{}}}\
        }}",
        json_escape(&eng.triad.version),
        eng.triad.provider.label(),
        eng.triad.ocr_provider.label(),
        eng.triad.encoder_provider.label(),
        eng.triad
            .provider_chain
            .iter()
            .map(|p| format!("\"{}\"", json_escape(p)))
            .collect::<Vec<_>>()
            .join(","),
        decision.gate,
        json_escape(&decision.chosen_action),
        decision.chosen_anchor_id.map(|v| v.to_string()).unwrap_or_else(|| "null".to_string()),
        chosen_bbox_json,
        decision.chosen_probability,
        decision.confidence_margin,
        decision.p_postcondition_met,
        decision.p_unexpected_blocker,
        decision.p_irreversible_risk,
        decision.goal_progress_score,
        decision.surprise.total_surprise_energy,
        decision.surprise.structural_error,
        decision.surprise.roi_escape_error,
        decision.surprise.latent_residual,
        decision.surprise.dirty_roi_iou,
        decision.surprise.latent_cosine_sim,
        regime_name,
        next_expected.expected_focus_id.map(|v| v.to_string()).unwrap_or_else(|| "null".to_string()),
        next_expected.expected_cursor,
        next_expected.predicted_roi.x,
        next_expected.predicted_roi.y,
        next_expected.predicted_roi.w,
        next_expected.predicted_roi.h,
        next_expected.expects_dropdown_or_popup,
        dirty.dirty_rects.len(),
        dirty.dirty_area_ratio,
        dirty.action_onset_detected,
        dirty.active_spinner_detected,
        dirty.visual_settled,
        fusion.active_anchors.len(),
        fusion.collapsed_regions.len(),
        fusion.rigid_scroll_detected,
        fusion.rigid_scroll_delta.0,
        fusion.rigid_scroll_delta.1,
        fusion.modal_isolated,
        fusion.retained_id_count,
        fusion.newly_added_count,
        visual_landmarks.len(),
        can_reuse_landmarks,
        anchors_json,
        collapsed_json,
        wevisone_json,
        dirty_diff_ms,
        vision_stats.atlas_pack_ms,
        vision_stats.detector_ort_ms,
        vision_stats.nms_and_embed_ms,
        vision_stats.ocr_ort_ms,
        fusion_ms,
        decision.jev_ort_ms,
        wevisone_ms,
        forward_pred_ms,
        total_step_ms,
        vision_stats.ocr_cache_hits,
        vision_stats.ocr_cache_misses,
        eng.ocr_cache.len()
    );

    CString::new(json).unwrap().into_raw()
}

fn serialize_wevisone_outcome(w: &WeVisOneGroundOutcome) -> String {
    let pt_json = match w.point {
        Some((px, py)) => format!("[{:.1},{:.1}]", px, py),
        None => "null".to_string(),
    };
    let coarse_pt_json = match w.coarse_point {
        Some((px, py)) => format!("[{:.1},{:.1}]", px, py),
        None => "null".to_string(),
    };
    let box_json = match w.bbox {
        Some(b) => format!(
            "{{\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1}}}",
            b.x, b.y, b.w, b.h
        ),
        None => "null".to_string(),
    };
    let ref_roi_json = match w.refined_roi {
        Some(b) => format!(
            "{{\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1}}}",
            b.x, b.y, b.w, b.h
        ),
        None => "null".to_string(),
    };
    let coords_json = w
        .norm_coords
        .iter()
        .map(|c| c.to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"task\":\"{}\",\
        \"query\":\"{}\",\
        \"rejected\":{},\
        \"point\":{},\
        \"bbox\":{},\
        \"normCoords\":[{}],\
        \"rawResponse\":\"{}\",\
        \"visualTokens\":{},\
        \"kvCacheReused\":{},\
        \"foveatedRefined\":{},\
        \"coarsePoint\":{},\
        \"refinedRoi\":{},\
        \"timingsMs\":{{\"preprocess\":{:.3},\"visionAndPrefill\":{:.3},\"queryPrefill\":{:.3},\"decode\":{:.3},\"refine\":{:.3},\"total\":{:.3}}}\
        }}",
        json_escape(&w.task),
        json_escape(&w.query),
        w.rejected,
        pt_json,
        box_json,
        coords_json,
        json_escape(&w.raw_response),
        w.visual_tokens,
        w.kv_cache_reused,
        w.foveated_refined,
        coarse_pt_json,
        ref_roi_json,
        w.preprocess_ms,
        w.vision_and_prefill_ms,
        w.query_prefill_ms,
        w.decode_ms,
        w.refine_ms,
        w.total_ms
    )
}

/// Direct C-ABI entrypoint to run `WeVisOne-VL-2B` pure-vision grounding via `onnxruntime-genai`.
/// `spec_ptr` is TSV: `<task>\t<query>\t<target_w>\t<target_h>\t<roi_x>\t<roi_y>\t<roi_w>\t<roi_h>\t<max_visual_tokens>\t<foveated_refine:0|1>`
#[no_mangle]
pub unsafe extern "C" fn EtaComputerGroundWeVisOne(
    engine: *mut ComputerEngine,
    curr_rgb_ptr: *const u8,
    rgb_len: u64,
    width: u32,
    height: u32,
    spec_ptr: *const c_char,
) -> *mut c_char {
    if engine.is_null() || curr_rgb_ptr.is_null() || spec_ptr.is_null() {
        return ptr::null_mut();
    }
    let eng = &mut *engine;
    let curr_rgb = slice::from_raw_parts(curr_rgb_ptr, rgb_len as usize);
    let spec_str = CStr::from_ptr(spec_ptr).to_string_lossy();
    let parts: Vec<&str> = spec_str.lines().next().unwrap_or("").split('\t').collect();
    let task = parts.first().copied().unwrap_or("referring");
    let query = parts.get(1).copied().unwrap_or("");
    let target_w: usize = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let target_h: usize = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
    let roi = if parts.len() >= 8 {
        let rx: f32 = parts[4].parse().unwrap_or(0.0);
        let ry: f32 = parts[5].parse().unwrap_or(0.0);
        let rw: f32 = parts[6].parse().unwrap_or(0.0);
        let rh: f32 = parts[7].parse().unwrap_or(0.0);
        if rw > 0.0 && rh > 0.0 {
            Some(Rect {
                x: rx,
                y: ry,
                w: rw,
                h: rh,
            })
        } else {
            None
        }
    } else {
        None
    };
    // 512 visual tokens is native resolution for a 1920x1080 frame at 64px patches.
    // At the old default of 32 the screenshot was downsampled past readability and
    // grounding collapsed (ScreenSpot desktop: 0/12 vs 7/12 at 512).
    // 0 means "the caller has no opinion"; a literal 32 from the TS layer used to shadow the
    // default, which is why the budget silently stayed tiny.
    let max_visual_tokens: usize = parts
        .get(8)
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(512);
    let foveated_refine: bool = parts.get(9).map(|&s| s == "1").unwrap_or(false);

    let oga = match eng.ensure_wevisone_oga() {
        Ok(o) => o,
        Err(e) => {
            let err_json = format!("{{\"ok\":false,\"error\":\"{}\"}}", json_escape(&e));
            return CString::new(err_json).unwrap().into_raw();
        }
    };

    match oga.ground_with_options(
        curr_rgb,
        width as usize,
        height as usize,
        task,
        query,
        target_w,
        target_h,
        roi,
        max_visual_tokens,
        foveated_refine,
    ) {
        Ok(outcome) => {
            let inner = serialize_wevisone_outcome(&outcome);
            let json = format!("{{\"ok\":true,\"grounding\":{}}}", inner);
            CString::new(json).unwrap().into_raw()
        }
        Err(e) => {
            let err_json = format!("{{\"ok\":false,\"error\":\"{}\"}}", json_escape(&e));
            CString::new(err_json).unwrap().into_raw()
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn EtaComputerFreeString(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = CString::from_raw(ptr);
    }
}

#[no_mangle]
pub unsafe extern "C" fn EtaComputerDestroy(engine: *mut ComputerEngine) {
    if !engine.is_null() {
        let _ = Box::from_raw(engine);
    }
}
