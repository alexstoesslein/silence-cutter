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
 * Load FFmpeg.wasm (one-time, ~30MB download from CDN).
 * All resources are converted to blob URLs so Workers run same-origin.
 */
export async function loadFFmpeg(onProgress) {
    if (ffmpegLoaded && ffmpegInstance) return ffmpegInstance;

    // Step 1: Fetch the worker chunk and create a blob URL for it
    const workerChunkResp = await fetch(
        "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js"
    );
    const workerChunkText = await workerChunkResp.text();
    const workerChunkBlob = new Blob([workerChunkText], { type: "text/javascript" });
    const workerChunkBlobURL = URL.createObjectURL(workerChunkBlob);

    // Step 2: Fetch the main ffmpeg.js UMD bundle and patch the chunk URL
    const mainResp = await fetch(
        "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js"
    );
    let mainText = await mainResp.text();

    // The UMD bundle constructs worker URL via: new URL(e.p + e.u(814), e.b)
    // where e.p is the public path and e.u(814) returns "814.ffmpeg.js"
    // We need to patch it so the worker blob URL is used instead.
    // We do this by injecting classWorkerURL at load time (see below).

    // Load the UMD bundle
    const mainBlob = new Blob([mainText], { type: "text/javascript" });
    const mainBlobURL = URL.createObjectURL(mainBlob);

    // Execute via script tag (UMD sets globalThis.FFmpegWASM)
    await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = mainBlobURL;
        script.onload = () => { URL.revokeObjectURL(mainBlobURL); resolve(); };
        script.onerror = reject;
        document.head.appendChild(script);
    });

    const { FFmpeg } = globalThis.FFmpegWASM;

    ffmpegInstance = new FFmpeg();

    ffmpegInstance.on("progress", ({ progress }) => {
        if (onProgress) onProgress(Math.round(progress * 100));
    });

    // Step 3: Load core WASM files as blob URLs
    const coreBase = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

    const [coreURL, wasmURL] = await Promise.all([
        fetchAsBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
        fetchAsBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
    ]);

    await ffmpegInstance.load({
        coreURL,
        wasmURL,
        classWorkerURL: workerChunkBlobURL,
    });

    ffmpegLoaded = true;
    return ffmpegInstance;
}

/**
 * Fetch a URL and return it as a blob URL (same-origin).
 */
async function fetchAsBlobURL(url, mimeType) {
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    const blob = new Blob([buf], { type: mimeType });
    return URL.createObjectURL(blob);
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
