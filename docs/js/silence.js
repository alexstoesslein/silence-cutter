/**
 * Silence Detection via FFmpeg.wasm
 * Runs ffmpeg silencedetect filter entirely in the browser.
 *
 * Uses UMD build from unpkg with blob URLs to avoid cross-origin Worker issues
 * on GitHub Pages. The UMD build exposes FFmpegWASM on globalThis.
 */

let ffmpegInstance = null;
let ffmpegLoaded = false;

/**
 * Load FFmpeg.wasm (one-time download from CDN).
 * onProgress(percent, label) is called with download progress.
 *
 * Strategy for GitHub Pages (no COOP/COEP headers, no SharedArrayBuffer):
 * The 814.ffmpeg.js worker tries importScripts(coreURL) which fails cross-origin
 * from a blob Worker. Neither blob URL redirects nor importScripts overrides work
 * reliably. Instead, we build a completely self-contained worker blob:
 *   1. Inline ffmpeg-core.js text directly in the worker
 *   2. Explicitly assign self.createFFmpegCore after it executes
 *   3. Make importScripts a no-op that THROWS (so the worker's catch block
 *      sees createFFmpegCore already set and skips the import() fallback)
 */
export async function loadFFmpeg(onProgress) {
    if (ffmpegLoaded && ffmpegInstance) return ffmpegInstance;

    const coreBase = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
    const ffmpegBase = "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd";

    if (onProgress) onProgress(0, "Downloads starten...");

    // Download all four assets in parallel
    const [mainText, workerText, coreText, wasmBlobURL] = await Promise.all([
        fetchAsText(`${ffmpegBase}/ffmpeg.js`),
        fetchAsText(`${ffmpegBase}/814.ffmpeg.js`),
        fetchAsText(`${coreBase}/ffmpeg-core.js`),
        fetchAsBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
    ]);

    if (onProgress) onProgress(15, "FFmpeg initialisieren...");

    // Build self-contained worker:
    //
    // The worker code (814.ffmpeg.js) does this to load the core:
    //   try { importScripts(r) } catch {
    //     self.createFFmpegCore = (await import(r)).default;
    //     if (!self.createFFmpegCore) throw s;
    //   }
    //
    // If importScripts succeeds (no throw), the worker expects
    // self.createFFmpegCore to already be set as a side-effect.
    //
    // Strategy:
    //   1. Inline ffmpeg-core.js which sets `var createFFmpegCore = ...`
    //   2. Force UMD to use global var (not module.exports) by hiding module/exports
    //   3. Explicitly copy to self.createFFmpegCore
    //   4. Make importScripts a silent no-op (no throw!) so the worker
    //      thinks importScripts succeeded and finds createFFmpegCore set
    //
    // But 814.ffmpeg.js is ALSO a UMD module that checks module/exports.
    // We need to restore module/exports before it runs, otherwise IT breaks.

    // The 814.ffmpeg.js UMD wrapper checks: typeof exports, typeof module
    // ffmpeg-core.js UMD wrapper checks the same.
    // In a Worker, neither exists, so both use the global var path. Good.
    //
    // But we need ffmpeg-core.js to run FIRST (setting var createFFmpegCore),
    // then importScripts must be a no-op when 814.ffmpeg.js tries to load it.
    //
    // Key insight: `var createFFmpegCore` at top-level of the blob becomes
    // a property of the Worker global scope (self.createFFmpegCore).
    // We just need to make sure the UMD tail of ffmpeg-core.js doesn't
    // route to module.exports. In a Worker there's no `module` or `exports`
    // by default, so the UMD tail should hit the global assignment path.
    //
    // The actual UMD tail of ffmpeg-core.js:
    //   if (typeof exports === 'object' && typeof module === 'object')
    //     module.exports = createFFmpegCore;     ← won't match in Worker
    //   else if (typeof define === 'function' && define['amd'])
    //     define([], ...);                        ← won't match
    //   else if (typeof exports === 'object')
    //     exports["createFFmpegCore"] = ...;      ← won't match
    //
    // So in a clean Worker scope, `var createFFmpegCore` stays as the global.
    //
    // BUT: 814.ffmpeg.js is also UMD and its wrapper does:
    //   "object"==typeof exports&&"object"==typeof module?module.exports=t()
    // It wraps with (self, factory) and sets e.FFmpegWASM = t() at the end.
    // The self.onmessage is set inside the factory. So this should work fine.

    const patchedWorkerCode = `
// === Inline ffmpeg-core.js (sets var createFFmpegCore on global scope) ===
${coreText}

// === Make importScripts a no-op (must NOT throw!) ===
// When 814.ffmpeg.js does try{importScripts(r)}catch{...}, the no-op
// returns undefined (no throw), so the worker skips the catch block
// and proceeds expecting self.createFFmpegCore to exist — which it does.
self.importScripts = function() {};

// === Original 814.ffmpeg.js worker code ===
${workerText}
`;

    const workerBlobURL = URL.createObjectURL(
        new Blob([patchedWorkerCode], { type: "text/javascript" })
    );

    // Load main UMD bundle via script tag (sets globalThis.FFmpegWASM)
    const mainBlobURL = URL.createObjectURL(
        new Blob([mainText], { type: "text/javascript" })
    );
    await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = mainBlobURL;
        script.onload = () => { URL.revokeObjectURL(mainBlobURL); resolve(); };
        script.onerror = reject;
        document.head.appendChild(script);
    });

    if (onProgress) onProgress(20, "FFmpeg laden...");

    const { FFmpeg } = globalThis.FFmpegWASM;
    ffmpegInstance = new FFmpeg();

    ffmpegInstance.on("progress", ({ progress }) => {
        if (onProgress) onProgress(30 + Math.round(progress * 70), "WASM laden...");
    });

    // coreURL: CDN URL (used by createFFmpegCore to derive wasmURL path)
    // wasmURL: blob URL (WASM binary, fetched by emscripten)
    // classWorkerURL: our self-contained blob worker
    await ffmpegInstance.load({
        coreURL: `${coreBase}/ffmpeg-core.js`,
        wasmURL: wasmBlobURL,
        classWorkerURL: workerBlobURL,
    });

    if (onProgress) onProgress(100, "Bereit");
    ffmpegLoaded = true;
    return ffmpegInstance;
}

/**
 * Fetch URL as text.
 */
async function fetchAsText(url) {
    const resp = await fetch(url);
    return resp.text();
}

/**
 * Fetch a URL and return it as a blob URL. Reports download progress.
 */
async function fetchAsBlobURL(url, mimeType, onProgress) {
    const resp = await fetch(url);
    const contentLength = parseInt(resp.headers.get("Content-Length") || "0");

    if (!contentLength || !resp.body) {
        // No streaming – simple fallback
        const buf = await resp.arrayBuffer();
        if (onProgress) onProgress(100);
        return URL.createObjectURL(new Blob([buf], { type: mimeType }));
    }

    // Stream with progress
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress) onProgress(Math.round((received / contentLength) * 100));
    }

    const buf = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        buf.set(chunk, offset);
        offset += chunk.length;
    }

    return URL.createObjectURL(new Blob([buf], { type: mimeType }));
}

/**
 * Write a File/Blob into the ffmpeg virtual filesystem.
 */
export async function writeFile(name, file) {
    const ffmpeg = await loadFFmpeg();
    const data = new Uint8Array(await file.arrayBuffer());
    await ffmpeg.writeFile(name, data);
}

/**
 * Run silence detection on a file already in the ffmpeg FS.
 * Returns { segments: [...], silences: [...], totalDuration: number }
 */
export async function detectSilence(inputName, noiseDb = -35, minSilence = 0.7, minSpeech = 0.3, padding = 0.05) {
    const ffmpeg = await loadFFmpeg();

    let logBuffer = "";
    const logHandler = ({ message }) => {
        logBuffer += message + "\n";
    };
    ffmpeg.on("log", logHandler);

    try {
        await ffmpeg.exec([
            "-i", inputName,
            "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
            "-f", "null",
            "-"
        ]);
    } catch (e) {
        // ffmpeg.wasm may throw on -f null, but logs are still captured
    }

    ffmpeg.off("log", logHandler);

    // Parse duration from logs
    let totalDuration = 0;
    const durMatch = logBuffer.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (durMatch) {
        totalDuration = parseInt(durMatch[1]) * 3600 +
                        parseInt(durMatch[2]) * 60 +
                        parseFloat(durMatch[3]);
    }

    // Parse silence intervals
    const silences = [];
    const starts = [...logBuffer.matchAll(/silence_start:\s*([\d.]+)/g)];
    const ends = [...logBuffer.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];

    for (let i = 0; i < starts.length; i++) {
        const s = parseFloat(starts[i][1]);
        const e = i < ends.length ? parseFloat(ends[i][1]) : totalDuration;
        const d = i < ends.length ? parseFloat(ends[i][2]) : totalDuration - s;
        silences.push({ start: s, end: e, duration: d });
    }

    // Derive speech segments (gaps between silences)
    const segments = [];
    let prevEnd = 0;

    for (const s of silences) {
        let segStart = Math.max(0, prevEnd - padding);
        let segEnd = Math.min(totalDuration, s.start + padding);
        const dur = segEnd - segStart;

        if (dur >= minSpeech) {
            segments.push({
                index: segments.length,
                start: round3(segStart),
                end: round3(segEnd),
                duration: round3(dur),
            });
        }
        prevEnd = s.end;
    }

    // Trailing speech after last silence
    if (prevEnd < totalDuration) {
        const segStart = Math.max(0, prevEnd - padding);
        const dur = totalDuration - segStart;
        if (dur >= minSpeech) {
            segments.push({
                index: segments.length,
                start: round3(segStart),
                end: round3(totalDuration),
                duration: round3(dur),
            });
        }
    }

    return { segments, silences, totalDuration };
}

/**
 * Extract a single segment as WAV (16kHz mono for Whisper).
 * Returns Blob of the WAV file.
 */
export async function extractSegmentWav(inputName, segment) {
    const ffmpeg = await loadFFmpeg();
    const outName = `seg_${segment.index}.wav`;

    await ffmpeg.exec([
        "-i", inputName,
        "-ss", String(segment.start),
        "-to", String(segment.end),
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        "-y", outName
    ]);

    const data = await ffmpeg.readFile(outName);
    try { await ffmpeg.deleteFile(outName); } catch (_) {}

    return new Blob([data.buffer], { type: "audio/wav" });
}

/**
 * Compute basic audio metrics for a segment via volumedetect.
 */
export async function computeAudioMetrics(inputName, segment) {
    const ffmpeg = await loadFFmpeg();
    let logBuffer = "";
    const logHandler = ({ message }) => { logBuffer += message + "\n"; };
    ffmpeg.on("log", logHandler);

    try {
        await ffmpeg.exec([
            "-i", inputName,
            "-ss", String(segment.start),
            "-to", String(segment.end),
            "-af", "volumedetect",
            "-f", "null", "-"
        ]);
    } catch (_) {}

    ffmpeg.off("log", logHandler);

    const metrics = {};
    const meanMatch = logBuffer.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    const maxMatch = logBuffer.match(/max_volume:\s*([-\d.]+)\s*dB/);
    if (meanMatch) metrics.mean_volume_db = parseFloat(meanMatch[1]);
    if (maxMatch) metrics.max_volume_db = parseFloat(maxMatch[1]);

    const mean = metrics.mean_volume_db ?? -70;
    metrics.quality_estimate = mean > -5 ? "loud/clipping" :
                               mean < -30 ? "quiet" : "good";

    return metrics;
}

function round3(n) {
    return Math.round(n * 1000) / 1000;
}
