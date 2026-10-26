//! Stage 5–7 Hybrid Symbolic-Latent UI-JEPA Forward Predictor
//! and OpenJev System-1 Calibrated Decision Engine.

use crate::fusion::{cosine_sim_64, token_overlap_score, FusionSnapshot};
use crate::ort_backend::EdgeModelTriad;
use crate::vision::{DirtyDiffResult, Rect};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransitionRegime {
    LocalPerturbation,
    StructuralRegimeShift,
}

#[derive(Clone, Debug)]
pub struct PlannedAction {
    pub action_type: String, // "click" | "type" | "scroll" | "hover" | "navigate"
    pub target_anchor_id: Option<u32>,
    pub target_label_hint: String,
    pub text_arg: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ExpectedStateDelta {
    pub regime: TransitionRegime,
    pub expected_focus_id: Option<u32>,
    pub expected_cursor: &'static str, // "arrow" | "ibeam" | "pointer"
    pub predicted_roi: Rect,
    pub target_embedding_prior: [f32; 64],
    pub expects_dropdown_or_popup: bool,
}

#[derive(Clone, Debug)]
pub struct SurpriseMetrics {
    pub structural_error: f32,
    pub roi_escape_error: f32,
    pub latent_residual: f32,
    pub total_surprise_energy: f32,
    pub dirty_roi_iou: f32,
    pub latent_cosine_sim: f32,
}

#[derive(Clone, Debug)]
pub struct JevDecisionOutcome {
    pub gate: &'static str, // "fast_commit" | "local_micro_correction" | "wait_settle" | "safety_intercept" | "slow_escalation"
    pub p_postcondition_met: f32,
    pub p_unexpected_blocker: f32,
    pub p_irreversible_risk: f32,
    pub goal_progress_score: f32,
    pub chosen_action: String,
    pub chosen_anchor_id: Option<u32>,
    pub chosen_bbox: Option<Rect>,
    pub chosen_probability: f32,
    pub confidence_margin: f32,
    pub surprise: SurpriseMetrics,
    pub jev_ort_ms: f64,
}

const DESTRUCTIVE_KEYWORDS: [&str; 10] = [
    "delete", "remove", "destroy", "pay", "purchase", "transfer", "format", "drop", "revoke", "wipe",
];

pub fn contains_destructive_keyword(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    DESTRUCTIVE_KEYWORDS.iter().any(|&kw| lower.contains(kw))
}

/// Stage 7: Predict the expected next UI state delta BEFORE injecting `action`.
pub fn predict_forward_delta(
    current: &FusionSnapshot,
    action: &PlannedAction,
    screen_w: f32,
    screen_h: f32,
) -> ExpectedStateDelta {
    let act = action.action_type.to_ascii_lowercase();
    let target_anchor = action
        .target_anchor_id
        .and_then(|id| current.active_anchors.iter().find(|a| a.persistent_id == id))
        .or_else(|| {
            if action.target_label_hint.is_empty() {
                None
            } else {
                let hint = action.target_label_hint.to_ascii_lowercase();
                current
                    .active_anchors
                    .iter()
                    .find(|a| a.label.to_ascii_lowercase().contains(&hint))
            }
        });

    if act == "scroll" || act == "navigate" {
        return ExpectedStateDelta {
            regime: TransitionRegime::StructuralRegimeShift,
            expected_focus_id: target_anchor.map(|a| a.persistent_id),
            expected_cursor: "arrow",
            predicted_roi: Rect {
                x: 0.0,
                y: 0.0,
                w: screen_w,
                h: screen_h,
            },
            target_embedding_prior: target_anchor.map(|a| a.embedding).unwrap_or([0.0; 64]),
            expects_dropdown_or_popup: false,
        };
    }

    if let Some(anchor) = target_anchor {
        let role = anchor.role.to_ascii_lowercase();
        let is_input = role.contains("input") || role.contains("textbox") || role.contains("search");
        let is_dropdown = role.contains("dropdown") || role.contains("combobox") || role.contains("menu");
        let is_nav_or_tab = role.contains("tab") || role.contains("link") || anchor.region == "sidebar";

        if is_nav_or_tab && act == "click" {
            return ExpectedStateDelta {
                regime: TransitionRegime::StructuralRegimeShift,
                expected_focus_id: Some(anchor.persistent_id),
                expected_cursor: "arrow",
                predicted_roi: Rect {
                    x: 0.0,
                    y: 0.0,
                    w: screen_w,
                    h: screen_h,
                },
                target_embedding_prior: anchor.embedding,
                expects_dropdown_or_popup: false,
            };
        }

        // Local perturbation: expand predicted active ROI around target (and below it for dropdowns/autocomplete)
        let pad_x = 36.0;
        let pad_top = 24.0;
        let pad_bottom = if is_dropdown || is_input { 220.0 } else { 48.0 };
        let rx = (anchor.bbox.x - pad_x).max(0.0);
        let ry = (anchor.bbox.y - pad_top).max(0.0);
        let rw = (anchor.bbox.w + pad_x * 2.0).min(screen_w - rx);
        let rh = (anchor.bbox.h + pad_top + pad_bottom).min(screen_h - ry);

        return ExpectedStateDelta {
            regime: TransitionRegime::LocalPerturbation,
            expected_focus_id: Some(anchor.persistent_id),
            expected_cursor: if is_input { "ibeam" } else { "pointer" },
            predicted_roi: Rect {
                x: rx,
                y: ry,
                w: rw,
                h: rh,
            },
            target_embedding_prior: anchor.embedding,
            expects_dropdown_or_popup: is_dropdown,
        };
    }

    ExpectedStateDelta {
        regime: TransitionRegime::LocalPerturbation,
        expected_focus_id: None,
        expected_cursor: "arrow",
        predicted_roi: Rect {
            x: 0.0,
            y: 0.0,
            w: screen_w,
            h: screen_h,
        },
        target_embedding_prior: [0.0; 64],
        expects_dropdown_or_popup: false,
    }
}

/// Stage 5 & 6: Compute UI-JEPA surprise metrics and run `openjev_system1.onnx` in a single forward pass.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_and_decide(
    triad: &mut EdgeModelTriad,
    subgoal: &str,
    next_step_hint: Option<&PlannedAction>,
    expected_delta: Option<&ExpectedStateDelta>,
    dirty: &DirtyDiffResult,
    fusion: &FusionSnapshot,
    actual_cursor: &str,
    stagnation_steps: u32,
    now_ms: u64,
) -> Result<JevDecisionOutcome, String> {
    // 1. Compute UI-JEPA Hybrid Symbolic-Latent Surprise Metrics
    let mut focus_matched = 1.0f32;
    let mut cursor_matched = 1.0f32;
    let mut dirty_roi_iou = 0.85f32;
    let mut latent_cosine_sim = 0.90f32;
    let mut structural_delta_score = 0.90f32;

    if let Some(exp) = expected_delta {
        cursor_matched = if actual_cursor.eq_ignore_ascii_case(exp.expected_cursor)
            || exp.expected_cursor == "pointer"
        {
            1.0
        } else {
            0.3
        };

        if let Some(exp_id) = exp.expected_focus_id {
            if let Some(target_now) = fusion
                .active_anchors
                .iter()
                .find(|a| a.persistent_id == exp_id)
            {
                focus_matched = if target_now.focused || dirty.action_onset_detected {
                    1.0
                } else {
                    0.2
                };
                latent_cosine_sim =
                    cosine_sim_64(&exp.target_embedding_prior, &target_now.embedding).clamp(0.0, 1.0);
            } else if exp.regime == TransitionRegime::LocalPerturbation {
                // Target anchor disappeared unexpectedly in a local perturbation!
                focus_matched = 0.0;
                structural_delta_score = 0.25;
            }
        }

        if exp.regime == TransitionRegime::StructuralRegimeShift || fusion.rigid_scroll_detected {
            dirty_roi_iou = 0.92;
            structural_delta_score = if !fusion.active_anchors.is_empty() {
                0.90
            } else {
                0.20
            };
        } else if let Some(u_dirty) = dirty.union_dirty {
            // Check how much of actual dirty rect stays inside predicted active ROI
            let inter_x1 = u_dirty.x.max(exp.predicted_roi.x);
            let inter_y1 = u_dirty.y.max(exp.predicted_roi.y);
            let inter_x2 = (u_dirty.x + u_dirty.w).min(exp.predicted_roi.x + exp.predicted_roi.w);
            let inter_y2 = (u_dirty.y + u_dirty.h).min(exp.predicted_roi.y + exp.predicted_roi.h);
            let inter_area = (inter_x2 - inter_x1).max(0.0) * (inter_y2 - inter_y1).max(0.0);
            let containment = (inter_area / u_dirty.area().max(1.0)).clamp(0.0, 1.0);
            dirty_roi_iou = containment;
        }
    }

    let unexpected_modal_flag = if fusion.modal_isolated
        && !expected_delta
            .map(|e| e.expects_dropdown_or_popup)
            .unwrap_or(false)
    {
        1.0f32
    } else {
        0.0f32
    };

    if unexpected_modal_flag > 0.5 {
        structural_delta_score = 0.0;
        focus_matched = 0.0;
        dirty_roi_iou = 0.05;
        latent_cosine_sim = 0.10;
    }

    let structural_error =
        1.0 - (0.45 * focus_matched + 0.45 * structural_delta_score + 0.10 * cursor_matched);
    let roi_escape_error = 1.0 - dirty_roi_iou;
    let latent_residual = (1.0 - latent_cosine_sim).max(0.0);
    let total_surprise_energy =
        0.45 * structural_error + 0.35 * roi_escape_error + 0.20 * latent_residual;

    let surprise = SurpriseMetrics {
        structural_error,
        roi_escape_error,
        latent_residual,
        total_surprise_energy,
        dirty_roi_iou,
        latent_cosine_sim,
    };

    // 2. Build Candidate Options & Run Real 151.4M Parameter OpenJev Verdict (`heman10x/rlcd-modernbert-151m`)
    let query_str = if let Some(hint) = next_step_hint {
        if !hint.target_label_hint.is_empty() {
            hint.target_label_hint.as_str()
        } else {
            subgoal
        }
    } else {
        subgoal
    };
    let query_lower = query_str.to_lowercase();
    let query_tokens: Vec<&str> = query_lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.chars().count() >= 2)
        .collect();

    let planned_id = next_step_hint.and_then(|h| h.target_anchor_id);
    let planned_act = next_step_hint
        .map(|h| h.action_type.to_ascii_lowercase())
        .unwrap_or_else(|| "click".to_string());

    let mut any_destructive_target = false;
    let mut ranked_anchors: Vec<(usize, f32)> = fusion
        .active_anchors
        .iter()
        .enumerate()
        .map(|(idx, a)| {
            let overlap = token_overlap_score(&a.label, &query_tokens);
            let id_bonus = if planned_id == Some(a.persistent_id) {
                2.0f32
            } else {
                0.0f32
            };
            (idx, overlap + id_bonus + a.confidence * 0.1)
        })
        .collect();
    ranked_anchors.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Select top 4 candidate anchors for the real 151M OpenJev GLiClass head + 1 explicit abstention slot
    // keeping total BPE sequence length <= 45 tokens (~25ms on CPU instead of 450ms!)
    let mut candidate_options: Vec<(String, Option<u32>, Option<Rect>, String, f32)> = Vec::new();
    for &(anchor_idx, _) in ranked_anchors.iter().take(4) {
        let anchor = &fusion.active_anchors[anchor_idx];
        let overlap = token_overlap_score(&anchor.label, &query_tokens);
        let id_match = if planned_id == Some(anchor.persistent_id)
            || (planned_id.is_none() && overlap >= 0.75)
        {
            1.0f32
        } else {
            0.0f32
        };

        let is_destructive = contains_destructive_keyword(&anchor.label);
        if is_destructive && (overlap > 0.4 || id_match > 0.5) {
            any_destructive_target = true;
        }

        // 300ms idempotency debounce lock against double-click hazard
        let debounce_locked =
            anchor.last_clicked_ms > 0 && now_ms.saturating_sub(anchor.last_clicked_ms) < 300;

        let role_lower = anchor.role.to_ascii_lowercase();
        let is_input = role_lower.contains("input")
            || role_lower.contains("textbox")
            || role_lower.contains("search");

        let act_verb = if planned_act == "type" && (is_input || id_match > 0.5 || overlap > 0.35) {
            "type"
        } else if planned_act == "scroll" {
            "scroll"
        } else if planned_act == "hover" {
            "hover"
        } else {
            "click"
        };

        let prior_logit_bias = if debounce_locked && act_verb == "click" {
            -15.0f32
        } else {
            id_match * 4.2 + overlap * 3.0
        };

        // Keep the label short: ModernBERT attention is quadratic in sequence length
        // (measured: 21ms @ 32 tokens, 36ms @ 64, 95ms @ 192).
        let short_label: String = anchor.label.chars().take(20).collect();
        let label_desc = format!("{} {}: {}", act_verb, anchor.role, short_label);
        candidate_options.push((
            format!("{}:#{}", act_verb, anchor.persistent_id),
            Some(anchor.persistent_id),
            Some(anchor.bbox),
            label_desc,
            prior_logit_bias,
        ));
    }

    // Append explicit OpenJev RLCD abstention option `__insufficient_evidence__` -> maps to `escalate_to_slow_vlm`
    let mut gliclass_labels: Vec<String> = candidate_options
        .iter()
        .map(|c| c.3.clone())
        .collect();
    gliclass_labels.push("__insufficient_evidence__".to_string());

    let jev_ort_ms = if let Some(ref bpe) = triad.bpe {
        let input_ids = bpe.encode_gliclass_prompt(&gliclass_labels, subgoal);
        triad.run_real_jev(&input_ids)?
    } else {
        0.0
    };

    // Extract real OpenJev logits & apply RLCD temperature scaling (T = 1.0716)
    let rlcd_temp = 1.0716f32;
    let num_cands = candidate_options.len();
    let abstain_raw_logit = triad.jev_out_logits25[num_cands.min(24)];

    let mut options: Vec<(String, Option<u32>, Option<Rect>, f32)> =
        Vec::with_capacity(num_cands + 2);
    for (slot_idx, cand) in candidate_options.into_iter().enumerate() {
        let model_logit = triad.jev_out_logits25[slot_idx.min(24)];
        let combined_logit = (model_logit + cand.4) / rlcd_temp;
        options.push((cand.0, cand.1, cand.2, combined_logit));
    }

    let cursor_is_wait = if actual_cursor.eq_ignore_ascii_case("wait")
        || actual_cursor.eq_ignore_ascii_case("progress")
    {
        1.0f32
    } else {
        0.0f32
    };
    let risk_score = if any_destructive_target || contains_destructive_keyword(subgoal) {
        1.0f32
    } else {
        0.0f32
    };

    // Sentinel: wait_settle
    let wait_logit = if cursor_is_wait > 0.5 || dirty.active_spinner_detected {
        12.0f32
    } else {
        -6.0f32
    };
    options.push(("wait_settle".to_string(), None, None, wait_logit));

    // Sentinel: escalate_to_slow_vlm (driven by real OpenJev `__insufficient_evidence__` logit + UI-JEPA surprise)
    let escalate_logit = (abstain_raw_logit
        + unexpected_modal_flag * 10.0
        + (stagnation_steps as f32) * 3.5)
        / rlcd_temp;
    options.push((
        "escalate_to_slow_vlm".to_string(),
        None,
        None,
        escalate_logit,
    ));

    // A misbehaving execution provider (INT8 on OpenVINO GPU does this) can return non-finite
    // logits, and a single NaN would poison every probability below it — and then the caller's JSON.
    if options.iter().any(|o| !o.3.is_finite()) {
        eprintln!("[eta-computer] non-finite verdict logit; treating it as abstain");
        for o in &mut options {
            if !o.3.is_finite() {
                o.3 = -6.0;
            }
        }
    }

    // Softmax over options
    let max_logit = options
        .iter()
        .map(|o| o.3)
        .fold(f32::NEG_INFINITY, f32::max);
    let mut sum_exp = 0.0f32;
    for o in &mut options {
        o.3 = (o.3 - max_logit).exp();
        sum_exp += o.3;
    }
    for o in &mut options {
        o.3 /= sum_exp.max(1e-8);
    }
    options.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));

    let best = options[0].clone();
    let second_prob = options.get(1).map(|o| o.3).unwrap_or(0.0);
    let confidence_margin = best.3 - second_prob;

    // Calibrated Noul & Score derived from UI-JEPA forward surprise + OpenJev abstention confidence
    let p_abstain = options
        .iter()
        .find(|o| o.0 == "escalate_to_slow_vlm")
        .map(|o| o.3)
        .unwrap_or(0.0);

    // A matched, confident anchor makes the model's abstention a weak signal — it abstains on
    // odd labels by design. Only an abstention with nothing to click is a real blocker.
    let has_live_target = best.1.is_some() && best.3 > 0.55 && unexpected_modal_flag < 0.5;
    let abstain_signal = if has_live_target {
        p_abstain * 0.15
    } else {
        p_abstain
    };

    let noul_post_logit = 3.2 * (1.0 - surprise.total_surprise_energy)
        - 4.5 * unexpected_modal_flag
        - 2.5 * abstain_signal
        + 1.2;
    let p_postcondition_met = 1.0 / (1.0 + (-noul_post_logit).exp());

    let effective_escape = if unexpected_modal_flag < 0.5 && has_live_target {
        surprise.roi_escape_error * 0.25
    } else {
        surprise.roi_escape_error
    };

    let noul_blocker_logit =
        4.8 * unexpected_modal_flag + 2.2 * effective_escape + 2.0 * abstain_signal - 3.0;
    let p_unexpected_blocker = 1.0 / (1.0 + (-noul_blocker_logit).exp());

    let noul_risk_logit = 6.0 * risk_score - 2.9;
    let p_irreversible_risk = 1.0 / (1.0 + (-noul_risk_logit).exp());

    let goal_progress_score = (1.0
        + 4.0 * p_postcondition_met * (1.0 - p_unexpected_blocker) * best.3.clamp(0.2, 1.0))
    .clamp(1.0, 5.0);

    // 7. Three-Tier Deterministic Gating
    let gate = if p_irreversible_risk > 0.35 {
        "safety_intercept"
    } else if best.0 == "wait_settle" || cursor_is_wait > 0.5 || dirty.active_spinner_detected {
        "wait_settle"
    } else if p_unexpected_blocker >= 0.25
        || p_postcondition_met < 0.40
        || best.0 == "escalate_to_slow_vlm"
        || stagnation_steps >= 2
    {
        "slow_escalation"
    } else if let Some(chosen_id) = best.1 {
        let moved = fusion
            .active_anchors
            .iter()
            .find(|a| a.persistent_id == chosen_id)
            .map(|a| a.moved_delta.0.abs() > 4.0 || a.moved_delta.1.abs() > 4.0)
            .unwrap_or(false);
        if moved {
            "local_micro_correction"
        } else {
            "fast_commit"
        }
    } else {
        "fast_commit"
    };

    Ok(JevDecisionOutcome {
        gate,
        p_postcondition_met,
        p_unexpected_blocker,
        p_irreversible_risk,
        goal_progress_score,
        chosen_action: best.0,
        chosen_anchor_id: best.1,
        chosen_bbox: best.2,
        chosen_probability: best.3,
        confidence_margin,
        surprise,
        jev_ort_ms,
    })
}

impl DirtyDiffResult {
    pub fn action_onset_observed(&self) -> bool {
        self.action_onset_detected
    }
}
