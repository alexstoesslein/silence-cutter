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
    // ffmpeg-core.js is embedded directly as executable code at the top of the
    // worker (not as a string, not via eval, not via importScripts).
    // This sets `var createFFmpegCore` in the Worker's global scope.
    //
    // The worker code that follows uses self.createFFmpegCore which is the same
    // as the top-level var in a Worker (Worker global scope = self).

    const workerWithCore = `
// ============================================================
// Part 1: ffmpeg-core.js (UMD) — sets var createFFmpegCore
// ============================================================
${coreText}

// ============================================================
// Part 2: Custom worker message handler
// ============================================================
var ffmpegCore = null;

self.onmessage = async function({ data: { id, type, data } }) {
    var transferables = [];
    var result;
    try {
        if (type !== "LOAD" && !ffmpegCore) {
            throw new Error("ffmpeg is not loaded, call ffmpeg.load() first");
        }
        switch (type) {
            case "LOAD": {
                var isFirst = !ffmpegCore;
                var coreURL = data.coreURL || "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js";
                var wasmURL = data.wasmURL || coreURL.replace(/.js$/g, ".wasm");
                var workerURL = data.workerURL || coreURL.replace(/.js$/g, ".worker.js");

                ffmpegCore = await createFFmpegCore({
                    mainScriptUrlOrBlob: coreURL + "#" + btoa(JSON.stringify({
                        wasmURL: wasmURL,
                        workerURL: workerURL
                    }))
                });
                ffmpegCore.setLogger(function(msg) { self.postMessage({ type: "LOG", data: msg }); });
                ffmpegCore.setProgress(function(p) { self.postMessage({ type: "PROGRESS", data: p }); });
                result = isFirst;
                break;
            }
            case "EXEC": {
                var timeout = (data.timeout != null) ? data.timeout : -1;
                ffmpegCore.setTimeout(timeout);
                ffmpegCore.exec.apply(ffmpegCore, data.args);
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
                var entries = ffmpegCore.FS.readdir(data.path);
                result = [];
                for (var i = 0; i < entries.length; i++) {
                    var stat = ffmpegCore.FS.stat(data.path + "/" + entries[i]);
                    result.push({ name: entries[i], isDir: ffmpegCore.FS.isDir(stat.mode) });
                }
                break;
            }
            case "DELETE_DIR": {
                ffmpegCore.FS.rmdir(data.path);
                result = true;
                break;
            }
            case "MOUNT": {
                var fs = ffmpegCore.FS.filesystems[data.fsType];
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
        self.postMessage({ id: id, type: "ERROR", data: e.toString() });
        return;
    }
    if (result instanceof Uint8Array) transferables.push(result.buffer);
    self.postMessage({ id: id, type: type, data: result }, transferables);
};
`;

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
 * For large files (>500MB), uses WORKERFS mount to avoid memory limits.
 * For smaller files, reads into memory and writes to ffmpeg FS.
 *
 * Note: File references from drag&drop can become stale. Call this
 * as soon as possible after obtaining the File, or pass a Blob copy.
 */
export async function writeFile(name, file) {
    const ffmpeg = await loadFFmpeg();
    const CHUNK_LIMIT = 500 * 1024 * 1024; // 500 MB

    if (file.size <= CHUNK_LIMIT) {
        let buf;
        try {
            buf = await file.arrayBuffer();
        } catch (e) {
            throw new Error(
                `Datei konnte nicht gelesen werden (${(file.size / 1024 / 1024).toFixed(0)} MB). ` +
                `Tipp: Datei per Klick auswählen statt Drag & Drop, oder in einen anderen Ordner kopieren. ` +
                `(${e.message})`
            );
        }
        const data = new Uint8Array(buf);
        await ffmpeg.writeFile(name, data);
        return;
    }

    // Large file: mount via WORKERFS so ffmpeg reads directly from the Blob
    // This avoids loading the entire file into WASM memory at once.
    const mountPoint = "/workerfs";
    try {
        await ffmpeg.createDir(mountPoint);
    } catch (_) {
        // Directory may already exist
    }
    await ffmpeg.mount("WORKERFS", { files: [file] }, mountPoint);

    // The file is now at /workerfs/<original filename>
    const mountedPath = `${mountPoint}/${file.name}`;
    workerFSPath = mountedPath;
}

// Track if we're using WORKERFS (large file mode)
let workerFSPath = null;

/**
 * Get the actual input path for ffmpeg commands.
 * Returns the WORKERFS path for large files, or the given name for small files.
 */
export function getInputPath(name) {
    return workerFSPath || name;
}

/**
 * Reset WORKERFS state for a new file.
 */
export function resetWorkerFS() {
    workerFSPath = null;
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
