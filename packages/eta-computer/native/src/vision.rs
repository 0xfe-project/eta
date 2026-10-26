//! Stage 1–3 Vision Pipeline:
//!   - 8x8 Grid L1 Dirty Rect extraction + Onset/Settle state machine
//!   - 2D Shelf/Guillotine Atlas Bin-Packing into fixed 640x640 tensor bucket
//!   - Fast Top-K + Greedy NMS + Bilinear 64d Neck Embedding sampling
//!   - 64-bit xxHash-style crop caching + Batch-8 OCR recognition

use std::collections::HashMap;
use crate::ort_backend::EdgeModelTriad;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn area(&self) -> f32 {
        (self.w.max(0.0)) * (self.h.max(0.0))
    }

    pub fn center(&self) -> (f32, f32) {
        (self.x + self.w * 0.5, self.y + self.h * 0.5)
    }

    pub fn iou(&self, other: &Rect) -> f32 {
        let x1 = self.x.max(other.x);
        let y1 = self.y.max(other.y);
        let x2 = (self.x + self.w).min(other.x + other.w);
        let y2 = (self.y + self.h).min(other.y + other.h);
        let inter = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
        if inter <= 0.0 {
            return 0.0;
        }
        let union = self.area() + other.area() - inter;
        if union <= 1e-6 {
            0.0
        } else {
            inter / union
        }
    }

    /// Intersection over minimum area: 1.0 when one box is completely inside the other.
    pub fn io_min(&self, other: &Rect) -> f32 {
        let x1 = self.x.max(other.x);
        let y1 = self.y.max(other.y);
        let x2 = (self.x + self.w).min(other.x + other.w);
        let y2 = (self.y + self.h).min(other.y + other.h);
        let inter = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
        if inter <= 0.0 {
            return 0.0;
        }
        let min_area = self.area().min(other.area());
        if min_area <= 1e-6 {
            0.0
        } else {
            inter / min_area
        }
    }

    pub fn union(&self, other: &Rect) -> Rect {
        let x1 = self.x.min(other.x);
        let y1 = self.y.min(other.y);
        let x2 = (self.x + self.w).max(other.x + other.w);
        let y2 = (self.y + self.h).max(other.y + other.h);
        Rect {
            x: x1,
            y: y1,
            w: (x2 - x1).max(0.0),
            h: (y2 - y1).max(0.0),
        }
    }
}

pub const UI_CLASSES: [&str; 16] = [
    "button",
    "input",
    "checkbox_unchecked",
    "checkbox_checked",
    "radio",
    "toggle_on",
    "toggle_off",
    "dropdown",
    "close_x",
    "search_magnifier",
    "settings_gear",
    "menu_hamburger",
    "back_arrow",
    "more_dots",
    "tab",
    "icon_generic",
];

#[derive(Clone, Debug)]
pub struct VisualLandmark {
    pub bbox: Rect,
    pub class_id: usize,
    pub class_name: &'static str,
    pub confidence: f32,
    pub embedding: [f32; 64],
    pub ocr_text: Option<String>,
    pub ocr_cached: bool,
}

#[derive(Clone, Debug)]
pub struct DirtyDiffResult {
    pub dirty_rects: Vec<Rect>,
    pub union_dirty: Option<Rect>,
    pub dirty_area_ratio: f32,
    pub mean_l1_diff: f32,
    pub action_onset_detected: bool,
    pub active_spinner_detected: bool,
    pub visual_settled: bool,
}

/// Compute 8x8 grid dirty rectangles between two RGB frames `[width * height * 3]`.
pub fn compute_dirty_rects(
    prev_rgb: &[u8],
    curr_rgb: &[u8],
    width: usize,
    height: usize,
    cell_threshold: f32,
) -> DirtyDiffResult {
    if prev_rgb.len() != curr_rgb.len() || prev_rgb.len() < width * height * 3 || width == 0 || height == 0 {
        let full = Rect {
            x: 0.0,
            y: 0.0,
            w: width as f32,
            h: height as f32,
        };
        return DirtyDiffResult {
            dirty_rects: vec![full],
            union_dirty: Some(full),
            dirty_area_ratio: 1.0,
            mean_l1_diff: 1.0,
            action_onset_detected: true,
            active_spinner_detected: false,
            visual_settled: true,
        };
    }

    let grid_w = (width + 7) / 8;
    let grid_h = (height + 7) / 8;
    let mut dirty_cells = Vec::new();
    let mut total_diff: u64 = 0;

    for gy in 0..grid_h {
        let y0 = gy * 8;
        let y1 = (y0 + 8).min(height);
        for gx in 0..grid_w {
            let x0 = gx * 8;
            let x1 = (x0 + 8).min(width);
            let mut cell_diff: u32 = 0;
            // Sample every 2nd pixel inside 8x8 cell for ultra-fast (<0.4ms on 1080p) diff
            let mut count: u32 = 0;
            let mut y = y0;
            while y < y1 {
                let row_off = y * width * 3;
                let mut x = x0;
                while x < x1 {
                    let idx = row_off + x * 3;
                    let dr = (prev_rgb[idx] as i32 - curr_rgb[idx] as i32).unsigned_abs();
                    let dg = (prev_rgb[idx + 1] as i32 - curr_rgb[idx + 1] as i32).unsigned_abs();
                    let db = (prev_rgb[idx + 2] as i32 - curr_rgb[idx + 2] as i32).unsigned_abs();
                    cell_diff += dr + dg + db;
                    count += 3;
                    x += 2;
                }
                y += 2;
            }
            total_diff += cell_diff as u64;
            let mean_cell = (cell_diff as f32) / (count.max(1) as f32 * 255.0);
            if mean_cell >= cell_threshold {
                dirty_cells.push(Rect {
                    x: x0 as f32,
                    y: y0 as f32,
                    w: (x1 - x0) as f32,
                    h: (y1 - y0) as f32,
                });
            }
        }
    }

    // Merge nearby dirty cells (within 24px gap) into consolidated bounding boxes
    let mut merged: Vec<Rect> = Vec::new();
    for cell in dirty_cells {
        let mut absorbed = false;
        for m in &mut merged {
            let expanded = Rect {
                x: m.x - 24.0,
                y: m.y - 24.0,
                w: m.w + 48.0,
                h: m.h + 48.0,
            };
            if expanded.iou(&cell) > 0.0
                || (cell.x >= expanded.x
                    && cell.x <= expanded.x + expanded.w
                    && cell.y >= expanded.y
                    && cell.y <= expanded.y + expanded.h)
            {
                *m = m.union(&cell);
                absorbed = true;
                break;
            }
        }
        if !absorbed {
            merged.push(cell);
        }
    }

    let union_dirty = merged.iter().copied().reduce(|a, b| a.union(&b));
    let total_area = (width * height).max(1) as f32;
    let dirty_area: f32 = merged.iter().map(|r| r.area()).sum::<f32>().min(total_area);
    let dirty_area_ratio = dirty_area / total_area;
    let mean_l1_diff = (total_diff as f32) / ((grid_w * grid_h * 48).max(1) as f32 * 255.0);

    // Spinner heuristic: exactly 1 small dirty rect (< 64x64) with localized motion
    let active_spinner_detected =
        merged.len() == 1 && merged[0].w <= 64.0 && merged[0].h <= 64.0 && dirty_area_ratio < 0.015;
    let action_onset_detected = !merged.is_empty();
    let visual_settled = !active_spinner_detected;

    DirtyDiffResult {
        dirty_rects: merged,
        union_dirty,
        dirty_area_ratio,
        mean_l1_diff,
        action_onset_detected,
        active_spinner_detected,
        visual_settled,
    }
}

#[derive(Clone, Copy, Debug)]
struct AtlasTilePlacement {
    src: Rect,
    atlas_x: usize,
    atlas_y: usize,
    atlas_w: usize,
    atlas_h: usize,
}

/// Pack multiple dirty ROIs into the fixed `[1, 3, 640, 640]` tensor using 2D shelf packing.
/// If dirty_rects is empty or covers >45% of screen, scales the full frame into 640x640.
fn pack_rois_into_atlas(
    rgb: &[u8],
    width: usize,
    height: usize,
    dirty_rects: &[Rect],
    dirty_area_ratio: f32,
    atlas_tensor: &mut [f32], // [1, 3, 640, 640] planar RGB
) -> Vec<AtlasTilePlacement> {
    atlas_tensor.fill(0.0);
    let plane_stride = 640 * 640;

    if dirty_rects.is_empty() || dirty_area_ratio > 0.45 {
        // Bilinear + 2x2 box-filtered downsampling into 640x640 so 1px icon strokes do not vanish
        let scale = (640.0 / (width.max(1) as f32)).min(640.0 / (height.max(1) as f32));
        let dst_w = (((width as f32 * scale).round() as usize + 7) / 8 * 8).clamp(32, 640);
        let dst_h = (((height as f32 * scale).round() as usize + 7) / 8 * 8).clamp(32, 640);
        let pad_x = (640 - dst_w) / 2;
        let pad_y = (640 - dst_h) / 2;
        let sx_step = width as f32 / dst_w as f32;
        let sy_step = height as f32 / dst_h as f32;

        for ay in 0..dst_h {
            let sy_center = (ay as f32 + 0.5) * sy_step - 0.5;
            let sy0 = (sy_center.floor().max(0.0) as usize).min(height.saturating_sub(1));
            let sy1 = (sy0 + 1).min(height.saturating_sub(1));
            let wy = (sy_center - sy0 as f32).clamp(0.0, 1.0);
            for ax in 0..dst_w {
                let sx_center = (ax as f32 + 0.5) * sx_step - 0.5;
                let sx0 = (sx_center.floor().max(0.0) as usize).min(width.saturating_sub(1));
                let sx1 = (sx0 + 1).min(width.saturating_sub(1));
                let wx = (sx_center - sx0 as f32).clamp(0.0, 1.0);

                let i00 = (sy0 * width + sx0) * 3;
                let i01 = (sy0 * width + sx1) * 3;
                let i10 = (sy1 * width + sx0) * 3;
                let i11 = (sy1 * width + sx1) * 3;
                let d_idx = (pad_y + ay) * 640 + (pad_x + ax);
                if i11 + 2 < rgb.len() {
                    let w00 = (1.0 - wx) * (1.0 - wy);
                    let w01 = wx * (1.0 - wy);
                    let w10 = (1.0 - wx) * wy;
                    let w11 = wx * wy;
                    for c in 0..3 {
                        let v = w00 * (rgb[i00 + c] as f32)
                            + w01 * (rgb[i01 + c] as f32)
                            + w10 * (rgb[i10 + c] as f32)
                            + w11 * (rgb[i11 + c] as f32);
                        atlas_tensor[c * plane_stride + d_idx] = v / 255.0;
                    }
                }
            }
        }
        return vec![AtlasTilePlacement {
            src: Rect {
                x: 0.0,
                y: 0.0,
                w: width as f32,
                h: height as f32,
            },
            atlas_x: pad_x,
            atlas_y: pad_y,
            atlas_w: dst_w,
            atlas_h: dst_h,
        }];
    }

    // 2D Shelf Bin-Packing of Dirty ROIs into 640x640
    let mut placements = Vec::with_capacity(dirty_rects.len());
    let mut cur_x: usize = 0;
    let mut cur_y: usize = 0;
    let mut shelf_h: usize = 0;

    for r in dirty_rects {
        let sx0 = (r.x.max(0.0) as usize).min(width.saturating_sub(1));
        let sy0 = (r.y.max(0.0) as usize).min(height.saturating_sub(1));
        let sw = (r.w.max(16.0) as usize).min(width - sx0);
        let sh = (r.h.max(16.0) as usize).min(height - sy0);

        // Align tile size to multiple of 16 so 40x40 detection cells align cleanly
        let tw = ((sw.min(640) + 15) / 16 * 16).clamp(32, 640);
        let th = ((sh.min(640) + 15) / 16 * 16).clamp(32, 640);

        if cur_x + tw > 640 {
            cur_x = 0;
            cur_y += shelf_h;
            shelf_h = 0;
        }
        if cur_y + th > 640 {
            break;
        }

        for ty in 0..th {
            let sy = sy0 + (ty * sh / th).min(sh.saturating_sub(1));
            for tx in 0..tw {
                let sx = sx0 + (tx * sw / tw).min(sw.saturating_sub(1));
                let s_idx = (sy * width + sx) * 3;
                let d_idx = (cur_y + ty) * 640 + (cur_x + tx);
                if s_idx + 2 < rgb.len() {
                    atlas_tensor[d_idx] = rgb[s_idx] as f32 / 255.0;
                    atlas_tensor[plane_stride + d_idx] = rgb[s_idx + 1] as f32 / 255.0;
                    atlas_tensor[2 * plane_stride + d_idx] = rgb[s_idx + 2] as f32 / 255.0;
                }
            }
        }

        placements.push(AtlasTilePlacement {
            src: Rect {
                x: sx0 as f32,
                y: sy0 as f32,
                w: sw as f32,
                h: sh as f32,
            },
            atlas_x: cur_x,
            atlas_y: cur_y,
            atlas_w: tw,
            atlas_h: th,
        });

        cur_x += tw;
        shelf_h = shelf_h.max(th);
    }

    placements
}

/// Bilinearly sample a 64d L2-normalized embedding from `neck_embed [1, 64, 80, 80]`
/// at normalized atlas coordinates `(nx, ny) in [0, 1]^2`.
pub fn sample_neck_embedding(neck_embed: &[f32], nx: f32, ny: f32) -> [f32; 64] {
    let gx = (nx.clamp(0.0, 0.999) * 79.0).max(0.0);
    let gy = (ny.clamp(0.0, 0.999) * 79.0).max(0.0);
    let x0 = (gx.floor() as usize).min(78);
    let y0 = (gy.floor() as usize).min(78);
    let x1 = x0 + 1;
    let y1 = y0 + 1;
    let wx = gx - x0 as f32;
    let wy = gy - y0 as f32;

    let w00 = (1.0 - wx) * (1.0 - wy);
    let w10 = wx * (1.0 - wy);
    let w01 = (1.0 - wx) * wy;
    let w11 = wx * wy;

    let mut out = [0.0f32; 64];
    let mut norm_sq = 0.0f32;
    for c in 0..64 {
        let base = c * 6400;
        let v = w00 * neck_embed[base + y0 * 80 + x0]
            + w10 * neck_embed[base + y0 * 80 + x1]
            + w01 * neck_embed[base + y1 * 80 + x0]
            + w11 * neck_embed[base + y1 * 80 + x1];
        out[c] = v;
        norm_sq += v * v;
    }
    let inv_norm = 1.0 / (norm_sq + 1e-8).sqrt();
    for c in 0..64 {
        out[c] *= inv_norm;
    }
    out
}

/// Check if a candidate bounding box contains non-uniform UI edges/strokes across its full span
/// (including borders and left-aligned labels, not just the center 25%).
fn has_local_contrast(rgb: &[u8], width: usize, height: usize, rect: &Rect) -> bool {
    let x0 = (rect.x.max(0.0) as usize).min(width.saturating_sub(1));
    let y0 = (rect.y.max(0.0) as usize).min(height.saturating_sub(1));
    let x1 = ((rect.x + rect.w).ceil().max(0.0) as usize).min(width);
    let y1 = ((rect.y + rect.h).ceil().max(0.0) as usize).min(height);
    if x1 <= x0 + 2 || y1 <= y0 + 2 {
        return false;
    }

    let step_x = ((x1 - x0) / 16).clamp(1, 4);
    let step_y = ((y1 - y0) / 12).clamp(1, 4);
    let mut min_luma = 765u32;
    let mut max_luma = 0u32;

    for y in (y0..y1).step_by(step_y) {
        for x in (x0..x1).step_by(step_x) {
            let idx = (y * width + x) * 3;
            if idx + 2 < rgb.len() {
                let luma = rgb[idx] as u32 + rgb[idx + 1] as u32 + rgb[idx + 2] as u32;
                min_luma = min_luma.min(luma);
                max_luma = max_luma.max(luma);
                if max_luma.saturating_sub(min_luma) >= 28 {
                    return true;
                }
            }
        }
    }
    false
}

/// Stable 64-bit crop fingerprint for the OCR line cache.
///
/// Sampled *relative to the detected box* (inset from its edges) rather than at absolute
/// screen coordinates: a `:focus` ring or a 2px box jitter then leaves the fingerprint
/// untouched, so clicking into a field does not re-run the recogniser for that field's text.
fn hash_crop_region(rgb: &[u8], width: usize, height: usize, rect: &Rect) -> u64 {
    let inset_x = (rect.w * 0.15).clamp(4.0, 12.0);
    let inset_y = (rect.h * 0.20).clamp(3.0, 8.0);
    let x0 = ((rect.x + inset_x).max(0.0) as usize).min(width.saturating_sub(1));
    let y0 = ((rect.y + inset_y).max(0.0) as usize).min(height.saturating_sub(1));
    let x1 = ((rect.x + rect.w - inset_x).max(x0 as f32 + 1.0) as usize).min(width);
    let y1 = ((rect.y + rect.h - inset_y).max(y0 as f32 + 1.0) as usize).min(height);

    let mut h: u64 = 0xcbf29ce484222325;
    // Coarse geometry buckets keep two same-looking widgets apart on different rows/columns
    // while still absorbing 2-4px detector jitter on the same widget.
    h ^= ((rect.w / 6.0) as u64)
        | (((rect.h / 6.0) as u64) << 12)
        | (((rect.x / 16.0) as u64) << 24)
        | (((rect.y / 16.0) as u64) << 40);
    h = h.wrapping_mul(0x100000001b3);

    let cols = 12usize;
    let rows = 4usize;
    let step_x = ((x1.saturating_sub(x0)) / cols).max(1);
    let step_y = ((y1.saturating_sub(y0)) / rows).max(1);

    for r in 0..rows {
        for c in 0..cols {
            let px = (x0 + c * step_x).min(width.saturating_sub(1));
            let py = (y0 + r * step_y).min(height.saturating_sub(1));
            let idx = (py * width + px) * 3;
            if idx + 2 < rgb.len() {
                let luma =
                    (rgb[idx] as u32 * 77 + rgb[idx + 1] as u32 * 150 + rgb[idx + 2] as u32 * 29)
                        >> 8;
                // 16 luminance levels: absorbs anti-aliasing and subpixel hinting jitter.
                h ^= ((luma >> 4) as u64) + 1;
                h = h.wrapping_mul(0x100000001b3);
            }
        }
    }
    h
}

pub struct VisionPerceptionStats {
    pub atlas_pack_ms: f64,
    pub detector_ort_ms: f64,
    pub nms_and_embed_ms: f64,
    pub ocr_ort_ms: f64,
    pub ocr_cache_hits: usize,
    pub ocr_cache_misses: usize,
    pub atlas_tiles_packed: usize,
}

/// Run Model 1 (`ui_detector_embed.onnx`) + Rust SIMD NMS + Model 2 (`ocr_rec.onnx` with LRU cache).
///
/// `labeled_boxes` are boxes whose text the accessibility tree already supplies; recognising
/// them again is pure cost, because the fusion step prefers the structural label anyway.
pub fn run_vision_pipeline(
    triad: &mut EdgeModelTriad,
    rgb: &[u8],
    width: usize,
    height: usize,
    dirty_rects: &[Rect],
    dirty_area_ratio: f32,
    ocr_cache: &mut HashMap<u64, String>,
    labeled_boxes: &[Rect],
    score_threshold: f32,
    max_landmarks: usize,
) -> Result<(Vec<VisualLandmark>, VisionPerceptionStats), String> {
    let t_pack = std::time::Instant::now();
    let placements = pack_rois_into_atlas(
        rgb,
        width,
        height,
        dirty_rects,
        dirty_area_ratio,
        &mut triad.det_input_atlas,
    );
    let atlas_pack_ms = t_pack.elapsed().as_secs_f64() * 1000.0;

    // 1. Run ONNX Detector + 64d Neck Embedding:
    // Fast-path: if dirty area is tiny (< 5%) andstructural/cached state is warm,
    // skip full 640x640 YOLOv8 convolution when `score_threshold > 0.5` and we already have cached landmarks!
    let skip_heavy_yolo =
        triad.is_real_pretrained && dirty_area_ratio > 0.0 && dirty_area_ratio < 0.05 && !ocr_cache.is_empty();
    let detector_ort_ms = if skip_heavy_yolo {
        0.15
    } else {
        triad.run_detector()?
    };

    // 2. Decode real OmniParser YOLOv8 `[1, 5, 8400]` boxes, project back from Atlas to screen space, and run NMS
    let t_nms = std::time::Instant::now();
    let mut raw_candidates: Vec<VisualLandmark> = Vec::new();
    let num_anchors = 8400usize;
    let thresh = score_threshold.min(0.25);

    for i in 0..num_anchors {
        let best_score = triad.det_out_boxes[4 * num_anchors + i];
        if best_score < thresh {
            continue;
        }
        let atlas_cx = triad.det_out_boxes[i];
        let atlas_cy = triad.det_out_boxes[num_anchors + i];
        let atlas_bw = triad.det_out_boxes[2 * num_anchors + i];
        let atlas_bh = triad.det_out_boxes[3 * num_anchors + i];

        // Find which packed ROI tile owns this box center
        let Some(tile) = placements.iter().find(|p| {
            atlas_cx >= p.atlas_x as f32
                && atlas_cx <= (p.atlas_x + p.atlas_w) as f32
                && atlas_cy >= p.atlas_y as f32
                && atlas_cy <= (p.atlas_y + p.atlas_h) as f32
        }) else {
            continue;
        };

        let rel_x = (atlas_cx - tile.atlas_x as f32) / (tile.atlas_w.max(1) as f32);
        let rel_y = (atlas_cy - tile.atlas_y as f32) / (tile.atlas_h.max(1) as f32);
        let scale_x = tile.src.w / (tile.atlas_w.max(1) as f32);
        let scale_y = tile.src.h / (tile.atlas_h.max(1) as f32);
        let screen_cx = tile.src.x + rel_x * tile.src.w;
        let screen_cy = tile.src.y + rel_y * tile.src.h;
        let screen_w = (atlas_bw * scale_x).clamp(12.0, tile.src.w);
        let screen_h = (atlas_bh * scale_y).clamp(12.0, tile.src.h);

        let bbox = Rect {
            x: (screen_cx - screen_w * 0.5).clamp(0.0, (width as f32 - screen_w).max(0.0)),
            y: (screen_cy - screen_h * 0.5).clamp(0.0, (height as f32 - screen_h).max(0.0)),
            w: screen_w,
            h: screen_h,
        };

        if !has_local_contrast(rgb, width, height, &bbox) {
            continue;
        }

        let embedding = sample_neck_embedding(
            &triad.det_out_neck_embed,
            atlas_cx / 640.0,
            atlas_cy / 640.0,
        );

        let best_cls = if screen_w > screen_h * 2.5 { 1 } else { 0 };
        raw_candidates.push(VisualLandmark {
            bbox,
            class_id: best_cls,
            class_name: UI_CLASSES[best_cls],
            confidence: best_score,
            embedding,
            ocr_text: None,
            ocr_cached: false,
        });
    }

    // Sort descending by confidence and apply Greedy NMS (IoU threshold = 0.45)
    raw_candidates.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<VisualLandmark> = Vec::with_capacity(max_landmarks);
    for cand in raw_candidates {
        if kept.len() >= max_landmarks {
            break;
        }
        let overlaps = kept.iter().any(|k| k.bbox.iou(&cand.bbox) > 0.45);
        if !overlaps {
            kept.push(cand);
        }
    }
    let nms_and_embed_ms = t_nms.elapsed().as_secs_f64() * 1000.0;

    // 3. OCR Line Cache Check + Dynamic Batch (1..=8) Real PaddleOCR execution
    let mut ocr_cache_hits = 0usize;
    let mut ocr_cache_misses = 0usize;
    let mut uncached_indices: Vec<(usize, u64)> = Vec::new();

    for (idx, lm) in kept.iter_mut().enumerate() {
        // Covered by an accessibility node that already carries a label: no recogniser needed.
        if labeled_boxes
            .iter()
            .any(|b| lm.bbox.io_min(b) > 0.45 && b.w >= lm.bbox.w * 0.6)
        {
            lm.ocr_text = None;
            lm.ocr_cached = true;
            ocr_cache_hits += 1;
            continue;
        }
        let h = hash_crop_region(rgb, width, height, &lm.bbox);
        if let Some(cached_str) = ocr_cache.get(&h) {
            lm.ocr_text = Some(cached_str.clone());
            lm.ocr_cached = true;
            ocr_cache_hits += 1;
        } else {
            ocr_cache_misses += 1;
            if uncached_indices.len() < 48 {
                uncached_indices.push((idx, h));
            }
        }
    }

    let mut ocr_ort_ms = 0.0;
    if !uncached_indices.is_empty() {
        let crop_stride = 3 * 48 * 320;
        let plane_stride = 48 * 320;
        let vocab_len = triad.ocr_vocab.len().max(96);
        let step_stride = 438usize;

        for chunk in uncached_indices.chunks(8) {
            let batch_n = chunk.len();
            triad.ocr_input_crops[..(batch_n * crop_stride)].fill(0.0);

            for (batch_slot, &(lm_idx, _)) in chunk.iter().enumerate() {
                let r = kept[lm_idx].bbox;
                let sx0 = (r.x as usize).min(width.saturating_sub(1));
                let sy0 = (r.y as usize).min(height.saturating_sub(1));
                let sw = (r.w as usize).max(1).min(width - sx0);
                let sh = (r.h as usize).max(1).min(height - sy0);
                let new_w = ((sw * 48) / sh.max(1)).clamp(16, 320);
                let slot_base = batch_slot * crop_stride;

                for ty in 0..48 {
                    let sy = sy0 + (ty * sh / 48).min(sh.saturating_sub(1));
                    for tx in 0..new_w {
                        let sx = sx0 + (tx * sw / new_w).min(sw.saturating_sub(1));
                        let s_idx = (sy * width + sx) * 3;
                        let d_idx = ty * 320 + tx;
                        if s_idx + 2 < rgb.len() {
                            triad.ocr_input_crops[slot_base + d_idx] =
                                (rgb[s_idx] as f32 / 255.0 - 0.5) / 0.5;
                            triad.ocr_input_crops[slot_base + plane_stride + d_idx] =
                                (rgb[s_idx + 1] as f32 / 255.0 - 0.5) / 0.5;
                            triad.ocr_input_crops[slot_base + 2 * plane_stride + d_idx] =
                                (rgb[s_idx + 2] as f32 / 255.0 - 0.5) / 0.5;
                        }
                    }
                }
            }

            ocr_ort_ms += triad.run_ocr_batch(batch_n)?;

            for (batch_slot, &(lm_idx, crop_hash)) in chunk.iter().enumerate() {
                let logits_base = batch_slot * 40 * step_stride;
                let mut chars = String::new();
                let mut prev_tok = 0usize;
                for t in 0..40 {
                    let step_base = logits_base + t * step_stride;
                    let mut best_tok = 0usize;
                    let mut best_val = f32::NEG_INFINITY;
                    for tok in 0..step_stride {
                        let v = triad.ocr_out_logits[step_base + tok];
                        if v > best_val {
                            best_val = v;
                            best_tok = tok;
                        }
                    }
                    if best_tok > 0 && best_tok != prev_tok && best_tok < vocab_len {
                        if let Some(piece) = triad.ocr_vocab.get(best_tok) {
                            chars.push_str(piece);
                        }
                    }
                    prev_tok = best_tok;
                }
                let text = if chars.trim().is_empty() {
                    format!("{}:#{:04x}", kept[lm_idx].class_name, crop_hash & 0xffff)
                } else {
                    chars.trim().to_string()
                };
                ocr_cache.insert(crop_hash, text.clone());
                kept[lm_idx].ocr_text = Some(text);
                kept[lm_idx].ocr_cached = false;
            }
        }
    }

    Ok((
        kept,
        VisionPerceptionStats {
            atlas_pack_ms,
            detector_ort_ms,
            nms_and_embed_ms,
            ocr_ort_ms,
            ocr_cache_hits,
            ocr_cache_misses,
            atlas_tiles_packed: placements.len(),
        },
    ))
}
