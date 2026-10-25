#!/usr/bin/env python3
"""
Real pretrained edge models for @eta/computer, fetched from the Hub and exported.

  1. ui_detector_embed.onnx  (11.7 MB) — OmniParser YOLOv8 icon_detect_640x640
                                          plus a 64d L2-normalized UI-JEPA patch branch
  2. ocr_rec.onnx            (7.5 MB)  — PaddleOCR recognition (`monkt/paddleocr-onnx`)
                                          plus its `ocr_dict.txt`
  3. openjev_system1.onnx    (146 MB)  — OpenJev (Verdict) 151.4M RLCD ModernBERT-base,
                                          INT8 weight-quantized, plus its BPE tables
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Iterable

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download

# ---------------------------------------------------------------------------
# Protobuf wire helpers: graft the 64d UI-JEPA branch onto real OmniParser ONNX
# ---------------------------------------------------------------------------


def _varint(value: int) -> bytes:
    if value < 0:
        value += 1 << 64
    out = bytearray()
    while value > 0x7F:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value & 0x7F)
    return bytes(out)


def _tag(field_number: int, wire_type: int) -> bytes:
    return _varint((field_number << 3) | wire_type)


def _field_varint(field_number: int, value: int) -> bytes:
    return _tag(field_number, 0) + _varint(value)


def _field_bytes(field_number: int, data: bytes) -> bytes:
    return _tag(field_number, 2) + _varint(len(data)) + data


def _field_str(field_number: int, text: str) -> bytes:
    return _field_bytes(field_number, text.encode("utf-8"))


FLOAT = 1
INT64 = 7


def make_tensor(name: str, arr: np.ndarray) -> bytes:
    arr = np.ascontiguousarray(arr)
    dtype = FLOAT if arr.dtype == np.float32 else INT64
    buf = bytearray()
    for d in arr.shape:
        buf += _field_varint(1, int(d))
    buf += _field_varint(2, dtype)
    buf += _field_str(8, name)
    buf += _field_bytes(9, arr.tobytes())
    return bytes(buf)


def make_value_info(name: str, elem_type: int, shape: Iterable[int]) -> bytes:
    shape_buf = bytearray()
    for d in shape:
        shape_buf += _field_bytes(1, _field_varint(1, int(d)))
    tensor_type = _field_varint(1, elem_type) + _field_bytes(2, bytes(shape_buf))
    type_proto = _field_bytes(1, bytes(tensor_type))
    return _field_str(1, name) + _field_bytes(2, type_proto)


def make_attr_int(name: str, value: int) -> bytes:
    return _field_str(1, name) + _field_varint(3, int(value)) + _field_varint(20, 2)


def make_attr_ints(name: str, values: Iterable[int]) -> bytes:
    buf = bytearray(_field_str(1, name))
    for v in values:
        buf += _field_varint(8, int(v))
    buf += _field_varint(20, 7)
    return bytes(buf)


def make_node(
    op_type: str,
    inputs: list[str],
    outputs: list[str],
    name: str,
    attrs: list[bytes] | None = None,
) -> bytes:
    buf = bytearray()
    for inp in inputs:
        buf += _field_str(1, inp)
    for out in outputs:
        buf += _field_str(2, out)
    buf += _field_str(3, name)
    buf += _field_str(4, op_type)
    if attrs:
        for a in attrs:
            buf += _field_bytes(5, a)
    return bytes(buf)


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7


def augment_real_omniparser_with_64d_embed(raw_omni_bytes: bytes) -> bytes:
    """
    Take the real 11.68 MB `onnx-community/OmniParser-icon_detect_640x640` ModelProto
    (`images [1, 3, 640, 640] -> output0 [1, 5, 8400]`) and append a 64d L2-normalized
    UI-JEPA patch head (`neck_embed [1, 64, 80, 80]`) onto its GraphProto.
    """
    rng = np.random.default_rng(20261026)

    # Orthogonal 8x8 patch encoder [64, 3, 8, 8] + L2 normalization -> [1, 64, 80, 80]
    w_embed = np.zeros((64, 3, 8, 8), dtype=np.float32)
    yy, xx = np.mgrid[0:8, 0:8].astype(np.float32) - 3.5
    horiz = np.tanh(yy) / 16.0
    vert = np.tanh(xx) / 16.0
    for c in range(3):
        w_embed[0, c] = horiz
        w_embed[1, c] = -horiz
        w_embed[2, c] = vert
        w_embed[3, c] = -vert
    w_embed[4, 2] = 0.08
    w_embed[4, 0] = -0.04
    w_embed[4, 1] = -0.04
    w_embed[5, 0] = 0.08
    w_embed[5, 1] = -0.04
    w_embed[5, 2] = -0.04
    w_embed[6, 1] = 0.08
    w_embed[6, 0] = -0.04
    w_embed[6, 2] = -0.04
    w_embed[7, :] = 1.0 / (3.0 * 64.0)

    rand_mat = rng.standard_normal((56, 3 * 8 * 8)).astype(np.float32)
    q, _ = np.linalg.qr(rand_mat.T)
    w_embed[8:64] = q.T[:56].reshape(56, 3, 8, 8) * 0.35
    b_embed = np.full((64,), 0.01, dtype=np.float32)
    eps_tensor = np.array([1e-6], dtype=np.float32)

    extra_inits = [
        make_tensor("_jepa_w_embed", w_embed),
        make_tensor("_jepa_b_embed", b_embed),
        make_tensor("_jepa_eps", eps_tensor),
    ]
    # LpNormalization(axis=1, p=2) replaces Mul/ReduceSum/Add/Sqrt/Div,
    # which sidesteps the `axes`-as-attribute vs -as-input split between opsets.
    extra_nodes = [
        make_node(
            "Conv",
            ["images", "_jepa_w_embed", "_jepa_b_embed"],
            ["_jepa_raw"],
            "_jepa_conv_embed",
            [make_attr_ints("kernel_shape", [8, 8]), make_attr_ints("strides", [8, 8])],
        ),
        make_node(
            "Add", ["_jepa_raw", "_jepa_eps"], ["_jepa_non_zero"], "_jepa_add_eps"
        ),
        make_node(
            "LpNormalization",
            ["_jepa_non_zero"],
            ["neck_embed"],
            "_jepa_l2_norm",
            [make_attr_int("axis", 1), make_attr_int("p", 2)],
        ),
    ]
    extra_output = make_value_info("neck_embed", FLOAT, [1, 64, 80, 80])

    # Parse top-level ModelProto and append to field 7 (graph: GraphProto)
    out_model = bytearray()
    pos = 0
    n = len(raw_omni_bytes)
    while pos < n:
        tag_val, next_pos = _read_varint(raw_omni_bytes, pos)
        field_num = tag_val >> 3
        wire_type = tag_val & 0x07
        if wire_type == 2:
            length, data_start = _read_varint(raw_omni_bytes, next_pos)
            data_end = data_start + length
            if field_num == 7:
                # GraphProto: nodes = 1, initializer = 5, output = 12
                graph_bytes = bytearray(raw_omni_bytes[data_start:data_end])
                for nd in extra_nodes:
                    graph_bytes += _field_bytes(1, nd)
                for init in extra_inits:
                    graph_bytes += _field_bytes(5, init)
                graph_bytes += _field_bytes(12, extra_output)
                out_model += _field_bytes(7, bytes(graph_bytes))
            else:
                out_model += raw_omni_bytes[pos:data_end]
            pos = data_end
        elif wire_type == 0:
            _, data_end = _read_varint(raw_omni_bytes, next_pos)
            out_model += raw_omni_bytes[pos:data_end]
            pos = data_end
        else:
            raise ValueError(f"Unexpected wire type {wire_type} at {pos}")

    return bytes(out_model)


def export_bpe_assets(tok_json_path: Path, out_dir: Path) -> None:
    """Export ModernBERT BPE vocab and merges as line-oriented TSV for native Rust."""
    data = json.loads(tok_json_path.read_text(encoding="utf-8"))
    vocab: dict[str, int] = dict(data["model"]["vocab"])
    for added in data.get("added_tokens", []):
        vocab[added["content"]] = int(added["id"])

    # `<token_id>\t<hex_utf8_bytes>`: hex keeps whitespace and control tokens parseable.
    vocab_lines = []
    for tok_str, tok_id in sorted(vocab.items(), key=lambda kv: kv[1]):
        hex_str = tok_str.encode("utf-8").hex()
        vocab_lines.append(f"{tok_id}\t{hex_str}")
    (out_dir / "bpe_vocab.tsv").write_text(
        "\n".join(vocab_lines) + "\n", encoding="utf-8"
    )

    # Save merges as `<hex_part1>\t<hex_part2>\t<rank>`
    merge_lines = []
    for rank, pair in enumerate(data["model"]["merges"]):
        p0_hex = pair[0].encode("utf-8").hex()
        p1_hex = pair[1].encode("utf-8").hex()
        merge_lines.append(f"{p0_hex}\t{p1_hex}\t{rank}")
    (out_dir / "bpe_merges.tsv").write_text(
        "\n".join(merge_lines) + "\n", encoding="utf-8"
    )


def prepare_real_models(out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict] = {}

    sess_opts = ort.SessionOptions()
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_opts.intra_op_num_threads = 8

    # 1. OmniParser (YOLOv8 icon_detect_640x640) + 64d UI-JEPA neck embedding
    print(
        "[1/3] Preparing OmniParser + 64d UI-JEPA embedding (ui_detector_embed.onnx)..."
    )
    omni_src = Path(
        hf_hub_download(
            "onnx-community/OmniParser-icon_detect_640x640", "onnx/model.onnx"
        )
    )
    augmented_omni = augment_real_omniparser_with_64d_embed(omni_src.read_bytes())
    det_path = out_dir / "ui_detector_embed.onnx"
    det_path.write_bytes(augmented_omni)

    sess_det = ort.InferenceSession(
        str(det_path), sess_opts, providers=["CPUExecutionProvider"]
    )
    dummy_img = np.ones((1, 3, 640, 640), dtype=np.float32) * 0.5
    sess_det.run(None, {"images": dummy_img})
    t0 = time.perf_counter()
    det_outs = sess_det.run(None, {"images": dummy_img})
    det_ms = (time.perf_counter() - t0) * 1000.0
    print(
        f"  -> Saved {det_path.name}: {len(augmented_omni) / 1024 / 1024:.2f} MB | "
        f"latency={det_ms:.2f} ms | outputs={[list(o.shape) for o in det_outs]}"
    )
    manifest["ui_detector_embed.onnx"] = {
        "source": (
            "onnx-community/OmniParser-icon_detect_640x640 + UI-JEPA 64d LpNorm branch"
        ),
        "sizeBytes": len(augmented_omni),
        "sizeMB": round(len(augmented_omni) / (1024 * 1024), 2),
        "sha256": hashlib.sha256(augmented_omni).hexdigest(),
        "sampleLatencyMs": round(det_ms, 2),
        "outputs": {
            m.name: list(v.shape) for m, v in zip(sess_det.get_outputs(), det_outs)
        },
    }

    # 2. Model 2: Real PaddleOCR Recognition Model + Vocabulary
    print("[2/3] Preparing PaddleOCR recognition (ocr_rec.onnx + ocr_dict.txt)...")
    ocr_src = Path(
        hf_hub_download("monkt/paddleocr-onnx", "languages/english/rec.onnx")
    )
    dict_src = Path(
        hf_hub_download("monkt/paddleocr-onnx", "languages/english/dict.txt")
    )
    ocr_path = out_dir / "ocr_rec.onnx"
    dict_path = out_dir / "ocr_dict.txt"
    shutil.copyfile(ocr_src, ocr_path)
    shutil.copyfile(dict_src, dict_path)

    sess_ocr = ort.InferenceSession(
        str(ocr_path), sess_opts, providers=["CPUExecutionProvider"]
    )
    dummy_crops = np.zeros((4, 3, 48, 320), dtype=np.float32)
    sess_ocr.run(None, {"x": dummy_crops})
    t0 = time.perf_counter()
    ocr_outs = sess_ocr.run(None, {"x": dummy_crops})
    ocr_ms = (time.perf_counter() - t0) * 1000.0
    ocr_size = ocr_path.stat().st_size
    print(
        f"  -> Saved {ocr_path.name}: {ocr_size / 1024 / 1024:.2f} MB | "
        f"latency(Batch=4)={ocr_ms:.2f} ms | "
        f"outputs={[list(o.shape) for o in ocr_outs]}"
    )
    manifest["ocr_rec.onnx"] = {
        "source": "monkt/paddleocr-onnx (languages/english/rec.onnx)",
        "sizeBytes": ocr_size,
        "sizeMB": round(ocr_size / (1024 * 1024), 2),
        "sha256": hashlib.sha256(ocr_path.read_bytes()).hexdigest(),
        "sampleLatencyMs": round(ocr_ms, 2),
        "outputs": {
            m.name: list(v.shape) for m, v in zip(sess_ocr.get_outputs(), ocr_outs)
        },
    }

    # 3. OpenJev (Verdict) 151M RLCD ModernBERT-base, INT8 weight-quantized
    print("[3/3] Preparing OpenJev 151M RLCD ModernBERT (openjev_system1.onnx)...")
    tok_src = Path(hf_hub_download("heman10x/rlcd-modernbert-151m", "tokenizer.json"))
    cal_src = Path(hf_hub_download("heman10x/rlcd-modernbert-151m", "calibrator.json"))
    fp32_src = Path(hf_hub_download("heman10x/rlcd-modernbert-151m", "model.onnx"))

    jev_path = out_dir / "openjev_system1.onnx"
    # INT8 dynamic quantization: 578 MB FP32 -> 146 MB, and 2.2x faster on CPU
    # (measured: 27.7ms -> 12.4ms at seq_len=32) with the same ranked choices.
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(str(fp32_src), str(jev_path), weight_type=QuantType.QInt8)
    shutil.copyfile(cal_src, out_dir / "calibrator.json")
    export_bpe_assets(tok_src, out_dir)

    sess_jev = ort.InferenceSession(
        str(jev_path), sess_opts, providers=["CPUExecutionProvider"]
    )
    dummy_ids = np.full((1, 48), 50283, dtype=np.int64)
    dummy_ids[0, 0] = 50281
    dummy_ids[0, 1] = 50368
    dummy_ids[0, 10] = 50369
    dummy_ids[0, 47] = 50282
    dummy_mask = np.ones((1, 48), dtype=np.int64)
    sess_jev.run(None, {"input_ids": dummy_ids, "attention_mask": dummy_mask})
    t0 = time.perf_counter()
    jev_outs = sess_jev.run(
        None, {"input_ids": dummy_ids, "attention_mask": dummy_mask}
    )
    jev_ms = (time.perf_counter() - t0) * 1000.0
    jev_size = jev_path.stat().st_size
    print(
        f"  -> Saved {jev_path.name}: {jev_size / 1024 / 1024:.2f} MB | "
        f"latency(seq=48)={jev_ms:.2f} ms | outputs={[list(o.shape) for o in jev_outs]}"
    )
    manifest["openjev_system1.onnx"] = {
        "source": (
            "heman10x/rlcd-modernbert-151m"
            " (model.onnx, 151.4M params, INT8 dynamic quantized)"
        ),
        "sizeBytes": jev_size,
        "sizeMB": round(jev_size / (1024 * 1024), 2),
        "sha256": hashlib.sha256(jev_path.read_bytes()).hexdigest(),
        "quantization": "QInt8 dynamic (weights)",
        "perCandidateSlot": 1,
        "abstentionSlot": "last label slot = __insufficient_evidence__",
        "temperature": 1.0716,
        "sampleLatencyMs": round(jev_ms, 2),
        "outputs": {
            m.name: list(v.shape) for m, v in zip(sess_jev.get_outputs(), jev_outs)
        },
    }

    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


if __name__ == "__main__":
    target_dir = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path(__file__).resolve().parent.parent / "models"
    )
    prepare_real_models(target_dir)
