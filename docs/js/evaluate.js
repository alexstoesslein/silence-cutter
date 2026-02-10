/**
 * Claude API evaluation of speech takes.
 * Calls api.anthropic.com directly from the browser.
 */

const CLAUDE_MODEL = "claude-sonnet-4-5-20250929";

/**
 * Get stored API key from localStorage.
 */
export function getApiKey() {
    return localStorage.getItem("silence_cutter_api_key") || "";
}

/**
 * Save API key to localStorage.
 */
export function setApiKey(key) {
    localStorage.setItem("silence_cutter_api_key", key.trim());
}

/**
 * Build evaluation prompt for Claude.
 */
function buildPrompt(groups) {
    const parts = [];
    parts.push(
        `Du bist ein erfahrener Audio-/Video-Editor und Sprachcoach. ` +
        `Ich gebe dir Transkriptionen von Sprach-Takes aus einer Aufnahme-Session. ` +
        `Mehrere Takes können Wiederholungen desselben Satzes sein.\n\n` +
        `Bewerte jeden Take nach diesen Kriterien (0-10 Punkte):\n` +
        `1. **Audio-Qualität**: Klarheit, keine Versprecher, keine Füllwörter (ähm, äh), sauberer Anfang/Ende\n` +
        `2. **Inhalt**: Formulierung, Vollständigkeit, Flüssigkeit, grammatische Korrektheit\n` +
        `3. **Emotion/Delivery**: Natürliche Betonung, Überzeugungskraft, angemessenes Tempo, Energie\n\n` +
        `Für jede Gruppe wähle den besten Take aus.\n` +
        `Am Ende schlage eine optimale Reihenfolge der Gruppen vor ` +
        `(falls die chronologische Reihenfolge nicht optimal ist).\n\n` +
        `Antworte AUSSCHLIESSLICH mit validem JSON im folgenden Format:\n` +
        "```json\n" +
        `{\n` +
        `  "evaluations": [\n` +
        `    {\n` +
        `      "group_id": 0,\n` +
        `      "takes": [\n` +
        `        {\n` +
        `          "segment_index": 0,\n` +
        `          "audio_quality": 8,\n` +
        `          "content": 9,\n` +
        `          "emotion": 7,\n` +
        `          "overall": 8.0,\n` +
        `          "comment": "Kurze Begründung"\n` +
        `        }\n` +
        `      ],\n` +
        `      "best_take_index": 0,\n` +
        `      "reason": "Warum dieser Take der beste ist"\n` +
        `    }\n` +
        `  ],\n` +
        `  "suggested_order": [0, 1, 2],\n` +
        `  "overall_notes": "Allgemeine Anmerkungen zur Aufnahme"\n` +
        `}\n` +
        "```\n\n" +
        `Hier sind die Takes:\n\n`
    );

    for (const group of groups) {
        const summary = (group.text_summary || "").slice(0, 100);
        parts.push(`## Gruppe ${group.group_id}: "${summary}..."\n`);

        for (const take of group.takes) {
            const text = take.transcription?.text || "(kein Text)";
            const metrics = take.audio_metrics || {};
            const meanVol = metrics.mean_volume_db ?? "N/A";
            const quality = metrics.quality_estimate ?? "N/A";

            parts.push(
                `- **Take ${take.index}** (Dauer: ${take.duration.toFixed(1)}s, ` +
                `Lautstärke: ${meanVol} dB, Qualität: ${quality}):\n` +
                `  Text: "${text}"\n`
            );
        }
        parts.push("\n");
    }

    return parts.join("");
}

/**
 * Call Claude API to evaluate takes.
 */
export async function evaluateTakes(groups) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error("Kein Claude API Key gesetzt. Bitte in den Einstellungen eingeben.");
    }

    const prompt = buildPrompt(groups);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 4096,
            messages: [{ role: "user", content: prompt }],
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Claude API Fehler (${response.status}): ${err}`);
    }

    const data = await response.json();
    let text = data.content?.[0]?.text || "";

    // Extract JSON from markdown code block
    if (text.includes("```json")) {
        text = text.split("```json")[1].split("```")[0];
    } else if (text.includes("```")) {
        text = text.split("```")[1].split("```")[0];
    }

    let evaluation;
    try {
        evaluation = JSON.parse(text.trim());
    } catch (e) {
        throw new Error("Claude-Antwort konnte nicht als JSON geparst werden: " + e.message);
    }

    return evaluation;
}

/**
 * Apply evaluation scores to segments and return best takes.
 */
export function applyEvaluation(groups, evaluation) {
    const scoreLookup = {};
    const bestPerGroup = {};

    for (const evalGroup of evaluation.evaluations || []) {
        const gid = evalGroup.group_id;
        const bestIdx = evalGroup.best_take_index;

        for (const takeEval of evalGroup.takes || []) {
            scoreLookup[takeEval.segment_index] = {
                audio_quality: takeEval.audio_quality || 0,
                content: takeEval.content || 0,
                emotion: takeEval.emotion || 0,
                overall: takeEval.overall || 0,
                comment: takeEval.comment || "",
            };
        }

        if (gid < groups.length && bestIdx != null) {
            const groupTakes = groups[gid].takes;
            if (bestIdx < groupTakes.length) {
                bestPerGroup[gid] = groupTakes[bestIdx].index;
            } else {
                bestPerGroup[gid] = bestIdx;
            }
        }
    }

    // Apply scores
    for (const group of groups) {
        for (const take of group.takes) {
            if (scoreLookup[take.index]) {
                take.ai_scores = scoreLookup[take.index];
            }
            take.is_best = (take.index === bestPerGroup[group.group_id]);
        }
    }

    // Build ordered best-takes list
    const suggestedOrder = evaluation.suggested_order || groups.map((_, i) => i);
    const bestTakes = [];

    for (const gid of suggestedOrder) {
        if (gid < groups.length) {
            const segIdx = bestPerGroup[gid];
            if (segIdx != null) {
                const take = groups[gid].takes.find(t => t.index === segIdx);
                if (take) bestTakes.push(take);
            }
        }
    }

    return {
        bestTakes,
        groups,
        suggestedOrder,
        overallNotes: evaluation.overall_notes || "",
    };
}
