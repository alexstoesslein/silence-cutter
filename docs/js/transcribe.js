/**
 * Whisper transcription via Transformers.js (ONNX in-browser).
 * Downloads ~40MB model on first use, cached by browser.
 */

let pipeline = null;
let pipelineLoading = false;

/**
 * Load the Whisper pipeline (one-time model download).
 */
export async function loadWhisperModel(modelName = "Xenova/whisper-small", onProgress) {
    if (pipeline) return pipeline;
    if (pipelineLoading) {
        // Wait for ongoing load
        while (pipelineLoading) {
            await new Promise(r => setTimeout(r, 200));
        }
        return pipeline;
    }

    pipelineLoading = true;

    try {
        const { pipeline: createPipeline } = await import(
            "https://esm.sh/@huggingface/transformers@3.4.2"
        );

        pipeline = await createPipeline(
            "automatic-speech-recognition",
            modelName,
            {
                dtype: "q8",
                device: "wasm",
                progress_callback: (progress) => {
                    if (onProgress && progress.progress) {
                        onProgress(Math.round(progress.progress));
                    }
                },
            }
        );
    } finally {
        pipelineLoading = false;
    }

    return pipeline;
}

/**
 * Transcribe a WAV Blob.
 * @param {Blob} wavBlob
 * @param {string} modelName
 * @param {string|null} language - ISO 639-1 code (e.g. "de", "en") or null for auto-detect
 * Returns { text, chunks: [{ text, timestamp: [start, end] }] }
 */
export async function transcribeBlob(wavBlob, modelName, language = null) {
    const asr = await loadWhisperModel(modelName);

    // Convert Blob → Float32Array of audio samples
    const arrayBuffer = await wavBlob.arrayBuffer();
    const audioData = convertWavToFloat32(arrayBuffer);

    const opts = {
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
    };
    if (language) {
        opts.language = language;
    }

    const result = await asr(audioData, opts);

    return {
        text: result.text?.trim() || "",
        chunks: result.chunks || [],
    };
}

/**
 * Transcribe all segments. Adds 'transcription' to each segment.
 * @param {string|null} language - ISO 639-1 code or null for auto-detect
 */
export async function transcribeAllSegments(segments, wavBlobs, modelName, language, onProgress) {
    const total = segments.length;
    for (let i = 0; i < total; i++) {
        const blob = wavBlobs[i];
        if (!blob) {
            segments[i].transcription = { text: "", chunks: [] };
            continue;
        }

        try {
            const result = await transcribeBlob(blob, modelName, language);
            segments[i].transcription = result;
        } catch (e) {
            console.error(`Transcription failed for segment ${i}:`, e);
            segments[i].transcription = { text: "", chunks: [] };
        }

        if (onProgress) onProgress(i + 1, total);
    }
    return segments;
}

/**
 * Group segments with similar text (= repeated takes of same line).
 */
export function groupSimilarTakes(segments, threshold = 0.6) {
    const groups = [];
    const used = new Set();

    for (let i = 0; i < segments.length; i++) {
        if (used.has(i)) continue;

        const textI = segments[i].transcription?.text || "";
        const group = {
            group_id: groups.length,
            takes: [segments[i]],
        };
        used.add(i);

        for (let j = i + 1; j < segments.length; j++) {
            if (used.has(j)) continue;
            const textJ = segments[j].transcription?.text || "";
            if (textSimilarity(textI, textJ) >= threshold) {
                group.takes.push(segments[j]);
                used.add(j);
            }
        }

        const texts = group.takes.map(t => t.transcription?.text || "");
        group.text_summary = texts.reduce((a, b) => a.length >= b.length ? a : b, "");
        group.take_count = group.takes.length;
        groups.push(group);
    }

    return groups;
}

// ── Helpers ──

function textSimilarity(a, b) {
    if (!a || !b) return 0;
    a = a.toLowerCase().trim();
    b = b.toLowerCase().trim();
    if (a === b) return 1;

    // Simple Levenshtein-based ratio
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    const dist = levenshtein(a, b);
    return 1 - dist / maxLen;
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

/**
 * Convert raw WAV ArrayBuffer to Float32Array of samples.
 * Assumes 16-bit PCM mono WAV.
 */
function convertWavToFloat32(arrayBuffer) {
    const view = new DataView(arrayBuffer);

    // Find 'data' chunk
    let offset = 12; // skip RIFF header
    while (offset < view.byteLength - 8) {
        const chunkId = String.fromCharCode(
            view.getUint8(offset), view.getUint8(offset + 1),
            view.getUint8(offset + 2), view.getUint8(offset + 3)
        );
        const chunkSize = view.getUint32(offset + 4, true);
        if (chunkId === "data") {
            offset += 8;
            const samples = new Float32Array(chunkSize / 2);
            for (let i = 0; i < samples.length; i++) {
                const sample = view.getInt16(offset + i * 2, true);
                samples[i] = sample / 32768;
            }
            return samples;
        }
        offset += 8 + chunkSize;
        if (chunkSize % 2 !== 0) offset++; // padding byte
    }

    // Fallback: treat everything after 44 bytes as data
    const dataOffset = 44;
    const numSamples = (arrayBuffer.byteLength - dataOffset) / 2;
    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
        const sample = view.getInt16(dataOffset + i * 2, true);
        samples[i] = sample / 32768;
    }
    return samples;
}
