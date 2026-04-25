// server/hashcatStatus.js
function parseStatusLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { return null; }
    if (!Array.isArray(obj.progress)) return null;
    return obj;
}

function maskLenFromGuess(guess) {
    if (!guess) return null;
    // hashcat format: "?1?1?1?1?1 [5]" — the bracket count is authoritative.
    const m = guess.guess_mask && guess.guess_mask.match(/\[(\d+)\]\s*$/);
    if (m) return Number(m[1]);
    if (typeof guess.guess_base === 'string') return guess.guess_base.length || null;
    return null;
}

function summarize(parsed) {
    if (!parsed) return null;
    const devices = (parsed.devices || []).map(d => ({
        id: d.device_id,
        util: d.util ?? null,
        temp: d.temp ?? null,
        speed: d.speed ?? null,
        // hashcat doesn't report power directly; leave null and let UI hide it.
        powerW: null,
    }));
    return {
        hashRate: parsed.speed_total ?? devices.reduce((a, d) => a + (d.speed || 0), 0),
        progress: parsed.progress,
        candidate: (parsed.guess && parsed.guess.guess_base) || null,
        maskLen: maskLenFromGuess(parsed.guess),
        etaSec: typeof parsed.time_left === 'number' ? parsed.time_left : null,
        devices,
    };
}

module.exports = { parseStatusLine, summarize };
