const express = require('express');
const { exec, spawn } = require('child_process');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const port = Number(process.env.PORT) || 3100;

const server = http.createServer(app);

// --- hashcat device-slot assignment (round-robin per crack request) ---
// HASHCAT_DEVICES = "slot1;slot2;..." where each slot is a comma-separated
// hashcat device-id list (e.g. "1,2;3,4"). Empty/unset disables -d injection.
const deviceSlots = (process.env.HASHCAT_DEVICES || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
let deviceCursor = 0;
const nextDeviceSlot = () => {
    if (deviceSlots.length === 0) return null;
    const slot = deviceSlots[deviceCursor % deviceSlots.length];
    deviceCursor += 1;
    return slot;
};

const log = (message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`\x1b[32m[${timestamp}]\x1b[0m\n${message}\n`, ...args);
};

const error = (message, ...args) => {
    const timestamp = new Date().toISOString();
    console.error(`\x1b[31m[${timestamp}] ERROR:\x1b[0m\n${message}\n`, ...args);
};

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const wss = new WebSocket.Server({ server });

log('WebSocket server created and attached to HTTP server.');

wss.on('connection', (ws) => {
    log('New WebSocket client connected.');

    let currentHashcatProcess = null;
    let isCrackingCompleted = false;
    let mode = null;

    ws.on('message', async (message) => {
        ws.send(JSON.stringify({ message: 'Ricevuto il codice segreto! 🕵️‍♂️' }));
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            error('Invalid JSON message received:', message);
            ws.send(JSON.stringify({ error: 'Ops... ho inviato qualcosa di sbagliato... 😵‍💫' }));
            return;
        }

        const hash = parsedMessage.hash;
        const assignedDevices = nextDeviceSlot();
        log('Received hash for cracking - Hash: %s', hash);

        if (!hash) {
            error('Request rejected - Missing hash parameter');
            ws.send(JSON.stringify({ error: 'Devi inserire il codice segreto! 🤫' }));
            return;
        }

        const md5Regex = /^[a-f0-9]{32}$/i;
        if (!md5Regex.test(hash)) {
            error('Invalid MD5 hash format - Hash: %s', hash);
            ws.send(JSON.stringify({ error: 'Il codice segreto che mi hai mandato ha qualcosa che non va 🤔' }));
            return;
        }
        
        isCrackingCompleted = false;

        const startNextHashcatProcess = () => {
            log('Starting second hashcat process (brute-force) for hash: %s', hash);
            ws.send(JSON.stringify({ message: 'Proviamo con un attacco brute-force! 🔍' }));
            mode = 'brute-force';
            const bfArgs = [
                '-m', '0',
                '-a', '3',
                '-w', '4',
                '-O',
                '-1', '?l?u?d',
                '--increment-min', '4',
                '-i',
                hash,
                '?1?1?1?1?1?1?1?1?1?1'
            ];
            if (assignedDevices) bfArgs.push('-d', assignedDevices);
            currentHashcatProcess = spawn('hashcat/hashcat', bfArgs);

            attachHashcatEventHandlers(currentHashcatProcess, () => {
                if (!isCrackingCompleted) {
                    log('Second hashcat process for %s finished, password not found.', hash);
                    ws.send(JSON.stringify({ password: 'Non trovata', message: 'Non sono riuscito a trovare la password... 😥' }));
                }
            });
        };


        const attachHashcatEventHandlers = (processInstance, onCloseCallback) => {
            let gpustatInterval = setInterval(() => {
                exec('gpustat -cup', (gpustatErr, gpustatStdout, gpustatStderr) => {
                    if (gpustatErr) {
                        error('gpustat error for %s: %s', hash, gpustatErr.message);
                        return;
                    }
                    const hashcatProcessCount = (gpustatStdout.match(/hashcat/g) || []).length;
                    if (hashcatProcessCount > 1) {
                        log('Hashcat process started computation for hash: %s (Count: %d)', hash, hashcatProcessCount);
                        clearInterval(gpustatInterval);
                        if (mode === 'dictionary') {
                            ws.send(JSON.stringify({ message: 'Ho iniziato a crackare la password in modalità dizionario! 📖' }));
                        } else if (mode === 'brute-force') {
                            ws.send(JSON.stringify({ message: 'Ho iniziato a crackare la password in modalità brute-force! 🔍' }));
                        }
                    }
                });
            }, 1000);

            processInstance.stdout.on('data', (data) => {
                log('Hashcat stdout for %s: %s', hash, data.toString().trim());
            });

            processInstance.stderr.on('data', (data) => {
                log('Hashcat stderr for %s: %s', hash, data.toString().trim());
            });

            processInstance.on('error', (hcError) => {
                error('Hashcat process error for %s: %s', hash, hcError.message);
                clearInterval(gpustatInterval);
                if (!isCrackingCompleted) {
                    ws.send(JSON.stringify({ error: 'Non ho voglia di lavorare oggi! 😴' }));
                    isCrackingCompleted = true; 
                }
            });

            processInstance.on('close', (code) => {
                log('Hashcat process for %s exited with code %s', hash, code);
                clearInterval(gpustatInterval);

                if (isCrackingCompleted) {
                    log('Hashcat process for %s closed, but password action (found/error) already taken.', hash);
                    return;
                }

                log('Attempting to retrieve password with --show for hash: %s', hash);
                exec(`hashcat/hashcat -m 0 --show ${hash}`, (e, s_out, s_err) => {
                    if (e) {
                        error('Failed to execute --show after hashcat process closed for %s: %s', hash, e.message);
                        if (s_err) {
                            error('Stderr from --show for %s: %s', hash, s_err.trim());
                        }
                        if (onCloseCallback) {
                            onCloseCallback(code);
                        }
                        return;
                    }

                    const trimmedStdout = s_out.trim();
                    if (trimmedStdout) {
                        const p_parts = trimmedStdout.split(':');
                        const pwd = p_parts.length > 1 ? p_parts.slice(1).join(':') : null;

                        if (pwd) {
                            isCrackingCompleted = true;
                            ws.send(JSON.stringify({ password: pwd, message: 'Ho trovato la password! 🥳' }));
                            log('Password successfully retrieved with --show and sent - Hash: %s, Password: %s', hash, pwd);
                        } else {
                            log('Hashcat --show for %s did not yield a clear password. Stdout: "%s"', hash, trimmedStdout);
                            if (onCloseCallback) {
                                onCloseCallback(code);
                            }
                        }
                    } else {
                        log('Hashcat --show for %s returned empty. Password not found.', hash);
                        if (onCloseCallback) {
                            onCloseCallback(code);
                        }
                    }
                });
            });
        };


        log('Checking for existing hash in potfile - Hash: %s', hash);
        exec(`hashcat/hashcat -m 0 --show ${hash}`, (err, stdout, stderr) => {
            if (err) {
                error('Failed to check existing hash: %s - Hash: %s', err.message, hash);
                ws.send(JSON.stringify({ error: 'Ops... Ho sbagliato qualcosa mentre cercavo la tua password negli archivi... 🗄️' }));
                return;
            }

            if (stdout.trim()) {
                const parts = stdout.trim().split(':');
                const password = parts.length > 1 ? parts.slice(1).join(':') : 'Potfile: Password not clearly found after colon';
                log('Password found in potfile - Hash: %s, Password: %s', hash, password);
                ws.send(JSON.stringify({ password: password, message: 'Ho trovato la password! 🎉' }));
                isCrackingCompleted = true;
                return;
            }

            log('Hash not found in potfile, initiating first cracking process (combinator) - Hash: %s', hash);
            ws.send(JSON.stringify({ message: 'Proviamo con un attacco con dizionario! 📖' }));
            mode = 'dictionary';
            const dictArgs = [
                '-m', '0',
                '-a', '1',
                '-w', '4',
                '-O',
                hash,
                'bruteforce.txt',
                'bruteforce.txt'
            ];
            if (assignedDevices) dictArgs.push('-d', assignedDevices);
            currentHashcatProcess = spawn('hashcat/hashcat', dictArgs);
            
            attachHashcatEventHandlers(currentHashcatProcess, (code) => {
                if (!isCrackingCompleted) {
                    if (code !== 0) {
                         log('First hashcat process for %s exited with non-zero code %s and password not found. Starting next process.', hash, code);
                    } else {
                         log('First hashcat process for %s finished, password not found. Starting next process.', hash);
                    }
                    startNextHashcatProcess();
                } else {
                }
            });
        });
    });

    ws.on('close', () => {
        log('WebSocket client disconnected.');
        if (currentHashcatProcess && !currentHashcatProcess.killed && !isCrackingCompleted) {
            currentHashcatProcess.kill();
            log('Terminated hashcat process due to client disconnection.');
        }
        currentHashcatProcess = null;
    });

    ws.on('error', (err) => {
        error('WebSocket connection error: %s', err.message);
        if (currentHashcatProcess && !currentHashcatProcess.killed && !isCrackingCompleted) {
            currentHashcatProcess.kill();
            log('Terminated hashcat process due to WebSocket error.');
        }
        currentHashcatProcess = null;
    });

    ws.send(JSON.stringify({ message: 'Connessione al server riuscita! 👋' }));
});

server.listen(port, () => {
    log('Server (HTTP & WebSocket) initialized and running at http://localhost:%d and ws://localhost:%d', port, port);
});
