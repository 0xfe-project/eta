//! Stage 4 Multi-Modal Anchor Fusion, Rigid-Body Scroll Compensation,
//! Persistent Anchor Tracking (#1..#N across frames), and Foveated Region Folding.

use std::collections::HashMap;
use crate::vision::{Rect, VisualLandmark};

#[derive(Clone, Debug)]
pub struct StructuralNodeInput {
    pub role: String,
    pub label: String,
    pub bbox: Rect,
    pub focused: bool,
    pub enabled: bool,
    pub region: String, // e.g., "header", "sidebar", "main", "modal", "form"
    pub z_layer: i32,   // 0 = normal, 1+ = modal/dialog overlay
}

#[derive(Clone, Debug)]
pub struct FusedAnchor {
    pub persistent_id: u32,
    pub role: String,
    pub label: String,
    pub bbox: Rect,
    pub region: String,
    pub focused: bool,
    pub enabled: bool,
    pub z_layer: i32,
    pub confidence: f32,
    pub embedding: [f32; 64],
    pub semantic_hash: u64,
    pub last_clicked_ms: u64,
    pub moved_delta: (f32, f32),
}

#[derive(Clone, Debug)]
pub struct CollapsedRegionSummary {
    pub region: String,
    pub item_count: usize,
    pub sample_labels: String,
    pub bbox: Rect,
}

#[derive(Clone, Debug)]
pub struct FusionSnapshot {
    pub active_anchors: Vec<FusedAnchor>,
    pub collapsed_regions: Vec<CollapsedRegionSummary>,
    pub rigid_scroll_detected: bool,
    pub rigid_scroll_delta: (f32, f32),
    pub modal_isolated: bool,
    pub newly_added_count: usize,
    pub retained_id_count: usize,
}

pub fn fnv1a_str(text: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.bytes() {
        h ^= b.to_ascii_lowercase() as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

pub fn cosine_sim_64(a: &[f32; 64], b: &[f32; 64]) -> f32 {
    let mut dot = 0.0f32;
    for i in 0..64 {
        dot += a[i] * b[i];
    }
    dot.clamp(-1.0, 1.0)
}

pub struct PersistentAnchorTracker {
    next_id: u32,
    pub registry: HashMap<u32, FusedAnchor>,
}

impl PersistentAnchorTracker {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            registry: HashMap::new(),
        }
    }

    pub fn mark_clicked(&mut self, anchor_id: u32, now_ms: u64) {
        if let Some(entry) = self.registry.get_mut(&anchor_id) {
            entry.last_clicked_ms = now_ms;
        }
    }

    /// Fuse structural A11y/CDP nodes with ONNX visual landmarks, detect rigid-body scroll,
    /// assign persistent IDs (`#1..#N`), isolate top-layer modals, and apply foveated folding.
    pub fn fuse_and_track(
        &mut self,
        structural_nodes: &[StructuralNodeInput],
        visual_landmarks: &[VisualLandmark],
        subgoal: &str,
        max_active_anchors: usize,
    ) -> FusionSnapshot {
        // 1. IoU Fusion between structural nodes and ONNX visual landmarks
        let mut used_visual = vec![false; visual_landmarks.len()];
        let mut raw_fused: Vec<FusedAnchor> = Vec::new();

        for snode in structural_nodes {
            if !snode.enabled {
                continue;
            }
            // Find best overlapping visual landmark (IoU >= 0.20)
            // Find best overlapping or contained visual landmark (IoU or IoMin)
            let mut best_v_idx: Option<usize> = None;
            let mut best_overlap = 0.15f32;
            for (v_idx, vlm) in visual_landmarks.iter().enumerate() {
                let iou = snode.bbox.iou(&vlm.bbox);
                let iomin = snode.bbox.io_min(&vlm.bbox);
                if iou > 0.05 || iomin > 0.45 {
                    used_visual[v_idx] = true;
                }
                let score = iou.max(iomin * 0.8);
                if score > best_overlap {
                    best_overlap = score;
                    best_v_idx = Some(v_idx);
                }
            }

            let (embedding, confidence, label) = if let Some(vi) = best_v_idx {
                used_visual[vi] = true;
                let v = &visual_landmarks[vi];
                let lbl = if !snode.label.trim().is_empty() {
                    snode.label.clone()
                } else {
                    v.ocr_text.clone().unwrap_or_else(|| v.class_name.to_string())
                };
                (v.embedding, v.confidence.max(0.85), lbl)
            } else {
                // Structural node without visual landmark match: synthesize deterministic embedding from role+label
                let mut synth = [0.0f32; 64];
                let h = fnv1a_str(&format!("{}:{}", snode.role, snode.label));
                let mut norm_sq = 0.0f32;
                for i in 0..64 {
                    let bit = ((h.rotate_left(i as u32)) & 0xff) as f32 / 255.0 - 0.5;
                    synth[i] = bit;
                    norm_sq += bit * bit;
                }
                let inv = 1.0 / (norm_sq + 1e-8).sqrt();
                for i in 0..64 {
                    synth[i] *= inv;
                }
                (synth, 0.80, snode.label.clone())
            };

            let sem_hash = fnv1a_str(&format!(
                "{}:{}:{}",
                snode.region,
                snode.role.to_ascii_lowercase(),
                label.trim().to_ascii_lowercase()
            ));

            raw_fused.push(FusedAnchor {
                persistent_id: 0,
                role: snode.role.clone(),
                label,
                bbox: snode.bbox,
                region: if snode.region.is_empty() {
                    "main".to_string()
                } else {
                    snode.region.clone()
                },
                focused: snode.focused,
                enabled: snode.enabled,
                z_layer: snode.z_layer,
                confidence,
                embedding,
                semantic_hash: sem_hash,
                last_clicked_ms: 0,
                moved_delta: (0.0, 0.0),
            });
        }

        // Append unmatched visual-only landmarks (e.g. custom canvas icons / buttons missing from A11y)
        for (v_idx, vlm) in visual_landmarks.iter().enumerate() {
            if used_visual[v_idx] {
                continue;
            }
            let label = vlm
                .ocr_text
                .clone()
                .unwrap_or_else(|| vlm.class_name.to_string());
            let sem_hash = fnv1a_str(&format!("visual:{}:{}", vlm.class_name, label));
            raw_fused.push(FusedAnchor {
                persistent_id: 0,
                role: vlm.class_name.to_string(),
                label,
                bbox: vlm.bbox,
                region: "main".to_string(),
                focused: false,
                enabled: true,
                z_layer: 0,
                confidence: vlm.confidence,
                embedding: vlm.embedding,
                semantic_hash: sem_hash,
                last_clicked_ms: 0,
                moved_delta: (0.0, 0.0),
            });
        }

        // 2. Detect Rigid-Body Scroll / Translation across frames via unique semantic_hash matching
        let mut displacement_votes: Vec<(f32, f32)> = Vec::new();
        for cand in raw_fused.iter().take(structural_nodes.len()) {
            if cand.label.is_empty() {
                continue;
            }
            if let Some(prev) = self
                .registry
                .values()
                .find(|p| p.semantic_hash == cand.semantic_hash)
            {
                let (cx1, cy1) = prev.bbox.center();
                let (cx2, cy2) = cand.bbox.center();
                let dx = cx2 - cx1;
                let dy = cy2 - cy1;
                if dx.abs() > 2.0 || dy.abs() > 2.0 {
                    displacement_votes.push((dx, dy));
                }
            }
        }

        let (rigid_scroll_detected, rigid_scroll_delta) = if displacement_votes.len() >= 3 {
            // Compute median displacement vector
            let mut dxs: Vec<f32> = displacement_votes.iter().map(|v| v.0).collect();
            let mut dys: Vec<f32> = displacement_votes.iter().map(|v| v.1).collect();
            dxs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            dys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let med_dx = dxs[dxs.len() / 2];
            let med_dy = dys[dys.len() / 2];
            let coherent = displacement_votes
                .iter()
                .filter(|(dx, dy)| (dx - med_dx).abs() < 16.0 && (dy - med_dy).abs() < 16.0)
                .count();
            if coherent * 2 >= displacement_votes.len() && (med_dx.abs() >= 8.0 || med_dy.abs() >= 8.0)
            {
                (true, (med_dx, med_dy))
            } else {
                (false, (0.0, 0.0))
            }
        } else {
            (false, (0.0, 0.0))
        };

        // 3. Persistent Anchor ID Assignment (match existing IDs across layout shift / scroll)
        let mut assigned_prev_ids = std::collections::HashSet::new();
        let mut retained_id_count = 0usize;
        let mut newly_added_count = 0usize;

        for cand in &mut raw_fused {
            let mut best_id: Option<u32> = None;
            let mut best_match_score = 0.55f32;

            for (&pid, prev) in &self.registry {
                if assigned_prev_ids.contains(&pid) {
                    continue;
                }
                let exact_sem = prev.semantic_hash == cand.semantic_hash && !cand.label.is_empty();
                let role_match = prev.role.eq_ignore_ascii_case(&cand.role);
                if !exact_sem && !role_match {
                    continue;
                }

                // Motion-compensated previous bbox
                let expected_prev_box = Rect {
                    x: prev.bbox.x + rigid_scroll_delta.0,
                    y: prev.bbox.y + rigid_scroll_delta.1,
                    w: prev.bbox.w,
                    h: prev.bbox.h,
                };
                let iou = cand.bbox.iou(&expected_prev_box);
                let (cx1, cy1) = expected_prev_box.center();
                let (cx2, cy2) = cand.bbox.center();
                let center_dist = ((cx2 - cx1).powi(2) + (cy2 - cy1).powi(2)).sqrt();
                let spatial_sim = (1.0 - center_dist / 360.0).max(0.0);
                let emb_sim = cosine_sim_64(&prev.embedding, &cand.embedding).max(0.0);

                let score = if exact_sem {
                    0.65 + 0.20 * spatial_sim.max(iou) + 0.15 * emb_sim
                } else {
                    0.45 * iou + 0.35 * emb_sim + 0.20 * spatial_sim
                };

                if score > best_match_score {
                    best_match_score = score;
                    best_id = Some(pid);
                }
            }

            if let Some(pid) = best_id {
                assigned_prev_ids.insert(pid);
                let prev = &self.registry[&pid];
                let (cx1, cy1) = prev.bbox.center();
                let (cx2, cy2) = cand.bbox.center();
                cand.persistent_id = pid;
                cand.last_clicked_ms = prev.last_clicked_ms;
                cand.moved_delta = (cx2 - cx1, cy2 - cy1);
                retained_id_count += 1;
            } else {
                let pid = self.next_id;
                self.next_id += 1;
                cand.persistent_id = pid;
                newly_added_count += 1;
            }
        }

        // Inherit semantic labels grounded previously on the same persistent anchor ID
        // when the current visual-only pass produced only a generic class name.
        for cand in &mut raw_fused {
            if let Some(prev) = self.registry.get(&cand.persistent_id) {
                let is_generic = cand.label.is_empty()
                    || cand.label.eq_ignore_ascii_case(&cand.role)
                    || cand.label == "icon_generic"
                    || cand.label == "button"
                    || cand.label == "input";
                let prev_has_semantic = !prev.label.is_empty()
                    && !prev.label.eq_ignore_ascii_case(&prev.role)
                    && prev.label != "icon_generic";
                if is_generic && prev_has_semantic {
                    cand.label = prev.label.clone();
                    cand.semantic_hash = prev.semantic_hash;
                }
            }
        }

        // Update registry with latest anchor coordinates
        for cand in &raw_fused {
            self.registry.insert(cand.persistent_id, cand.clone());
        }

        // 4. Top-Layer Z-Plane Modal Isolation:
        // If any anchor is on z_layer > 0 (modal/alert dialog), isolate top layer or prioritize it
        let max_z = raw_fused.iter().map(|a| a.z_layer).max().unwrap_or(0);
        let modal_isolated = max_z > 0;
        let working_set: Vec<FusedAnchor> = if modal_isolated {
            raw_fused.into_iter().filter(|a| a.z_layer == max_z).collect()
        } else {
            raw_fused
        };

        // 5. Hierarchical Foveated Folding when candidate count exceeds `max_active_anchors`
        let cap = max_active_anchors.clamp(8, 64);
        if working_set.len() <= cap {
            return FusionSnapshot {
                active_anchors: working_set,
                collapsed_regions: Vec::new(),
                rigid_scroll_detected,
                rigid_scroll_delta,
                modal_isolated,
                newly_added_count,
                retained_id_count,
            };
        }

        let subgoal_lower = subgoal.to_ascii_lowercase();
        let subgoal_tokens: Vec<&str> = subgoal_lower
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| s.len() >= 2)
            .collect();

        // Group by macro-region and score each region's relevance to the subgoal
        let mut region_groups: HashMap<String, Vec<FusedAnchor>> = HashMap::new();
        for a in working_set {
            region_groups.entry(a.region.clone()).or_default().push(a);
        }

        let mut scored_regions: Vec<(String, f32, Vec<FusedAnchor>)> = region_groups
            .into_iter()
            .map(|(reg, items)| {
                let mut rel_score = 0.0f32;
                let reg_lower = reg.to_ascii_lowercase();
                if reg_lower.contains("modal") || reg_lower.contains("dialog") {
                    rel_score += 100.0;
                }
                for item in &items {
                    if item.focused {
                        rel_score += 20.0;
                    }
                    let lbl = item.label.to_ascii_lowercase();
                    for &tok in &subgoal_tokens {
                        if lbl.contains(tok) || reg_lower.contains(tok) {
                            rel_score += 4.0;
                        }
                    }
                }
                (reg, rel_score, items)
            })
            .collect();

        scored_regions.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut active_anchors: Vec<FusedAnchor> = Vec::with_capacity(cap);
        let mut collapsed_regions: Vec<CollapsedRegionSummary> = Vec::new();

        for (reg, _score, mut items) in scored_regions {
            if active_anchors.len() < cap {
                let remaining = cap - active_anchors.len();
                if items.len() <= remaining {
                    active_anchors.extend(items);
                } else {
                    // Sort items inside region by token overlap with subgoal
                    items.sort_by(|a, b| {
                        let sa = token_overlap_score(&a.label, &subgoal_tokens);
                        let sb = token_overlap_score(&b.label, &subgoal_tokens);
                        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
                    });
                    let overflow: Vec<FusedAnchor> = items.split_off(remaining);
                    active_anchors.extend(items);
                    collapsed_regions.push(summarize_region(&reg, &overflow));
                }
            } else {
                collapsed_regions.push(summarize_region(&reg, &items));
            }
        }

        FusionSnapshot {
            active_anchors,
            collapsed_regions,
            rigid_scroll_detected,
            rigid_scroll_delta,
            modal_isolated,
            newly_added_count,
            retained_id_count,
        }
    }

    /// Inject or enrich a persistent anchor from a WeVisOne-VL-2B pure-vision grounding result
    /// so subsequent System-1 steps track it at ~15ms via its 64d visual embedding and spatial IoU.
    pub fn upsert_grounded_anchor(
        &mut self,
        fusion: &mut FusionSnapshot,
        label: &str,
        bbox: Rect,
        point: (f32, f32),
    ) -> FusedAnchor {
        let mut best_idx: Option<usize> = None;
        let mut best_score = 0.15f32;
        for (idx, a) in fusion.active_anchors.iter().enumerate() {
            let iou = a.bbox.iou(&bbox);
            let contains = point.0 >= a.bbox.x
                && point.0 <= a.bbox.x + a.bbox.w
                && point.1 >= a.bbox.y
                && point.1 <= a.bbox.y + a.bbox.h;
            let score = if contains { iou.max(0.75) } else { iou };
            if score > best_score {
                best_score = score;
                best_idx = Some(idx);
            }
        }

        let sem_hash = fnv1a_str(&format!("grounded:{}", label.trim().to_ascii_lowercase()));

        if let Some(idx) = best_idx {
            let anchor = &mut fusion.active_anchors[idx];
            anchor.label = label.to_string();
            anchor.semantic_hash = sem_hash;
            anchor.confidence = anchor.confidence.max(0.95);
            if bbox.w > 8.0 && bbox.h > 8.0 && best_score < 0.80 {
                anchor.bbox = bbox;
            }
            let updated = anchor.clone();
            self.registry.insert(updated.persistent_id, updated.clone());
            return updated;
        }

        let pid = self.next_id;
        self.next_id += 1;
        let mut synth = [0.0f32; 64];
        let mut norm_sq = 0.0f32;
        for i in 0..64 {
            let bit = ((sem_hash.rotate_left(i as u32)) & 0xff) as f32 / 255.0 - 0.5;
            synth[i] = bit;
            norm_sq += bit * bit;
        }
        let inv = 1.0 / (norm_sq + 1e-8).sqrt();
        for i in 0..64 {
            synth[i] *= inv;
        }

        let created = FusedAnchor {
            persistent_id: pid,
            role: "button".to_string(),
            label: label.to_string(),
            bbox,
            region: "main".to_string(),
            focused: false,
            enabled: true,
            z_layer: 0,
            confidence: 0.96,
            embedding: synth,
            semantic_hash: sem_hash,
            last_clicked_ms: 0,
            moved_delta: (0.0, 0.0),
        };
        self.registry.insert(pid, created.clone());
        fusion.active_anchors.push(created.clone());
        created
    }
}

pub fn token_overlap_score(text: &str, query_tokens: &[&str]) -> f32 {
    if query_tokens.is_empty() || text.is_empty() {
        return 0.0;
    }
    let lower = text.to_lowercase();
    let mut matched = 0.0f32;
    for &t in query_tokens {
        let t_low = t.to_lowercase();
        if lower.contains(&t_low) {
            matched += 1.0;
        } else if t_low.contains(&lower) && lower.chars().count() >= 2 {
            matched += 0.85;
        }
    }
    (matched / (query_tokens.len() as f32)).clamp(0.0, 1.0)
}

fn summarize_region(region: &str, items: &[FusedAnchor]) -> CollapsedRegionSummary {
    let bbox = items
        .iter()
        .map(|a| a.bbox)
        .reduce(|a, b| a.union(&b))
        .unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        });
    let sample_labels = items
        .iter()
        .filter(|a| !a.label.is_empty())
        .take(4)
        .map(|a| a.label.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    CollapsedRegionSummary {
        region: region.to_string(),
        item_count: items.len(),
        sample_labels,
        bbox,
    }
}
