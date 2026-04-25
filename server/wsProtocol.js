// server/wsProtocol.js
const MESSAGE_KINDS = Object.freeze({
    HELLO:     'hello',
    RECEIVED:  'received',
    STAGE:     'stage',
    STATUS:    'status',
    CACHE_HIT: 'cache_hit',
    RESULT:    'result',
    ERROR:     'error',
});

function envelope(kind, payload = {}) {
    return { ...payload, kind, ts: Date.now() };
}

module.exports = { envelope, MESSAGE_KINDS };
