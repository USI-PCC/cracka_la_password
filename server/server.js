const express = require('express');
const { exec, spawn } = require('child_process');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const kv = require('./kvLookup');
const { envelope, MESSAGE_KINDS } = require('./wsProtocol');
const { parseStatusLine, summarize } = require('./hashcatStatus');
const fs = require('node:fs');

const app = express();
const port = Number(process.env.PORT) || 3100;

const server = http.createServer(app);

// --- Pre-compute KV cache bootstrap ---
// PRECOMPUTE_KV_PATH points at the sharded binary store (produced by
// precompute-build.sh). If the path is missing or the manifest isn't
// marked complete, kvLookup stays disabled and the server behaves
// exactly as before.
const kvEnabledEnv = process.env.PRECOMPUTE_KV_ENABLED !== '0';
const kvPath = process.env.PRECOMPUTE_KV_PATH || '/scratch/cracka_kv';
if (kvEnabledEnv) {
    kv.open(kvPath);
} else {
    console.log('[kvLookup] disabled by PRECOMPUTE_KV_ENABLED=0');
}

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

// Unique session name per hashcat invocation. Every hashcat command (spawn
// or --show exec) writes a pidfile/restorefile under its session dir; if
// two invocations share the default session "hashcat" they collide with
// "Already an instance running on pid N" even when the prior one has
// already exited (stale or PID-reused pidfile). A unique session per
// invocation eliminates the shared path.
let sessionCounter = 0;
const nextSession = () => `crk-${process.pid}-${++sessionCounter}`;

const log = (message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`\x1b[32m[${timestamp}]\x1b[0m\n${message}\n`, ...args);
};

const error = (message, ...args) => {
    const timestamp = new Date().toISOString();
    console.error(`\x1b[31m[${timestamp}] ERROR:\x1b[0m\n${message}\n`, ...args);
};

// Compute dictionary size once so the frontend can render a context card.
// Placed here (after `error` is defined) so the catch block can call error().
let dictSize = 0;
try {
    dictSize = fs.readFileSync('bruteforce.txt', 'utf8').split('\n').filter(Boolean).length;
} catch (e) {
    error('Could not read bruteforce.txt for dict size: %s', e.message);
}

function send(ws, kind, payload) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(envelope(kind, payload)));
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const wss = new WebSocket.Server({ server });

function assignedDevicesForHello() {
    // Show what slot WOULD be used; do not advance the cursor.
    if (deviceSlots.length === 0) return null;
    return deviceSlots[deviceCursor % deviceSlots.length];
}

log('WebSocket server created and attached to HTTP server.');

wss.on('connection', (ws) => {
    log('New WebSocket client connected.');

    let currentHashcatProcess = null;
    let isCrackingCompleted = false;
    let mode = null;

    ws.on('message', async (message) => {
        send(ws, MESSAGE_KINDS.RECEIVED, {});
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            error('Invalid JSON message received:', message);
            send(ws, MESSAGE_KINDS.ERROR, { message: 'invalid_json' });
            return;
        }

        const hash = parsedMessage.hash;
        const assignedDevices = nextDeviceSlot();
        log('Received hash for cracking - Hash: %s', hash);

        if (!hash) {
            error('Request rejected - Missing hash parameter');
            send(ws, MESSAGE_KINDS.ERROR, { message: 'missing_hash' });
            return;
        }

        const md5Regex = /^[a-f0-9]{32}$/i;
        if (!md5Regex.test(hash)) {
            error('Invalid MD5 hash format - Hash: %s', hash);
            send(ws, MESSAGE_KINDS.ERROR, { message: 'bad_hash_format' });
            return;
        }

        // --- Pre-compute KV cache lookup ---
        // Fast path: if the hash is in the pre-built cache, answer now
        // and skip the GPU round-trip entirely.
        const kvStart = performance.now();
        const cached = kv.lookup(hash.toLowerCase());
        const kvMs = performance.now() - kvStart;
        if (cached !== null) {
            log('Password found in pre-compute KV - Hash: %s, Password: %s (%fms)', hash, cached, kvMs);
            send(ws, MESSAGE_KINDS.CACHE_HIT, { source: 'kv', lookupMs: kvMs, password: cached });
            send(ws, MESSAGE_KINDS.RESULT, { password: cached, mode: 'kv' });
            isCrackingCompleted = true;
            return;
        }

        isCrackingCompleted = false;

        const startNextHashcatProcess = () => {
            log('Starting second hashcat process (brute-force) for hash: %s', hash);
            send(ws, MESSAGE_KINDS.STAGE, { name: 'brute-force', phase: 'start' });
            mode = 'brute-force';
            const bfArgs = [
                '-m', '0',
                '-a', '3',
                '-w', '4',
                '-O',
                '-1', '?l?u?d',
                '--increment-min', '4',
                '-i',
                '--status', '--status-json', '--status-timer', '1',
                hash,
                '?1?1?1?1?1?1?1?1?1?1'
            ];
            if (assignedDevices) bfArgs.push('-d', assignedDevices);
            bfArgs.push('--session', nextSession());
            currentHashcatProcess = spawn('hashcat/hashcat', bfArgs);

            attachHashcatEventHandlers(currentHashcatProcess, () => {
                if (!isCrackingCompleted) {
                    log('Second hashcat process for %s finished, password not found.', hash);
                    send(ws, MESSAGE_KINDS.RESULT, { password: null, mode: 'brute-force' });
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
                            send(ws, MESSAGE_KINDS.STAGE, { name: 'dictionary', phase: 'gpu-running' });
                        } else if (mode === 'brute-force') {
                            send(ws, MESSAGE_KINDS.STAGE, { name: 'brute-force', phase: 'gpu-running' });
                        }
                    }
                });
            }, 1000);

            let stdoutBuf = '';
            processInstance.stdout.on('data', (chunk) => {
                stdoutBuf += chunk.toString();
                let nl;
                while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
                    const line = stdoutBuf.slice(0, nl);
                    stdoutBuf = stdoutBuf.slice(nl + 1);
                    const parsed = parseStatusLine(line);
                    if (parsed) {
                        send(ws, MESSAGE_KINDS.STATUS, summarize(parsed));
                    } else if (line.trim()) {
                        // Keep the existing diagnostic logging for non-status lines.
                        log('Hashcat stdout for %s: %s', hash, line.trim());
                    }
                }
            });

            processInstance.stderr.on('data', (data) => {
                log('Hashcat stderr for %s: %s', hash, data.toString().trim());
            });

            processInstance.on('error', (hcError) => {
                error('Hashcat process error for %s: %s', hash, hcError.message);
                clearInterval(gpustatInterval);
                if (!isCrackingCompleted) {
                    send(ws, MESSAGE_KINDS.ERROR, { message: 'hashcat_failed' });
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
                exec(`hashcat/hashcat -m 0 --session ${nextSession()} --show ${hash}`, (e, s_out, s_err) => {
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
                            send(ws, MESSAGE_KINDS.RESULT, { password: pwd, mode });
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
        const potStart = performance.now();
        exec(`hashcat/hashcat -m 0 --session ${nextSession()} --show ${hash}`, (err, stdout, stderr) => {
            const potMs = performance.now() - potStart;
            if (err) {
                error('Failed to check existing hash: %s - Hash: %s', err.message, hash);
                send(ws, MESSAGE_KINDS.ERROR, { message: 'archivio_lookup_failed' });
                return;
            }

            if (stdout.trim()) {
                const parts = stdout.trim().split(':');
                const password = parts.length > 1 ? parts.slice(1).join(':') : 'Potfile: Password not clearly found after colon';
                log('Password found in potfile - Hash: %s, Password: %s (%fms)', hash, password, potMs);
                send(ws, MESSAGE_KINDS.CACHE_HIT, { source: 'potfile', lookupMs: potMs, password });
                send(ws, MESSAGE_KINDS.RESULT, { password, mode: 'potfile' });
                isCrackingCompleted = true;
                return;
            }

            log('Hash not found in potfile, initiating first cracking process (combinator) - Hash: %s', hash);
            send(ws, MESSAGE_KINDS.STAGE, { name: 'dictionary', phase: 'start' });
            mode = 'dictionary';
            const dictArgs = [
                '-m', '0',
                '-a', '1',
                '-w', '4',
                '-O',
                '--status', '--status-json', '--status-timer', '1',
                hash,
                'bruteforce.txt',
                'bruteforce.txt'
            ];
            if (assignedDevices) dictArgs.push('-d', assignedDevices);
            dictArgs.push('--session', nextSession());
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

    send(ws, MESSAGE_KINDS.HELLO, { deviceSlot: assignedDevicesForHello(), dictSize });
});

server.listen(port, () => {
    log('Server (HTTP & WebSocket) initialized and running at http://localhost:%d and ws://localhost:%d', port, port);
});
