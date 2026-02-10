/**
 * Silence Cutter – Main Controller
 * Orchestrates the full client-side pipeline.
 */

import { loadFFmpeg, writeFile, detectSilence, extractSegmentWav, computeAudioMetrics } from "./silence.js";
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
        similarityThreshold: parseFloat(document.getElementById("similarity-threshold").value),
        fps: parseInt(document.getElementById("fps").value),
    };
}

// ── API Key ──
function initApiKey() {
    const input = document.getElementById("api-key-input");
    const saved = getApiKey();
    if (saved) input.value = saved;

    input.addEventListener("change", () => setApiKey(input.value));
    input.addEventListener("blur", () => setApiKey(input.value));
}

// ── Buttons ──
function initButtons() {
    document.getElementById("btn-download-xml").addEventListener("click", downloadXML);
    document.getElementById("btn-download-edl").addEventListener("click", downloadEDL);
    document.getElementById("btn-download-json").addEventListener("click", downloadJSON);
    document.getElementById("btn-new").addEventListener("click", () => {
        state = { file: null, filename: "", segments: [], wavBlobs: [], groups: [], bestTakes: [], totalDuration: 0, finalDuration: 0, suggestedOrder: [], overallNotes: "", settings: {} };
        document.getElementById("file-input").value = "";
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
        // Step 1: Load FFmpeg.wasm
        setStep("loading_ffmpeg", 0, 0);
        setProcessingStats("FFmpeg.wasm wird geladen...");
        await loadFFmpeg((pct, label) => {
            setStep("loading_ffmpeg", pct, 100);
            setProcessingStats(`${label || "Laden"}: ${pct}%`);
        });

        // Write file to ffmpeg virtual FS
        setProcessingStats("Datei wird geladen...");
        await writeFile("input", file);

        // Step 2: Silence Detection
        setStep("silence_detection", 0, 0);
        setProcessingStats("Analysiere Audio...");
        const detection = await detectSilence(
            "input",
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
            const blob = await extractSegmentWav("input", state.segments[i]);
            state.wavBlobs.push(blob);

            // Audio metrics
            const metrics = await computeAudioMetrics("input", state.segments[i]);
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
        await transcribeAllSegments(
            state.segments,
            state.wavBlobs,
            modelId,
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

        // Step 8: Export ready
        setStep("export", 0, 0);
        setProcessingStats("Fertig!");

        completeAllSteps();

        // Build timeline data for UI
        const timeline = buildTimeline(state.bestTakes);

        // Show results
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

    } catch (err) {
        console.error("Pipeline error:", err);
        showError(err.message || "Unbekannter Fehler");
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

// ── Helpers ──
function fmtDur(s) {
    if (!s || s <= 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ":" + String(sec).padStart(2, "0");
}

function round3(n) { return Math.round(n * 1000) / 1000; }
