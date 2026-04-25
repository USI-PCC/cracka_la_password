// ---------------------------------------------------------------------------
// Cracka la Password — frontend script
//
// The server emits typed envelopes ({ kind, ts, ...payload }) per
// server/wsProtocol.js. Italian UI copy lives here: STAGE_LABEL (module scope)
// for stage transitions, translateError() (inside crackHash) for error codes.
// ---------------------------------------------------------------------------

// ---- Make: unified input + random filler ----------------------------------

function generateRandomPassword(length, useLower, useUpper, useDigits) {
    let charset = "";
    if (useLower)  charset += "abcdefghijklmnopqrstuvwxyz";
    if (useUpper)  charset += "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (useDigits) charset += "0123456789";

    if (charset === "") {
        alert("Seleziona almeno un tipo di carattere per la chiave casuale!");
        return "";
    }

    let password = "";
    for (let i = 0, n = charset.length; i < length; ++i) {
        password += charset.charAt(Math.floor(Math.random() * n));
    }
    return password;
}

// Tracks whether the current value in #password came from 🎲 or from typing.
// Controls whether the "Parola" row is shown in the result box.
let lastValueWasRandom = false;

function fillRandom() {
    const length   = parseInt(document.getElementById('pwdLength').value, 10);
    const useLower = document.getElementById('useLowercase').checked;
    const useUpper = document.getElementById('useUppercase').checked;
    const useDigit = document.getElementById('useNumbers').checked;

    if (!Number.isFinite(length) || length < 1) {
        alert("La lunghezza della chiave casuale deve essere maggiore di zero.");
        return;
    }

    const pwd = generateRandomPassword(length, useLower, useUpper, useDigit);
    if (!pwd) return;

    const input = document.getElementById('password');
    input.value = pwd;
    // Reveal the value so the audience sees what was generated.
    input.type = 'text';
    document.getElementById('toggleVisibilityButton').textContent = '🙈 Nascondi';
    lastValueWasRandom = true;
}

// Note: programmatic input.value = … does NOT fire 'input', so fillRandom's
// assignment followed by lastValueWasRandom = true is safe.
// When the user types manually, mark the value as non-random.
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('password');
    input.addEventListener('input', () => { lastValueWasRandom = false; });
});

function makeKey() {
    const input = document.getElementById('password');
    const value = input.value;
    if (!value) {
        alert("Scrivi una parola o premi 🎲 per generarne una.");
        return;
    }

    const hash = CryptoJS.MD5(value).toString();

    // Populate the result box.
    const wordRow    = document.getElementById('wordRow');
    const wordResult = document.getElementById('wordResult');
    const hashResult = document.getElementById('hashResult');

    if (lastValueWasRandom) {
        wordResult.textContent = value;
        wordRow.classList.remove('hidden');
    } else {
        wordRow.classList.add('hidden');
    }
    hashResult.textContent = hash;
    document.getElementById('makeResult').classList.remove('hidden');

    // Hand off to the Crack section.
    autofillCrackInput(hash);
}

function togglePasswordVisibility() {
    const input  = document.getElementById('password');
    const button = document.getElementById('toggleVisibilityButton');
    if (input.type === 'password') {
        input.type = 'text';
        button.textContent = '🙈 Nascondi';
    } else {
        input.type = 'password';
        button.textContent = '👁 Mostra';
    }
}

// ---- Make -> Crack handoff -------------------------------------------------

function autofillCrackInput(hash) {
    const crackInput = document.getElementById('hashInput');
    crackInput.value = hash;
    crackInput.classList.remove('crack-input--pulse');
    // Force reflow so the CSS animation restarts on repeated generations.
    // Without this, remove-class + add-class in the same tick gets batched
    // and the animation does not replay.
    void crackInput.offsetWidth;
    crackInput.classList.add('crack-input--pulse');
}

// ---- Step-row state machine ------------------------------------------------

const STEP_STATES = ['pending', 'running', 'done-hit', 'done-miss', 'skipped'];
const STEP_ICONS  = {
    pending:   '⏳',
    running:   '🌀',
    'done-hit':'✅',
    'done-miss':'⊝',
    skipped:   '—'
};

const STAGE_TO_STEP = { archivio: 1, dictionary: 2, 'brute-force': 3 };

// Italian copy lives here now (was in server before).
const STAGE_LABEL = {
    archivio:      'Cerco negli archivi…',
    dictionary:    'Provo con un attacco a dizionario… 📖',
    'brute-force': 'Provo con la forza bruta… 🔍',
};

// Minimum ms a row must be in `running` before we accept the next transition.
// Prevents the potfile-hit case from flashing step ① invisibly.
const RUNNING_MIN_MS = 400;

function rowEl(step) {
    return document.querySelector(`.step-row[data-step="${step}"]`);
}

function setStepState(step, state) {
    const el = rowEl(step);
    if (!el) return;
    STEP_STATES.forEach(s => el.classList.remove(`step-row--${s}`));
    el.classList.add(`step-row--${state}`);
    el.querySelector('.step-row__icon').textContent = STEP_ICONS[state];
    el.dataset.state = state;
    el.dataset.enteredAt = String(performance.now());
}

// Tracks the one timer that may be waiting to leave a `running` row.
// Shape: { step, id } | null
let pendingTransition = null;

function cancelPendingTransition() {
    if (pendingTransition) {
        clearTimeout(pendingTransition.id);
        pendingTransition = null;
    }
}

// References for the active crack run, exposed so the Stop / Reset buttons
// (which live outside crackHash's closure) can intervene. Cleared on terminal.
let activeSocket = null;
let userStopped = false;

function resetPlan() {
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('hudBar').style.width = '0%';
    document.getElementById('cacheLine').classList.add('hidden');
    document.getElementById('latencyLine').classList.add('hidden');
    document.getElementById('logList').innerHTML = '';
    cancelPendingTransition();
    [1, 2, 3].forEach(s => setStepState(s, 'pending'));
}

// Delay any "leave running" transition by at least RUNNING_MIN_MS.
function scheduleTransition(step, nextState, cb) {
    cancelPendingTransition();
    const el = rowEl(step);
    const enteredAt = Number(el.dataset.enteredAt || 0);
    const elapsed = performance.now() - enteredAt;
    const wait = Math.max(0, RUNNING_MIN_MS - elapsed);
    const id = setTimeout(() => {
        pendingTransition = null;
        setStepState(step, nextState);
        if (cb) cb();
    }, wait);
    pendingTransition = { step, id };
}

// Mark any rows still `pending` as `skipped` (used when an earlier stage hit).
function skipRemaining(fromStep) {
    for (let s = fromStep; s <= 3; s++) {
        const el = rowEl(s);
        if (el.dataset.state === 'pending') setStepState(s, 'skipped');
    }
}

// ---- crackHash -------------------------------------------------------------

function crackHash() {
    const hash = document.getElementById('hashInput').value.trim();
    if (!hash) {
        alert("Inserisci una chiave.");
        return;
    }

    const md5Regex = /^[a-f0-9]{32}$/i;
    if (!md5Regex.test(hash)) {
        alert("La chiave non è valida: servono 32 caratteri esadecimali.");
        return;
    }

    const button          = document.getElementById('crackButton');
    const stopBtn         = document.getElementById('stopButton');
    const resultElement   = document.getElementById('crackedResult');
    const elapsedTimeEl   = document.getElementById('elapsedTime');
    const resultDiv       = document.getElementById('resultDiv');

    // Reset UI
    resetPlan();
    button.classList.remove('error');
    button.classList.add('loading');
    stopBtn.classList.remove('hidden');
    userStopped = false;
    resultElement.textContent = 'Connessione in corso...';
    elapsedTimeEl.textContent = '0.00';
    resultDiv.classList.add('hidden');

    // Track which step is currently "running" from the state-machine POV.
    // 0 = not started yet, 1/2/3 = respective row, -1 = terminal.
    let currentStep = 0;
    let receivedAt = 0;
    let firstStatusAt = 0;

    const startTime = performance.now();
    const timerInterval = setInterval(() => {
        const t = ((performance.now() - startTime) / 1000).toFixed(2);
        elapsedTimeEl.textContent = t;
    }, 10);

    const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${wsScheme}://${location.host}/ws`);
    activeSocket = socket;

    const stopTimer = () => {
        clearInterval(timerInterval);
        elapsedTimeEl.textContent = ((performance.now() - startTime) / 1000).toFixed(2);
    };

    const finishWithError = (msg) => {
        cancelPendingTransition();
        if (currentStep >= 1 && currentStep <= 3) {
            scheduleTransition(currentStep, 'done-miss');
        }
        currentStep = -1;
        stopTimer();
        resultElement.textContent = msg;
        resultDiv.classList.remove('hidden');
        button.classList.remove('loading');
        button.classList.add('error');
        stopBtn.classList.add('hidden');
        activeSocket = null;
    };

    socket.onopen = () => {
        resultElement.textContent = 'Invio della chiave al server...';
        socket.send(JSON.stringify({ hash: hash }));
    };

    socket.onmessage = (event) => {
        if (currentStep === -1) return;
        let msg;
        try { msg = JSON.parse(event.data); }
        catch { finishWithError('Errore nella comunicazione con il server.'); socket.close(); return; }
        console.log('WS <-', msg);
        handleMessage(msg);
    };

    function handleMessage(msg) {
        appendLog(msg);
        switch (msg.kind) {
            case 'hello':      return onHello(msg);
            case 'received':   return onReceived(msg);
            case 'stage':      return onStage(msg);
            case 'status':     return onStatus(msg);
            case 'cache_hit':  return onCacheHit(msg);
            case 'result':     return onResult(msg);
            case 'error':      return finishWithError(translateError(msg.message));
            default:           console.warn('Unknown WS kind:', msg.kind, msg);
        }
    }

    function appendLog(msg) {
        const list = document.getElementById('logList');
        if (!list) return;
        const li = document.createElement('li');
        const t = new Date(msg.ts || Date.now()).toLocaleTimeString('it-IT', { hour12: false });
        li.innerHTML = `<span class="log-time">${t}</span> <span class="log-kind">${msg.kind}</span> <span class="log-payload"></span>`;
        li.querySelector('.log-payload').textContent = JSON.stringify(stripStatusVerbose(msg));
        list.appendChild(li);
        while (list.children.length > 200) list.removeChild(list.firstChild);
    }

    // Status frames are noisy — keep only the small fields in the log.
    function stripStatusVerbose(msg) {
        if (msg.kind !== 'status') return msg;
        return { kind: 'status', hashRate: msg.hashRate, candidate: msg.candidate, maskLen: msg.maskLen };
    }

    function onHello(msg) {
        if (msg.deviceSlot) {
            const b = document.getElementById('deviceBadge');
            b.textContent = `GPU: ${msg.deviceSlot}`;
            b.classList.remove('hidden');
        }
        if (typeof msg.dictSize === 'number') {
            const formatted = msg.dictSize.toLocaleString('it-IT');
            const combos = (msg.dictSize * msg.dictSize).toLocaleString('it-IT');
            document.getElementById('dictContext').textContent =
                `${formatted} parole × ${formatted} = ${combos} combinazioni`;
        }
    }
    function onReceived(_msg) {
        receivedAt = performance.now();
        currentStep = 1;
        setStepState(1, 'running');
    }
    function onStage(msg) {
        if (msg.phase !== 'start') return;       // gpu-running is informational
        const step = STAGE_TO_STEP[msg.name];
        if (!step) return;
        // Mark earlier steps miss, advance to this one.
        scheduleTransition(currentStep || 1, 'done-miss', () => {
            currentStep = step;
            setStepState(step, 'running');
        });
    }
    function onStatus(msg) {
        if (!firstStatusAt) {
            firstStatusAt = performance.now();
            if (receivedAt) {
                const ms = (firstStatusAt - receivedAt).toFixed(1);
                document.getElementById('latencyMs').textContent = ms;
                document.getElementById('latencyLine').classList.remove('hidden');
            }
        }
        document.getElementById('hud').classList.remove('hidden');
        document.getElementById('hudRate').textContent = formatRate(msg.hashRate);
        document.getElementById('hudCandidate').textContent = msg.candidate || '—';
        document.getElementById('hudMask').textContent = msg.maskLen ? `${msg.maskLen} caratteri` : '—';
        document.getElementById('hudEta').textContent =
            msg.etaSec != null ? formatEta(msg.etaSec) : '—';
        if (Array.isArray(msg.progress) && msg.progress[1] > 0) {
            const pct = (100 * msg.progress[0]) / msg.progress[1];
            document.getElementById('hudBar').style.width = `${pct.toFixed(2)}%`;
        }
        renderGpuBars(msg.devices);   // Task 8 wires this
    }

    function formatRate(hps) {
        if (!hps) return '—';
        const units = [['GH/s', 1e9], ['MH/s', 1e6], ['kH/s', 1e3]];
        for (const [u, d] of units) if (hps >= d) return `${(hps / d).toFixed(2)} ${u}`;
        return `${hps} H/s`;
    }

    function formatEta(s) {
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const ss = String(s % 60).padStart(2, '0');
        if (m < 60) return `${m}:${ss}`;
        const h = Math.floor(m / 60);
        const mm = String(m % 60).padStart(2, '0');
        return `${h}:${mm}:${ss}`;
    }

    function renderGpuBars(devices) {
        const grid = document.getElementById('gpuGrid');
        if (!devices || devices.length === 0) { grid.innerHTML = ''; return; }
        grid.innerHTML = devices.map(d => `
            <div class="gpu-card">
                <div class="gpu-card__name">GPU ${d.id}</div>
                <div class="gpu-bar">
                    <div class="gpu-bar__fill" style="width:${d.util ?? 0}%"></div>
                </div>
                <div class="gpu-card__meta">
                    <span>${d.util ?? '—'}%</span>
                    <span>${d.temp != null ? `${d.temp}°C` : ''}</span>
                </div>
            </div>
        `).join('');
    }
    function onCacheHit(msg) {
        document.getElementById('cacheMs').textContent = msg.lookupMs.toFixed(2);
        document.getElementById('cacheSource').textContent =
            msg.source === 'kv' ? 'cache pre-calcolata ⚡' : 'archivio (potfile) 📓';
        document.getElementById('cacheLine').classList.remove('hidden');
    }
    function onResult(msg) {
        cancelPendingTransition();
        if (msg.password) {
            const hitStep = currentStep >= 1 ? currentStep : 1;
            scheduleTransition(hitStep, 'done-hit', () => skipRemaining(hitStep + 1));
            resultElement.textContent = msg.password;
        } else {
            const missStep = currentStep >= 1 ? currentStep : 3;
            scheduleTransition(missStep, 'done-miss');
            resultElement.textContent = 'Non sono riuscito a decifrarla';
        }
        const modeText = ({ kv:'cache ⚡', potfile:'archivio 📓', dictionary:'dizionario 📖', 'brute-force':'forza bruta 🔍' })[msg.mode] || msg.mode || '—';
        document.getElementById('modeBadge').textContent = modeText;
        stopTimer();
        resultDiv.classList.remove('hidden');
        button.classList.remove('loading');
        stopBtn.classList.add('hidden');
        currentStep = -1;
        activeSocket = null;
        socket.close();
    }

    function translateError(code) {
        return ({
            invalid_json:           'Ops... ho inviato qualcosa di sbagliato… 😵‍💫',
            missing_hash:           'Devi inserire il codice segreto! 🤫',
            bad_hash_format:        'Il codice segreto ha qualcosa che non va 🤔',
            archivio_lookup_failed: 'Ops... ho sbagliato qualcosa negli archivi 🗄️',
            hashcat_failed:         'Non ho voglia di lavorare oggi! 😴',
        })[code] || 'Errore dal server.';
    }

    socket.onerror = (err) => {
        console.error('Errore WebSocket:', err);
        finishWithError('Errore di connessione con il server.');
    };

    socket.onclose = (ev) => {
        if (button.classList.contains('loading')) {
            if (userStopped) {
                // Deliberate stop via the Stop button — show a friendly message,
                // not the network-error styling.
                cancelPendingTransition();
                if (currentStep >= 1 && currentStep <= 3) {
                    scheduleTransition(currentStep, 'done-miss');
                }
                currentStep = -1;
                stopTimer();
                resultElement.textContent = '⏹ Decifratura interrotta';
                resultDiv.classList.remove('hidden');
                button.classList.remove('loading');
                stopBtn.classList.add('hidden');
            } else {
                // Connection dropped before we could finish.
                finishWithError('Connessione chiusa prima della risposta.');
            }
        }
        activeSocket = null;
        userStopped = false;
        setTimeout(() => button.classList.remove('error'), 3000);
        console.log('WebSocket chiuso.', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
    };
}

// ---- Stop & Reset (module-level, used by buttons outside crackHash) -------

function stopCracking() {
    if (!activeSocket) return;
    userStopped = true;
    try { activeSocket.close(); } catch (_) { /* socket already closing */ }
    // The rest of the UI cleanup runs in socket.onclose.
}

function clearAll() {
    // If a crack is running, stop it first. onclose will tidy the Crack pane.
    if (activeSocket) stopCracking();

    // Make section
    const pwd = document.getElementById('password');
    pwd.value = '';
    pwd.type = 'text';
    document.getElementById('toggleVisibilityButton').textContent = '👁 Mostra';
    lastValueWasRandom = false;
    document.getElementById('makeResult').classList.add('hidden');
    document.getElementById('wordRow').classList.add('hidden');

    // Crack section
    const hi = document.getElementById('hashInput');
    hi.value = '';
    hi.classList.remove('crack-input--pulse');
    document.getElementById('resultDiv').classList.add('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('cacheLine').classList.add('hidden');
    document.getElementById('latencyLine').classList.add('hidden');
    document.getElementById('logList').innerHTML = '';
    document.getElementById('hudBar').style.width = '0%';
    document.getElementById('gpuGrid').innerHTML = '';

    // Plan rows back to pending; cancel any pending transition timer.
    cancelPendingTransition();
    [1, 2, 3].forEach(s => setStepState(s, 'pending'));

    // Reset crack button states.
    const cb = document.getElementById('crackButton');
    if (cb) {
        cb.classList.remove('loading');
        cb.classList.remove('error');
    }
    const sb = document.getElementById('stopButton');
    if (sb) sb.classList.add('hidden');
}
