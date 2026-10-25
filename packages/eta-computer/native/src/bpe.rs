//! Native Rust ByteLevel BPE Tokenizer for `heman10x/rlcd-modernbert-151m` (ModernBERT + GLiClass).
//! Loads `bpe_vocab.tsv` and `bpe_merges.tsv` exported from HuggingFace `tokenizer.json`.

use std::collections::HashMap;
use std::fs;

pub const CLS_TOKEN_ID: i64 = 50281;
pub const SEP_TOKEN_ID: i64 = 50282;
pub const PAD_TOKEN_ID: i64 = 50283;
pub const UNK_TOKEN_ID: i64 = 50280;
pub const LABEL_TOKEN_ID: i64 = 50368; // <<LABEL>>
pub const GLI_SEP_TOKEN_ID: i64 = 50369; // <<SEP>>

pub struct ModernBertBpeTokenizer {
    vocab: HashMap<String, i64>,
    merges: HashMap<(String, String), usize>,
    byte_to_unicode: [char; 256],
}

fn decode_hex(hex: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    let raw = hex.as_bytes();
    let mut i = 0;
    while i + 1 < raw.len() {
        let hi = (raw[i] as char).to_digit(16).ok_or("bad hex")?;
        let lo = (raw[i + 1] as char).to_digit(16).ok_or("bad hex")?;
        bytes.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn build_byte_to_unicode() -> [char; 256] {
    let mut table = ['\0'; 256];
    let mut used = [false; 256];

    for b in b'!'..=b'~' {
        table[b as usize] = b as char;
        used[b as usize] = true;
    }
    for b in 0xa1u8..=0xacu8 {
        table[b as usize] = char::from_u32(b as u32).unwrap();
        used[b as usize] = true;
    }
    for b in 0xaeu8..=0xffu8 {
        table[b as usize] = char::from_u32(b as u32).unwrap();
        used[b as usize] = true;
    }

    let mut extra = 0u32;
    for b in 0..256usize {
        if !used[b] {
            table[b] = char::from_u32(256 + extra).unwrap();
            extra += 1;
        }
    }
    table
}

impl ModernBertBpeTokenizer {
    pub fn load(models_dir: &str) -> Result<Self, String> {
        let vocab_path = format!("{}/bpe_vocab.tsv", models_dir.trim_end_matches('/'));
        let merges_path = format!("{}/bpe_merges.tsv", models_dir.trim_end_matches('/'));

        let vocab_raw = fs::read_to_string(&vocab_path)
            .map_err(|e| format!("Failed to read {}: {}", vocab_path, e))?;
        let merges_raw = fs::read_to_string(&merges_path)
            .map_err(|e| format!("Failed to read {}: {}", merges_path, e))?;

        let mut vocab = HashMap::with_capacity(51000);
        for line in vocab_raw.lines() {
            let mut parts = line.split('\t');
            if let (Some(id_s), Some(hex_s)) = (parts.next(), parts.next()) {
                if let (Ok(id), Ok(tok)) = (id_s.parse::<i64>(), decode_hex(hex_s)) {
                    vocab.insert(tok, id);
                }
            }
        }

        let mut merges = HashMap::with_capacity(51000);
        for line in merges_raw.lines() {
            let mut parts = line.split('\t');
            if let (Some(p0_h), Some(p1_h), Some(rank_s)) =
                (parts.next(), parts.next(), parts.next())
            {
                if let (Ok(p0), Ok(p1), Ok(rank)) =
                    (decode_hex(p0_h), decode_hex(p1_h), rank_s.parse::<usize>())
                {
                    merges.insert((p0, p1), rank);
                }
            }
        }

        Ok(Self {
            vocab,
            merges,
            byte_to_unicode: build_byte_to_unicode(),
        })
    }

    fn bpe_encode_chunk(&self, chunk: &str, out: &mut Vec<i64>) {
        if chunk.is_empty() {
            return;
        }
        let mut word: Vec<String> = chunk
            .as_bytes()
            .iter()
            .map(|&b| self.byte_to_unicode[b as usize].to_string())
            .collect();

        while word.len() > 1 {
            let mut best_rank = usize::MAX;
            let mut best_pair: Option<(String, String)> = None;

            for i in 0..(word.len() - 1) {
                let pair = (word[i].clone(), word[i + 1].clone());
                if let Some(&rank) = self.merges.get(&pair) {
                    if rank < best_rank {
                        best_rank = rank;
                        best_pair = Some(pair);
                    }
                }
            }

            let Some((p0, p1)) = best_pair else {
                break;
            };

            let mut next_word = Vec::with_capacity(word.len());
            let mut i = 0;
            while i < word.len() {
                if i + 1 < word.len() && word[i] == p0 && word[i + 1] == p1 {
                    let mut merged = String::with_capacity(p0.len() + p1.len());
                    merged.push_str(&p0);
                    merged.push_str(&p1);
                    next_word.push(merged);
                    i += 2;
                } else {
                    next_word.push(word[i].clone());
                    i += 1;
                }
            }
            word = next_word;
        }

        for w in word {
            let id = self.vocab.get(&w).copied().unwrap_or(UNK_TOKEN_ID);
            out.push(id);
        }
    }

    /// Pre-tokenize plain text segment using GPT-2 / ModernBERT byte-level word splitting.
    fn encode_plain_segment(&self, text: &str, out: &mut Vec<i64>) {
        let chars: Vec<char> = text.chars().collect();
        let n = chars.len();
        let mut i = 0;

        while i < n {
            // Optional leading single space attached to word/number/punctuation
            let start = i;
            if chars[i] == ' ' && i + 1 < n && !chars[i + 1].is_whitespace() {
                i += 1;
            }

            if i < n && chars[i].is_alphabetic() {
                while i < n && chars[i].is_alphabetic() {
                    i += 1;
                }
            } else if i < n && chars[i].is_numeric() {
                while i < n && chars[i].is_numeric() {
                    i += 1;
                }
            } else if i < n && !chars[i].is_whitespace() {
                while i < n
                    && !chars[i].is_whitespace()
                    && !chars[i].is_alphabetic()
                    && !chars[i].is_numeric()
                {
                    i += 1;
                }
            } else {
                while i < n && chars[i].is_whitespace() {
                    i += 1;
                }
            }

            let slice: String = chars[start..i].iter().collect();
            self.bpe_encode_chunk(&slice, out);
        }
    }

    /// Encode a structured OpenJev GLiClass query:
    /// `[CLS] <<LABEL>> opt_0 <<LABEL>> opt_1 ... <<LABEL>> __insufficient_evidence__ <<SEP>> context [SEP]`
    pub fn encode_gliclass_prompt(&self, labels: &[String], context: &str) -> Vec<i64> {
        let mut ids = Vec::with_capacity(128);
        ids.push(CLS_TOKEN_ID);
        for lbl in labels {
            ids.push(LABEL_TOKEN_ID);
            self.encode_plain_segment(lbl, &mut ids);
        }
        ids.push(GLI_SEP_TOKEN_ID);
        self.encode_plain_segment(context, &mut ids);
        ids.push(SEP_TOKEN_ID);
        ids
    }
}
