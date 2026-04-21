function openTab(evt, tabName) {
    var i, tabcontent, tablinks;
    tabcontent = document.getElementsByClassName("tabcontent");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
    }
    tablinks = document.getElementsByClassName("tablink");
    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].className = tablinks[i].className.replace(" active", "");
    }
    document.getElementById(tabName).style.display = "block";
    evt.currentTarget.className += " active";
}

function generateHash() {
    const password = document.getElementById('password').value;
    if (!password) {
        alert('Per favore inserisci una password');
        return;
    }
    
    const hash = CryptoJS.MD5(password).toString();
    document.getElementById('hashResult').textContent = hash;
    document.querySelector('#UserInput .result').classList.remove('hidden');
}

function crackHash() {
    const hash = document.getElementById('hashInput').value;
    if (!hash) {
        alert('Per favore inserisci un codice MD5');
        return;
    }

    const md5Regex = /^[a-f0-9]{32}$/i;
    if (!md5Regex.test(hash)) {
        alert('Per favore inserisci un codice MD5 valido (32 caratteri esadecimali)');
        return;
    }

    const button = document.querySelector('.spiral-button');
    const resultElement = document.getElementById('crackedResult');
    const elapsedTimeElement = document.getElementById('elapsedTime');
    const resultDiv = document.getElementById('resultDiv');

    button.classList.remove('error');
    button.classList.add('loading');
    resultElement.textContent = 'Connessione al server WebSocket...';
    elapsedTimeElement.textContent = '0.00';
    resultDiv.classList.remove('hidden');

    const startTime = performance.now();
    let timerInterval = setInterval(() => {
        const currentTime = performance.now();
        const elapsedTime = ((currentTime - startTime) / 1000).toFixed(2);
        elapsedTimeElement.textContent = elapsedTime;
    }, 10);
    
    const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${wsScheme}://${location.host}/ws`); 

    socket.onopen = () => {
        resultElement.textContent = 'Dammi un attimo...';
        socket.send(JSON.stringify({ hash: hash }));
    };

    function updateComputationStatus(message) {
        const statusElement = document.getElementById('statusMessage');
        const statusDiv = document.getElementById('computationStatus');
        statusElement.textContent = message;
        statusDiv.classList.remove('hidden');
    }

    socket.onmessage = (event) => {
        const endTime = performance.now();
        let elapsedTime = ((endTime - startTime) / 1000).toFixed(2);

        try {
            const data = JSON.parse(event.data);
            console.log(data);

            if (data.message && !data.password) {
                console.log('Server message:', data.message);
                updateComputationStatus(data.message);
                return;
            }
            clearInterval(timerInterval);
            elapsedTimeElement.textContent = elapsedTime;
            button.classList.remove('loading');
            if (data.error) {
                console.error('Errore dal server:', data.error);
                resultElement.textContent = data.error;
                button.classList.add('error');
            } else if (data.password) {
                resultElement.textContent = data.password || 'Non trovato';
                updateComputationStatus(data.message);
            } else {
                resultElement.textContent = 'Risposta non gestita dal server.';
                button.classList.add('error');
            }
        } catch (e) {
            clearInterval(timerInterval);
            elapsedTimeElement.textContent = elapsedTime;
            console.error('Errore nel parsing del messaggio JSON:', e);
            resultElement.textContent = 'Errore nella comunicazione con il server.';
            button.classList.remove('loading');
            button.classList.add('error');
        }
        socket.close(); 
    };

    socket.onerror = (error) => {
        clearInterval(timerInterval);
        const endTime = performance.now();
        const elapsedTime = ((endTime - startTime) / 1000).toFixed(2);
        elapsedTimeElement.textContent = elapsedTime;

        console.error('Errore WebSocket:', error);
        resultElement.textContent = 'Errore di connessione WebSocket. Controlla la console.';
        button.classList.remove('loading');
        button.classList.add('error');
    };

    socket.onclose = (event) => {
        clearInterval(timerInterval);
        button.classList.remove('loading');
        console.log('Connessione WebSocket chiusa.', event);
        if (resultElement.textContent.includes('Connessione') || resultElement.textContent.includes('Invio')) {
            const endTime = performance.now();
            const elapsedTime = ((endTime - startTime) / 1000).toFixed(2);
            elapsedTimeElement.textContent = elapsedTime;
            resultElement.textContent = 'Connessione chiusa prima di ricevere una risposta.';
            button.classList.add('error');
        }
        
        setTimeout(() => {
            if (button.classList.contains('error')) {
                button.classList.remove('error');
            }
        }, 3000);
    };
}

function generateRandomPassword(length, useLower, useUpper, useDigits) {
    let charset = "";
    if (useLower) charset += "abcdefghijklmnopqrstuvwxyz";
    if (useUpper) charset += "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (useDigits) charset += "0123456789";

    if (charset === "") {
        alert("Per favore, seleziona almeno un tipo di carattere per la password!");
        return "";
    }

    let password = "";
    for (let i = 0, n = charset.length; i < length; ++i) {
        password += charset.charAt(Math.floor(Math.random() * n));
    }
    return password;
}

function generateRandomPasswordAndHash() {
    const length = parseInt(document.getElementById('pwdLength').value);
    const useLowercase = document.getElementById('useLowercase').checked;
    const useUppercase = document.getElementById('useUppercase').checked;
    const useNumbers = document.getElementById('useNumbers').checked;

    if (!useLowercase && !useUppercase && !useNumbers) {
        alert("Devi selezionare almeno un tipo di carattere (minuscole, maiuscole, numeri)!");
        document.getElementById('randomPasswordResult').textContent = "...";
        document.getElementById('randomHashResult').textContent = "...";
        return;
    }

    if (length <= 0) {
        alert("La lunghezza della password deve essere maggiore di zero!");
        document.getElementById('randomPasswordResult').textContent = "...";
        document.getElementById('randomHashResult').textContent = "...";
        return;
    }

    const randomPassword = generateRandomPassword(length, useLowercase, useUppercase, useNumbers);
    
    if (randomPassword) {
        document.getElementById('randomPasswordResult').textContent = randomPassword;
        const hash = CryptoJS.MD5(randomPassword).toString();
        document.getElementById('randomHashResult').textContent = hash;
        document.querySelector('#RandomGenerator .result').classList.remove('hidden');
    } else {
        document.getElementById('randomPasswordResult').textContent = "...";
        document.getElementById('randomHashResult').textContent = "...";
    }
}

function togglePasswordVisibility() {
    const passwordInput = document.getElementById('password');
    const toggleButton = document.getElementById('toggleVisibilityButton');
    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        toggleButton.textContent = 'Nascondi 🙈';
    } else {
        passwordInput.type = 'password';
        toggleButton.textContent = 'Rivela 👁️';
    }
}

function showFadingText(message, x, y) {
    const textCloud = document.createElement('div');
    textCloud.textContent = message;
    textCloud.style.position = 'absolute';
    textCloud.style.left = `${x}px`;
    textCloud.style.top = `${y}px`;
    textCloud.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    textCloud.style.color = 'white';
    textCloud.style.padding = '5px 10px';
    textCloud.style.borderRadius = '5px';
    textCloud.style.zIndex = '1000';
    textCloud.style.transition = 'opacity 1s ease-out';
    textCloud.style.opacity = '1';

    document.body.appendChild(textCloud);

    setTimeout(() => {
        textCloud.style.opacity = '0';
        setTimeout(() => textCloud.remove(), 1000);
    }, 1000);
}

function copyToClipboard(elementId, event) {
    const textToCopy = document.getElementById(elementId).textContent;
    navigator.clipboard.writeText(textToCopy).then(() => {
        showFadingText('Copiato!', event.clientX, event.clientY);
    }).catch(err => {
        console.error('Errore durante la copia: ', err);
    });
}