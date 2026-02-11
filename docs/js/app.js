/**
 * Silence Cutter – Main Controller
 * Orchestrates the full client-side pipeline.
 */

import { loadFFmpeg, writeFile, getInputPath, detectSilence, extractSegmentWav, computeAudioMetrics, renderCutFile } from "./silence.js";
import { loadWhisperModel, transcribeAllSegments, groupSimilarTakes } from "./transcribe.js";
import { getApiKey, setApiKey, evaluateTakes, applyEvaluation } from "./evaluate.js";
import { generateFCPXML, generateEDL, generateReport, downloadString } from "./export.js";
import {
    initScreens, showScreen, resetProgress, setStep, completeAllSteps,
    setProcessingStats, setProcessingFilename, renderResults, renderTimeline,
    renderGroups, updateGroupSelection, updateSummaryDuration, showError,
} from "./ui.js";

// ── State ──
let state = {
    file: null,
    filename: "",
    segments: [],
    wavBlobs: [],
    groups: [],
    bestTakes: [],
    totalDuration: 0,
    finalDuration: 0,
    suggestedOrder: [],
    overallNotes: "",
    settings: {},
    cutBlob: null,
    cutBlobURL: null,
    inputPath: null,
};

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
    initScreens();
    initUpload();
    initSettings();
    initButtons();
    initApiKey();
});

// ── Upload ──
function initUpload() {
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");

    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", e => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length) startPipeline(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length) startPipeline(fileInput.files[0]);
    });
}

// ── Settings ──
function initSettings() {
    bindSlider("noise-threshold", "noise-threshold-val", " dB");
    bindSlider("min-silence", "min-silence-val", "s");
    bindSlider("min-speech", "min-speech-val", "s");
    bindSlider("similarity-threshold", "similarity-threshold-val", "%", v => Math.round(v * 100));
}

function bindSlider(id, valId, suffix, transform) {
    const el = document.getElementById(id);
    const valEl = document.getElementById(valId);
    if (!el || !valEl) return;
    el.addEventListener("input", () => {
        const v = transform ? transform(el.value) : el.value;
        valEl.textContent = v + suffix;
    });
}

function readSettings() {
    return {
        noiseThreshold: parseInt(document.getElementById("noise-threshold").value),
        minSilence: parseFloat(document.getElementById("min-silence").value),
        minSpeech: parseFloat(document.getElementById("min-speech").value),
        whisperModel: document.getElementById("whisper-model").value,
        whisperLanguage: document.getElementById("whisper-language").value,
        similarityThreshold: parseFloat(document.getElementById("similarity-threshold").value),
        fps: parseInt(document.getElementById("fps").value),
    };
}

// ── API Key ──
function initApiKey() {
    const input = document.getElementById("api-key-input");
    // Only show user-saved key, not the built-in default
    const saved = localStorage.getItem("silence_cutter_api_key");
    if (saved) input.value = saved;

    input.addEventListener("change", () => setApiKey(input.value));
    input.addEventListener("blur", () => setApiKey(input.value));
}

// ── Buttons ──
function initButtons() {
    document.getElementById("btn-download-xml").addEventListener("click", downloadXML);
    document.getElementById("btn-download-edl").addEventListener("click", downloadEDL);
    document.getElementById("btn-download-json").addEventListener("click", downloadJSON);
    document.getElementById("btn-download-cut").addEventListener("click", downloadCutFile);
    document.getElementById("btn-rerender").addEventListener("click", rerenderCutFile);
    document.getElementById("btn-new").addEventListener("click", () => {
        // Revoke old blob URL
        if (state.cutBlobURL) URL.revokeObjectURL(state.cutBlobURL);
        state = { file: null, filename: "", segments: [], wavBlobs: [], groups: [], bestTakes: [], totalDuration: 0, finalDuration: 0, suggestedOrder: [], overallNotes: "", settings: {}, cutBlob: null, cutBlobURL: null, inputPath: null };
        document.getElementById("file-input").value = "";
        document.getElementById("preview-section").style.display = "none";
        // Reset large file WORKERFS path
        import("./silence.js").then(m => { if (m.resetWorkerFS) m.resetWorkerFS(); });
        showScreen("upload");
    });
    document.getElementById("btn-retry").addEventListener("click", () => showScreen("upload"));
}

// ── Downloads ──
function downloadXML() {
    const xml = generateFCPXML(state.bestTakes, state.filename, state.totalDuration, state.settings.fps);
    const base = state.filename.replace(/\.[^.]+$/, "");
    downloadString(xml, `${base}_edit.xml`, "application/xml");
}

function downloadEDL() {
    const edl = generateEDL(state.bestTakes, state.filename, state.settings.fps);
    const base = state.filename.replace(/\.[^.]+$/, "");
    downloadString(edl, `${base}_edit.edl`, "text/plain");
}

function downloadJSON() {
    const json = generateReport(state.bestTakes, state.groups, state.suggestedOrder, state.overallNotes, state.filename, state.totalDuration);
    const base = state.filename.replace(/\.[^.]+$/, "");
    downloadString(json, `${base}_report.json`, "application/json");
}

// ── Main Pipeline ──
async function startPipeline(file) {
    state.file = file;
    state.filename = file.name;
    state.settings = readSettings();

    setProcessingFilename(file.name);
    showScreen("processing");
    resetProgress();

    try {
        // For large files (>500MB): validate file is readable before starting
        // the slow FFmpeg download. This catches permission errors early.
        if (file.size > 500 * 1024 * 1024) {
            setProcessingStats("Prüfe Dateizugriff...");
            try {
                // Read first byte to verify the File handle is valid
                await file.slice(0, 1).arrayBuffer();
            } catch (e) {
                throw new Error(
                    `Datei konnte nicht gelesen werden (${(file.size / 1024 / 1024).toFixed(0)} MB). ` +
                    `Tipp: Datei per Klick-Button auswählen statt Drag & Drop, ` +
                    `oder in einen anderen Ordner (z.B. Desktop) kopieren. (${e.message})`
                );
            }
        }

        // Step 1: Load FFmpeg.wasm
        setStep("loading_ffmpeg", 0, 0);
        setProcessingStats("FFmpeg.wasm wird geladen...");
        await loadFFmpeg((pct, label) => {
            setStep("loading_ffmpeg", pct, 100);
            setProcessingStats(`${label || "Laden"}: ${pct}%`);
        });

        // Write file to ffmpeg virtual FS (large files use WORKERFS mount)
        setProcessingStats("Datei wird geladen...");
        await writeFile("input", file);
        const inputPath = getInputPath("input");

        // Step 2: Silence Detection
        setStep("silence_detection", 0, 0);
        setProcessingStats("Analysiere Audio...");
        const detection = await detectSilence(
            inputPath,
            state.settings.noiseThreshold,
            state.settings.minSilence,
            state.settings.minSpeech,
        );
        state.segments = detection.segments;
        state.totalDuration = detection.totalDuration;

        if (!state.segments.length) {
            showError("Keine Sprach-Segmente gefunden. Versuche einen niedrigeren Silence Threshold.");
            return;
        }

        setProcessingStats(`${state.segments.length} Segmente gefunden \u00B7 ${fmtDur(state.totalDuration)} Gesamtdauer`);

        // Step 3: Extract segments as WAV + audio metrics
        setStep("segment_extraction", 0, state.segments.length);
        state.wavBlobs = [];
        for (let i = 0; i < state.segments.length; i++) {
            const blob = await extractSegmentWav(inputPath, state.segments[i]);
            state.wavBlobs.push(blob);

            // Audio metrics
            const metrics = await computeAudioMetrics(inputPath, state.segments[i]);
            state.segments[i].audio_metrics = metrics;

            setStep("segment_extraction", i + 1, state.segments.length);
        }

        // Step 4: Load Whisper model
        setStep("loading_whisper", 0, 0);
        setProcessingStats("Whisper-Modell wird geladen (~40 MB)...");

        const whisperModelMap = {
            tiny: "Xenova/whisper-tiny",
            base: "Xenova/whisper-base",
            small: "Xenova/whisper-small",
            medium: "Xenova/whisper-medium",
            large: "Xenova/whisper-large-v3",
        };
        const modelId = whisperModelMap[state.settings.whisperModel] || "Xenova/whisper-small";
        await loadWhisperModel(modelId, pct => setProcessingStats(`Whisper-Modell: ${pct}%`));

        // Step 5: Transcription
        setStep("transcription", 0, state.segments.length);
        const whisperLang = state.settings.whisperLanguage === "auto" ? null : state.settings.whisperLanguage;
        await transcribeAllSegments(
            state.segments,
            state.wavBlobs,
            modelId,
            whisperLang,
            (done, total) => {
                setStep("transcription", done, total);
                setProcessingStats(`Transkription: ${done}/${total} Segmente`);
            },
        );

        // Step 6: Group similar takes
        setStep("grouping", 0, 0);
        setProcessingStats("Gruppiere \u00e4hnliche Takes...");
        state.groups = groupSimilarTakes(state.segments, state.settings.similarityThreshold);
        setProcessingStats(`${state.groups.length} Gruppen erstellt`);

        // Step 7: Claude AI Evaluation
        setStep("ai_evaluation", 0, 0);
        setProcessingStats("Claude bewertet Takes...");
        const evaluation = await evaluateTakes(state.groups);
        const evalResult = applyEvaluation(state.groups, evaluation);

        state.bestTakes = evalResult.bestTakes;
        state.suggestedOrder = evalResult.suggestedOrder;
        state.overallNotes = evalResult.overallNotes;
        state.groups = evalResult.groups;

        // Calculate final duration
        state.finalDuration = state.bestTakes.reduce((sum, t) => sum + t.duration, 0);

        // Step 8: Render cut file
        setStep("export", 0, 0);
        setProcessingStats("Geschnittene Datei wird gerendert...");
        state.inputPath = inputPath;

        completeAllSteps();

        // Build timeline data for UI
        const timeline = buildTimeline(state.bestTakes);

        // Show results first, then render in background
        renderResults({
            groups: state.groups,
            timeline,
            totalDuration: state.totalDuration,
            finalDuration: state.finalDuration,
            overallNotes: state.overallNotes,
        }, {
            onSelectTake: handleSelectTake,
        });
        showScreen("results");

        // Render the cut file in background (after results are shown)
        doRenderCutFile().catch(e => console.error("Background render error:", e));

    } catch (err) {
        console.error("Pipeline error:", err);
        const msg = err.stack || err.message || String(err);
        showError(msg);
    }
}

function buildTimeline(bestTakes) {
    let pos = 0;
    return bestTakes.map(take => {
        const entry = {
            index: take.index,
            start: take.start,
            end: take.end,
            duration: take.duration,
            timeline_start: round3(pos),
            timeline_end: round3(pos + take.duration),
            text: take.transcription?.text || "",
            ai_scores: take.ai_scores || {},
        };
        pos += take.duration;
        return entry;
    });
}

function handleSelectTake(groupId, segIndex) {
    // Update is_best in state
    const group = state.groups[groupId];
    if (!group) return;

    for (const take of group.takes) {
        take.is_best = (take.index === segIndex);
    }

    // Rebuild bestTakes from all groups in order
    state.bestTakes = [];
    const order = state.suggestedOrder.length ? state.suggestedOrder : state.groups.map((_, i) => i);
    for (const gid of order) {
        const g = state.groups[gid];
        if (!g) continue;
        const best = g.takes.find(t => t.is_best);
        if (best) state.bestTakes.push(best);
    }

    state.finalDuration = state.bestTakes.reduce((sum, t) => sum + t.duration, 0);

    // Update UI
    updateGroupSelection(groupId, segIndex);
    renderTimeline(buildTimeline(state.bestTakes));
    updateSummaryDuration(state.finalDuration, state.totalDuration);
}

// ── Cut File Download & Rerender ──
function downloadCutFile() {
    if (!state.cutBlob) return;
    const isVideo = /\.(mp4|mov|mkv|webm)$/i.test(state.filename);
    const ext = isVideo ? "mp4" : "mp3";
    const base = state.filename.replace(/\.[^.]+$/, "");
    const url = URL.createObjectURL(state.cutBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}_cut.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function rerenderCutFile() {
    if (!state.bestTakes.length || !state.inputPath) return;
    await doRenderCutFile();
}

async function doRenderCutFile() {
    const previewSection = document.getElementById("preview-section");
    const videoEl = document.getElementById("preview-video");
    const audioEl = document.getElementById("preview-audio");
    const isVideo = /\.(mp4|mov|mkv|webm)$/i.test(state.filename);

    // Show rendering progress
    previewSection.style.display = "block";
    videoEl.style.display = "none";
    audioEl.style.display = "none";

    // Add or update rendering indicator
    let renderInfo = previewSection.querySelector(".preview-rendering");
    if (!renderInfo) {
        renderInfo = document.createElement("div");
        renderInfo.className = "preview-rendering";
        renderInfo.innerHTML = '<div class="render-label">Rendering...</div><div class="render-progress"><div class="render-progress-bar"></div></div>';
        previewSection.querySelector(".preview-player-wrap").before(renderInfo);
    }
    renderInfo.style.display = "block";
    const progressBar = renderInfo.querySelector(".render-progress-bar");
    const renderLabel = renderInfo.querySelector(".render-label");

    try {
        // Revoke old URL
        if (state.cutBlobURL) {
            URL.revokeObjectURL(state.cutBlobURL);
            state.cutBlobURL = null;
        }

        state.cutBlob = await renderCutFile(
            state.inputPath,
            state.bestTakes,
            state.filename,
            (pct, label) => {
                progressBar.style.width = pct + "%";
                renderLabel.textContent = `${label || "Rendering"} ${pct}%`;
            }
        );

        state.cutBlobURL = URL.createObjectURL(state.cutBlob);

        // Show the right player
        renderInfo.style.display = "none";
        if (isVideo) {
            videoEl.src = state.cutBlobURL;
            videoEl.style.display = "block";
            audioEl.style.display = "none";
        } else {
            audioEl.src = state.cutBlobURL;
            audioEl.style.display = "block";
            videoEl.style.display = "none";
        }

        // Update download button text
        const dlBtn = document.getElementById("btn-download-cut");
        dlBtn.textContent = isVideo ? "Geschnittenes Video herunterladen" : "Geschnittenes Audio herunterladen";

    } catch (e) {
        console.error("Render error:", e);
        renderInfo.style.display = "block";
        renderLabel.textContent = "Render-Fehler: " + (e.message || String(e));
        progressBar.style.width = "0%";
    }
}

// ── Helpers ──
function fmtDur(s) {
    if (!s || s <= 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ":" + String(sec).padStart(2, "0");
}

function round3(n) { return Math.round(n * 1000) / 1000; }
