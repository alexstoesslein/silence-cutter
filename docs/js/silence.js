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
 * The original 814.ffmpeg.js worker uses importScripts() to load ffmpeg-core.js,
 * which fails cross-origin from a blob Worker on GitHub Pages.
 * Instead of patching the original worker, we write a replacement worker that
 * speaks the exact same postMessage protocol but loads ffmpeg-core.js inline.
 */
export async function loadFFmpeg(onProgress) {
    if (ffmpegLoaded && ffmpegInstance) return ffmpegInstance;

    const coreBase = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
    const ffmpegBase = "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd";

    if (onProgress) onProgress(0, "Downloads starten...");

    // Download main lib text, core JS text, and WASM as blob URL in parallel
    const [mainText, coreText, wasmBlobURL] = await Promise.all([
        fetchAsText(`${ffmpegBase}/ffmpeg.js`),
        fetchAsText(`${coreBase}/ffmpeg-core.js`),
        fetchAsBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
    ]);

    if (onProgress) onProgress(15, "FFmpeg initialisieren...");

    // Build a custom worker that replaces 814.ffmpeg.js entirely.
    // It implements the same message protocol (LOAD, EXEC, WRITE_FILE, etc.)
    // but loads ffmpeg-core.js via inline eval() instead of importScripts().
    const customWorkerCode = `
// === ffmpeg-core.js will be loaded via eval() during LOAD ===
let ffmpegCore = null;
let coreJsText = null;

self.onmessage = async ({ data: { id, type, data } }) => {
    const transferables = [];
    let result;
    try {
        if (type !== "LOAD" && !ffmpegCore) {
            throw new Error("ffmpeg is not loaded, call ffmpeg.load() first");
        }
        switch (type) {
            case "LOAD": {
                const isFirst = !ffmpegCore;
                const { coreURL, wasmURL, workerURL } = data;

                // Load ffmpeg-core.js via eval (already embedded as text)
                if (!self.createFFmpegCore) {
                    // The core text is injected as a string literal below
                    (0, eval)(coreJsText);
                    // After eval, createFFmpegCore should be a global var
                    if (typeof createFFmpegCore === 'undefined') {
                        throw new Error("eval of ffmpeg-core.js did not define createFFmpegCore");
                    }
                    self.createFFmpegCore = createFFmpegCore;
                }

                const actualCoreURL = coreURL || "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js";
                const actualWasmURL = wasmURL || actualCoreURL.replace(/.js$/g, ".wasm");
                const actualWorkerURL = workerURL || actualCoreURL.replace(/.js$/g, ".worker.js");

                ffmpegCore = await self.createFFmpegCore({
                    mainScriptUrlOrBlob: actualCoreURL + "#" + btoa(JSON.stringify({
                        wasmURL: actualWasmURL,
                        workerURL: actualWorkerURL
                    }))
                });
                ffmpegCore.setLogger((msg) => self.postMessage({ type: "LOG", data: msg }));
                ffmpegCore.setProgress((p) => self.postMessage({ type: "PROGRESS", data: p }));
                result = isFirst;
                break;
            }
            case "EXEC": {
                const { args, timeout = -1 } = data;
                ffmpegCore.setTimeout(timeout);
                ffmpegCore.exec(...args);
                result = ffmpegCore.ret;
                ffmpegCore.reset();
                break;
            }
            case "WRITE_FILE": {
                ffmpegCore.FS.writeFile(data.path, data.data);
                result = true;
                break;
            }
            case "READ_FILE": {
                result = ffmpegCore.FS.readFile(data.path, { encoding: data.encoding });
                break;
            }
            case "DELETE_FILE": {
                ffmpegCore.FS.unlink(data.path);
                result = true;
                break;
            }
            case "RENAME": {
                ffmpegCore.FS.rename(data.oldPath, data.newPath);
                result = true;
                break;
            }
            case "CREATE_DIR": {
                ffmpegCore.FS.mkdir(data.path);
                result = true;
                break;
            }
            case "LIST_DIR": {
                const entries = ffmpegCore.FS.readdir(data.path);
                result = [];
                for (const name of entries) {
                    const stat = ffmpegCore.FS.stat(data.path + "/" + name);
                    result.push({ name, isDir: ffmpegCore.FS.isDir(stat.mode) });
                }
                break;
            }
            case "DELETE_DIR": {
                ffmpegCore.FS.rmdir(data.path);
                result = true;
                break;
            }
            case "MOUNT": {
                const fs = ffmpegCore.FS.filesystems[data.fsType];
                if (fs) { ffmpegCore.FS.mount(fs, data.options, data.mountPoint); result = true; }
                else { result = false; }
                break;
            }
            case "UNMOUNT": {
                ffmpegCore.FS.unmount(data.mountPoint);
                result = true;
                break;
            }
            default:
                throw new Error("unknown message type");
        }
    } catch (e) {
        self.postMessage({ id, type: "ERROR", data: e.toString() });
        return;
    }
    if (result instanceof Uint8Array) transferables.push(result.buffer);
    self.postMessage({ id, type, data: result }, transferables);
};
`;

    // Inject the core JS text as a string literal into the worker
    // We use JSON.stringify to safely escape the entire source code
    const workerWithCore = customWorkerCode.replace(
        'let coreJsText = null;',
        'let coreJsText = ' + JSON.stringify(coreText) + ';'
    );

    const workerBlobURL = URL.createObjectURL(
        new Blob([workerWithCore], { type: "text/javascript" })
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

    // coreURL: CDN URL (used by createFFmpegCore internally to derive paths)
    // wasmURL: blob URL (WASM binary pre-downloaded)
    // classWorkerURL: our custom replacement worker
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
