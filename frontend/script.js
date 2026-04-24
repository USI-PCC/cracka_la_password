// ---------------------------------------------------------------------------
// Cracka la Password — frontend script
//
// Italian strings coupled with server/server.js messages are centralized in
// SERVER_MESSAGES (see Task 5). If you rename a message here, also update
// server/server.js.
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

// ---------------------------------------------------------------------------
// Crack flow
//
// Server messages (server/server.js) we care about. Keep these in sync with
// the exact Italian strings the server sends.
// ---------------------------------------------------------------------------
const SERVER_MESSAGES = {
    RECEIVED:   'Ricevuto il codice segreto! 🕵️‍♂️',          // server.js:62
    DICT_START: 'Proviamo con un attacco con dizionario! 📖',  // server.js:222
    DICT_GPU:   'Ho iniziato a crackare la password in modalità dizionario! 📖', // server.js:131
    BF_START:   'Proviamo con un attacco brute-force! 🔍',     // server.js:92
    BF_GPU:     'Ho iniziato a crackare la password in modalità brute-force! 🔍' // server.js:133
};

// ---- Step-row state machine ------------------------------------------------

const STEP_STATES = ['pending', 'running', 'done-hit', 'done-miss', 'skipped'];
const STEP_ICONS  = {
    pending:   '⏳',
    running:   '🌀',
    'done-hit':'✅',
    'done-miss':'⊝',
    skipped:   '—'
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

function resetPlan() {
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

    const button          = document.querySelector('.spiral-button');
    const resultElement   = document.getElementById('crackedResult');
    const elapsedTimeEl   = document.getElementById('elapsedTime');
    const resultDiv       = document.getElementById('resultDiv');

    // Reset UI
    resetPlan();
    button.classList.remove('error');
    button.classList.add('loading');
    resultElement.textContent = 'Connessione in corso...';
    elapsedTimeEl.textContent = '0.00';
    resultDiv.classList.add('hidden');

    // Track which step is currently "running" from the state-machine POV.
    // 0 = not started yet, 1/2/3 = respective row, -1 = terminal.
    let currentStep = 0;

    const startTime = performance.now();
    const timerInterval = setInterval(() => {
        const t = ((performance.now() - startTime) / 1000).toFixed(2);
        elapsedTimeEl.textContent = t;
    }, 10);

    const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${wsScheme}://${location.host}/ws`);

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
    };

    socket.onopen = () => {
        resultElement.textContent = 'Invio della chiave al server...';
        socket.send(JSON.stringify({ hash: hash }));
    };

    socket.onmessage = (event) => {
        if (currentStep === -1) return;   // already finished
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            console.error('Errore parsing JSON:', e);
            finishWithError('Errore nella comunicazione con il server.');
            socket.close();
            return;
        }

        console.log('WS <-', data);

        // Handle status-only messages (no password field).
        if (data.message && !data.password && !data.error) {
            const m = data.message;

            if (m === SERVER_MESSAGES.RECEIVED) {
                // ① Archivio begins
                currentStep = 1;
                setStepState(1, 'running');

            } else if (m === SERVER_MESSAGES.DICT_START) {
                // ① miss, ② starts
                scheduleTransition(1, 'done-miss', () => {
                    currentStep = 2;
                    setStepState(2, 'running');
                });

            } else if (m === SERVER_MESSAGES.BF_START) {
                // ② miss, ③ starts
                scheduleTransition(2, 'done-miss', () => {
                    currentStep = 3;
                    setStepState(3, 'running');
                });

            } else if (m === SERVER_MESSAGES.DICT_GPU || m === SERVER_MESSAGES.BF_GPU) {
                // Informational: GPU started. Row state unchanged.
            }
            return;
        }

        // Terminal: password found, password "Non trovata", or explicit error.
        if (data.error) {
            cancelPendingTransition();
            finishWithError(data.error);
            socket.close();
            return;
        }

        if (data.password && data.password !== 'Non trovata') {
            // HIT on current step
            cancelPendingTransition();
            const hitStep = currentStep >= 1 ? currentStep : 1;
            scheduleTransition(hitStep, 'done-hit', () => {
                skipRemaining(hitStep + 1);
            });
            stopTimer();
            resultElement.textContent = data.password;
            resultDiv.classList.remove('hidden');
            button.classList.remove('loading');
            currentStep = -1;
            socket.close();
            return;
        }

        if (data.password === 'Non trovata') {
            // Final miss on the last running step.
            cancelPendingTransition();
            const missStep = currentStep >= 1 ? currentStep : 3;
            scheduleTransition(missStep, 'done-miss');
            stopTimer();
            resultElement.textContent = 'Non sono riuscito a decifrarla';
            resultDiv.classList.remove('hidden');
            button.classList.remove('loading');
            currentStep = -1;
            socket.close();
            return;
        }

        // Unknown shape.
        finishWithError('Risposta non gestita dal server.');
        socket.close();
    };

    socket.onerror = (err) => {
        console.error('Errore WebSocket:', err);
        finishWithError('Errore di connessione con il server.');
    };

    socket.onclose = (ev) => {
        if (button.classList.contains('loading')) {
            // Connection dropped before we could finish.
            finishWithError('Connessione chiusa prima della risposta.');
        }
        setTimeout(() => button.classList.remove('error'), 3000);
        console.log('WebSocket chiuso.', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
    };
}
