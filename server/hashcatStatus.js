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
    // Human-readable status: "?1?1?1?1?1 [5]" — bracket count is authoritative.
    const explicit = guess.guess_mask && guess.guess_mask.match(/\[(\d+)\]\s*$/);
    if (explicit) return Number(explicit[1]);
    // --status-json: guess_mask / guess_base is the expanded mask string
    // like "?l?l?l?l" (one ?X token per output char). Count "?" occurrences;
    // fall through to literal length for combinator/dictionary candidates
    // that have no mask tokens.
    const str = (typeof guess.guess_mask === 'string' && guess.guess_mask) ||
                (typeof guess.guess_base === 'string' && guess.guess_base) ||
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
