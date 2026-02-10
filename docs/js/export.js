/**
 * FCP XML v5 + CMX3600 EDL + JSON Report Generator.
 * Runs entirely client-side, produces downloadable Blobs.
 */

/**
 * Generate FCP XML v5 string.
 */
export function generateFCPXML(bestTakes, sourceFilename, totalDuration, fps = 25, sampleRate = 48000) {
    const totalFrames = Math.round(totalDuration * fps);
    const hasVideo = /\.(mp4|mov|mkv|webm)$/i.test(sourceFilename);

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<!DOCTYPE xmeml>\n`;
    xml += `<xmeml version="5">\n`;
    xml += `  <sequence>\n`;
    xml += `    <name>Silence Cutter Edit</name>\n`;
    xml += `    <duration>${totalFrames}</duration>\n`;
    xml += `    <rate>\n`;
    xml += `      <timebase>${fps}</timebase>\n`;
    xml += `      <ntsc>FALSE</ntsc>\n`;
    xml += `    </rate>\n`;
    xml += `    <timecode>\n`;
    xml += `      <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>\n`;
    xml += `      <string>00:00:00:00</string>\n`;
    xml += `      <frame>0</frame>\n`;
    xml += `      <displayformat>NDF</displayformat>\n`;
    xml += `    </timecode>\n`;
    xml += `    <media>\n`;

    // Video track
    if (hasVideo) {
        xml += `      <video>\n`;
        xml += `        <format><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></format>\n`;
        xml += `        <track>\n`;
        let pos = 0;
        bestTakes.forEach((take, i) => {
            const inF = Math.round(take.start * fps);
            const outF = Math.round(take.end * fps);
            const clipDur = outF - inF;
            xml += `          <clipitem id="clipitem-v-${i + 1}">\n`;
            xml += `            <name>${esc(sourceFilename)}</name>\n`;
            xml += `            <duration>${totalFrames}</duration>\n`;
            xml += `            <start>${pos}</start>\n`;
            xml += `            <end>${pos + clipDur}</end>\n`;
            xml += `            <in>${inF}</in>\n`;
            xml += `            <out>${outF}</out>\n`;
            xml += `            <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>\n`;
            xml += `            <file id="file-1"><name>${esc(sourceFilename)}</name><pathurl>file://${esc(sourceFilename)}</pathurl></file>\n`;
            xml += `          </clipitem>\n`;
            pos += clipDur;
        });
        xml += `        </track>\n`;
        xml += `      </video>\n`;
    }

    // Audio track
    xml += `      <audio>\n`;
    xml += `        <format><samplecharacteristics><samplerate>${sampleRate}</samplerate><depth>16</depth></samplecharacteristics></format>\n`;
    xml += `        <track>\n`;
    let aPos = 0;
    bestTakes.forEach((take, i) => {
        const inF = Math.round(take.start * fps);
        const outF = Math.round(take.end * fps);
        const clipDur = outF - inF;
        xml += `          <clipitem id="clipitem-a-${i + 1}">\n`;
        xml += `            <name>${esc(sourceFilename)}</name>\n`;
        xml += `            <duration>${totalFrames}</duration>\n`;
        xml += `            <start>${aPos}</start>\n`;
        xml += `            <end>${aPos + clipDur}</end>\n`;
        xml += `            <in>${inF}</in>\n`;
        xml += `            <out>${outF}</out>\n`;
        xml += `            <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>\n`;
        xml += `            <file id="file-1"/>\n`;
        xml += `          </clipitem>\n`;
        aPos += clipDur;
    });
    xml += `        </track>\n`;
    xml += `      </audio>\n`;

    xml += `    </media>\n`;
    xml += `  </sequence>\n`;
    xml += `</xmeml>\n`;

    return xml;
}

/**
 * Generate CMX3600 EDL string.
 */
export function generateEDL(bestTakes, sourceFilename, fps = 25) {
    const lines = [];
    lines.push("TITLE: Silence Cutter Edit");
    lines.push("FCM: NON-DROP FRAME");
    lines.push("");

    let timelinePos = 0;

    bestTakes.forEach((take, i) => {
        const editNum = String(i + 1).padStart(3, "0");
        const srcIn = timecodeFromSeconds(take.start, fps);
        const srcOut = timecodeFromSeconds(take.end, fps);
        const recIn = timecodeFromSeconds(timelinePos, fps);
        const recOut = timecodeFromSeconds(timelinePos + take.duration, fps);

        lines.push(`${editNum}  AX       AA/V  C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
        lines.push(`* FROM CLIP NAME: ${sourceFilename}`);

        const text = (take.transcription?.text || take.text || "").slice(0, 60);
        const score = take.ai_scores?.overall ?? "N/A";
        lines.push(`* COMMENT: Take ${take.index} | Score: ${score} | ${text}`);
        lines.push("");

        timelinePos += take.duration;
    });

    return lines.join("\n");
}

/**
 * Generate full JSON report.
 */
export function generateReport(bestTakes, groups, suggestedOrder, overallNotes, sourceFilename, totalDuration) {
    let pos = 0;
    const timeline = bestTakes.map(take => {
        const entry = {
            segment_index: take.index,
            source_start: take.start,
            source_end: take.end,
            duration: take.duration,
            timeline_start: round3(pos),
            timeline_end: round3(pos + take.duration),
            text: take.transcription?.text || "",
            scores: take.ai_scores || {},
        };
        pos += take.duration;
        return entry;
    });

    const report = {
        source_file: sourceFilename,
        total_duration: totalDuration,
        final_duration: round3(pos),
        total_segments: groups.reduce((sum, g) => sum + g.take_count, 0),
        groups_count: groups.length,
        selected_takes: bestTakes.length,
        suggested_order: suggestedOrder,
        overall_notes: overallNotes,
        timeline,
        groups_detail: groups.map(g => ({
            group_id: g.group_id,
            text_summary: g.text_summary,
            takes: g.takes.map(t => ({
                index: t.index,
                start: t.start,
                end: t.end,
                duration: t.duration,
                text: t.transcription?.text || "",
                scores: t.ai_scores || {},
                is_best: t.is_best || false,
            })),
        })),
    };

    return JSON.stringify(report, null, 2);
}

/**
 * Trigger a file download from a string.
 */
export function downloadString(content, filename, mimeType = "text/plain") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── Helpers ──

function timecodeFromSeconds(seconds, fps) {
    const totalFrames = Math.round(seconds * fps);
    const ff = totalFrames % fps;
    const totalSec = Math.floor(totalFrames / fps);
    const ss = totalSec % 60;
    const mm = Math.floor(totalSec / 60) % 60;
    const hh = Math.floor(totalSec / 3600);
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function round3(n) { return Math.round(n * 1000) / 1000; }
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
