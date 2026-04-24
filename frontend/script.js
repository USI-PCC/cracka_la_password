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
    // Force reflow so the animation restarts on repeated generations.
    void crackInput.offsetWidth;
    crackInput.classList.add('crack-input--pulse');
}

// ---- Crack: implemented in Task 5 -----------------------------------------

function crackHash() {
    alert("Crack flow non ancora implementato (vedi Task 5).");
}
