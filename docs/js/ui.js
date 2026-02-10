/**
 * UI Rendering – manages screens, progress, results display.
 */

// ── Screen Management ──

const screens = {};

export function initScreens() {
    for (const el of document.querySelectorAll(".screen")) {
        screens[el.id.replace("screen-", "")] = el;
    }
}

export function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove("active"));
    if (screens[name]) screens[name].classList.add("active");
}

// ── Progress ──

const STEP_LABELS = {
    loading_ffmpeg: "FFmpeg.wasm laden",
    silence_detection: "Stille erkennen",
    segment_extraction: "Segmente extrahieren",
    loading_whisper: "Whisper-Modell laden",
    transcription: "Transkription",
    grouping: "Takes gruppieren",
    ai_evaluation: "AI Bewertung (Claude)",
    export: "Export generieren",
};

const STEP_ORDER = Object.keys(STEP_LABELS);

export function resetProgress() {
    document.querySelectorAll(".step").forEach(el => {
        el.classList.remove("active", "done");
        el.querySelector(".step-status").textContent = "";
        const icon = el.querySelector(".step-icon");
        // Reset icon to number
        const idx = STEP_ORDER.indexOf(el.dataset.step);
        if (idx >= 0) icon.textContent = String(idx + 1);
    });
    setProgressBar(0);
    document.getElementById("processing-stats").textContent = "";
}

export function setStep(stepName, subProgress, subTotal) {
    const currentIdx = STEP_ORDER.indexOf(stepName);

    document.querySelectorAll(".step").forEach(el => {
        const step = el.dataset.step;
        const idx = STEP_ORDER.indexOf(step);

        el.classList.remove("active", "done");
        if (idx < currentIdx) {
            el.classList.add("done");
            el.querySelector(".step-icon").textContent = "\u2713";
        } else if (idx === currentIdx) {
            el.classList.add("active");
            el.querySelector(".step-status").textContent =
                subTotal > 0 ? `${subProgress} / ${subTotal}` : "";
        }
    });

    // Overall progress
    const totalSteps = STEP_ORDER.length;
    let pct = (currentIdx / totalSteps) * 100;
    if (subTotal > 0) {
        pct += (subProgress / subTotal / totalSteps) * 100;
    }
    setProgressBar(Math.min(Math.round(pct), 100));
}

export function completeAllSteps() {
    document.querySelectorAll(".step").forEach(el => {
        el.classList.remove("active");
        el.classList.add("done");
        el.querySelector(".step-icon").textContent = "\u2713";
    });
    setProgressBar(100);
}

export function setProgressBar(pct) {
    document.getElementById("progress-bar").style.width = pct + "%";
}

export function setProcessingStats(text) {
    document.getElementById("processing-stats").textContent = text;
}

export function setProcessingFilename(name) {
    document.getElementById("processing-filename").textContent = name;
}

// ── Results Rendering ──

export function renderResults(data, callbacks) {
    renderSummary(data);
    renderAINotes(data.overallNotes);
    renderTimeline(data.timeline);
    renderGroups(data.groups, callbacks.onSelectTake);
}

function renderSummary(data) {
    const el = document.getElementById("results-summary");
    const cutPct = data.totalDuration > 0
        ? Math.round((1 - data.finalDuration / data.totalDuration) * 100)
        : 0;

    el.innerHTML = `
        <div class="stat"><div class="stat-value">${data.groups.length}</div><div class="stat-label">Gruppen</div></div>
        <div class="stat"><div class="stat-value">${data.timeline.length}</div><div class="stat-label">Ausgew\u00e4hlte Takes</div></div>
        <div class="stat"><div class="stat-value">${fmtDur(data.totalDuration)}</div><div class="stat-label">Original</div></div>
        <div class="stat"><div class="stat-value">${fmtDur(data.finalDuration)}</div><div class="stat-label">Geschnitten</div></div>
        <div class="stat"><div class="stat-value">${cutPct}%</div><div class="stat-label">Gek\u00fcrzt</div></div>
    `;
}

function renderAINotes(notes) {
    const el = document.getElementById("ai-notes");
    if (notes) {
        el.innerHTML = `<div class="ai-notes-label">AI Anmerkungen</div>${escHtml(notes)}`;
        el.classList.add("visible");
    } else {
        el.classList.remove("visible");
    }
}

export function renderTimeline(timeline) {
    const container = document.getElementById("timeline");
    container.innerHTML = "";

    if (!timeline.length) {
        container.innerHTML = '<div style="padding:20px;color:var(--text-dim)">Keine Takes</div>';
        return;
    }

    const maxDur = Math.max(...timeline.map(t => t.duration));

    for (const clip of timeline) {
        const el = document.createElement("div");
        el.className = "timeline-clip";
        el.style.width = Math.max(60, (clip.duration / maxDur) * 300) + "px";

        const text = clip.text || clip.transcription?.text || "";
        el.innerHTML = `
            <span class="clip-time">${clip.duration.toFixed(1)}s</span>
            <span class="clip-text" title="${escHtml(text)}">${escHtml(truncate(text, 40))}</span>
        `;
        container.appendChild(el);
    }
}

export function renderGroups(groups, onSelectTake) {
    const container = document.getElementById("groups-list");
    container.innerHTML = "";

    for (const group of groups) {
        const card = document.createElement("div");
        card.className = "group-card";
        card.dataset.groupId = group.group_id;

        const header = document.createElement("div");
        header.className = "group-header";
        header.innerHTML = `
            <span class="group-title">Gruppe ${group.group_id + 1}: "${escHtml(truncate(group.text_summary, 60))}"</span>
            <span class="group-badge">${group.take_count} Take${group.take_count !== 1 ? "s" : ""}</span>
        `;
        header.addEventListener("click", () => card.classList.toggle("open"));

        const body = document.createElement("div");
        body.className = "group-body";

        for (const take of group.takes) {
            const row = document.createElement("div");
            row.className = "take-row" + (take.is_best ? " selected" : "");
            row.dataset.segIndex = take.index;

            const scores = take.ai_scores || {};
            const text = take.transcription?.text || take.text || "(kein Text)";
            const metrics = take.audio_metrics || {};

            row.innerHTML = `
                <div class="take-radio"></div>
                <div class="take-info">
                    <div class="take-text">${escHtml(text)}</div>
                    <div class="take-meta">
                        Take ${take.index} \u00B7 ${take.duration.toFixed(1)}s \u00B7
                        ${metrics.mean_volume_db != null ? metrics.mean_volume_db.toFixed(1) + " dB" : ""}
                        ${scores.comment ? " \u00B7 " + escHtml(scores.comment) : ""}
                    </div>
                </div>
                <div class="take-scores">
                    ${scoreBadge("AQ", scores.audio_quality)}
                    ${scoreBadge("IN", scores.content)}
                    ${scoreBadge("EM", scores.emotion)}
                    ${scoreBadge("\u2211", scores.overall)}
                </div>
            `;

            row.addEventListener("click", () => {
                if (onSelectTake) onSelectTake(group.group_id, take.index);
            });

            body.appendChild(row);
        }

        card.appendChild(header);
        card.appendChild(body);
        container.appendChild(card);
    }
}

/**
 * Update a single group's selection state in the DOM.
 */
export function updateGroupSelection(groupId, selectedIndex) {
    const card = document.querySelector(`.group-card[data-group-id="${groupId}"]`);
    if (!card) return;
    card.querySelectorAll(".take-row").forEach(row => {
        if (parseInt(row.dataset.segIndex) === selectedIndex) {
            row.classList.add("selected");
        } else {
            row.classList.remove("selected");
        }
    });
}

export function updateSummaryDuration(finalDuration, totalDuration) {
    const stats = document.querySelectorAll("#results-summary .stat");
    if (stats[3]) stats[3].querySelector(".stat-value").textContent = fmtDur(finalDuration);
    if (stats[4]) {
        const pct = totalDuration > 0 ? Math.round((1 - finalDuration / totalDuration) * 100) : 0;
        stats[4].querySelector(".stat-value").textContent = pct + "%";
    }
}

// ── Error ──

export function showError(msg) {
    document.getElementById("error-message").textContent = msg;
    showScreen("error");
}

// ── Helpers ──

function fmtDur(s) {
    if (!s || s <= 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ":" + String(sec).padStart(2, "0");
}

function truncate(str, len) {
    if (!str) return "";
    return str.length > len ? str.slice(0, len) + "\u2026" : str;
}

function escHtml(str) {
    if (!str) return "";
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

function scoreBadge(label, val) {
    if (val == null) return "";
    const cls = val >= 7 ? "score-high" : val >= 4 ? "score-mid" : "score-low";
    return `<div class="score-badge"><div class="score-val ${cls}">${val}</div><div class="score-label">${label}</div></div>`;
}
