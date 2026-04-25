// server/hashcatStatus.js
function parseStatusLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { return null; }
    if (!Array.isArray(obj.progress)) return null;
    return obj;
}

// In --status-json mode hashcat emits both guess_mask (the ORIGINAL full mask,
// e.g. "?1?1?1?1?1?1?1?1?1?1") and guess_base (the CURRENT expanded slice in
// -i mode, e.g. "?l?l?l?l?l"). The HUD displays guess_base as the candidate,
// so we derive maskLen from that exact string to keep the two consistent.
// Human-readable status carries an explicit "[N]" suffix on guess_mask which
// we still trust when present.
function maskLenFromGuess(guess) {
    if (!guess) return null;
    const explicit = guess.guess_mask && guess.guess_mask.match(/\[(\d+)\]\s*$/);
    if (explicit) return Number(explicit[1]);
    const str = (typeof guess.guess_base === 'string' && guess.guess_base) ||
                (typeof guess.guess_mask === 'string' && guess.guess_mask) ||
                null;
    if (!str) return null;
    const tokens = (str.match(/\?/g) || []).length;
    return tokens > 0 ? tokens : (str.length || null);
}

// Hashcat's --status-json emits `estimated_stop` (UNIX epoch). Older / human
// formats use `time_left` (seconds remaining). Accept either; clamp negatives
// to null so a stale "already ended" estimate doesn't render as a count-up.
function etaSecFrom(parsed, nowMs = Date.now()) {
    if (typeof parsed.time_left === 'number') return parsed.time_left;
    if (typeof parsed.estimated_stop === 'number' && parsed.estimated_stop > 0) {
        const remaining = parsed.estimated_stop - Math.floor(nowMs / 1000);
        return remaining >= 0 ? remaining : null;
    }
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
        etaSec: etaSecFrom(parsed),
        devices,
    };
}

module.exports = { parseStatusLine, summarize };
