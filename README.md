# Cracka la password

Attività dimostrativa della [Facoltà di Informatica dell'USI](https://www.inf.usi.ch), preparata per la giornata di porte aperte [**UniVerso 2026**](https://www.universo.usi.ch/it/info-pratiche).

Il visitatore inserisce una parola nel browser, riceve il suo hash MD5, e poi chiede al server di "crackarlo": il tempo impiegato rende tangibile quanto sia (in)sicura la password scelta.

> **Che cosa succede qui.** Impara come funzionano le password, perché sono importanti e come proteggerle dagli hacker. Scopri le tecniche usate per crackarle e come creare codici sicuri per proteggere i tuoi dati online. Capirai i rischi delle password deboli e l'importanza di gestirle con attenzione. Un viaggio nel mondo della sicurezza digitale per navigare in rete senza pericoli!
>
> **Perché c'entra con te.** Questo tema riguarda te perché usi internet tutti i giorni: per i social, i videogiochi, la scuola. Ma se la tua password è facile da indovinare, qualcuno potrebbe rubarti l'account e farti perdere tutto! Sapere come gli hacker crackano le password ti aiuta a proteggerti e a evitare problemi. Imparando a creare password sicure, puoi usare internet senza rischi e tenere al sicuro i tuoi dati!
>
> Attività a ciclo continuo · Per tutti · Dalle 12:00 · Palazzo rosso, Livello 2, A23

## Architettura

Due componenti in un unico progetto Docker Compose:

- **Frontend statico** (`frontend/`) — HTML/JS vanilla. `index.html` calcola localmente l'hash MD5 di una parola scritta dall'utente tramite [CryptoJS](https://github.com/brix/crypto-js); `crack.html` invia l'hash al server via WebSocket e mostra il risultato insieme al tempo impiegato.
- **Server WebSocket** (`server/server.js`) — Node.js 22. Per ogni richiesta prova prima la **cache di hash precalcolati** (vedi sezione successiva); in caso di miss tenta un attacco con dizionario combinatorio usando le liste `bruteforce.txt` e `parole_uniche.txt`, poi ripiega su un brute-force incrementale. Ogni richiesta di crack viene assegnata a un sottoinsieme di GPU tramite round-robin (variabile `HASHCAT_DEVICES`), così più visitatori possono giocare in parallelo senza contesa.

Il `Dockerfile` multi-stage compila [hashcat](https://hashcat.net) `v7.1.2` contro CUDA 13 e lo copia in un'immagine runtime basata su `nvidia/cuda:13.0.0-runtime-ubuntu24.04`. Il frontend è servito dallo stesso container via `express.static`.

## Cache di hash precalcolati

Per rendere istantanee le risposte sulle password più probabili, il server carica all'avvio una cache pre-costruita di coppie `MD5 → password` sotto `/scratch/cracka_kv/`. Quando arriva la richiesta di un visitatore il server prova **prima** la cache; solo in caso di miss esegue il flusso hashcat (potfile → dizionario → brute-force) come prima. La cache vive su disco condiviso (bind mount), quindi sopravvive ai riavvii e alle ricostruzioni del container.

La cache viene generata una sola volta, offline, dallo script [`server/precompute-build.sh`](server/precompute-build.sh): tre piccoli binari C (`enumerate_md5`, `md5fill_kv`, `shard_sort`) enumerano lo spazio delle password in fasi disgiunte, scrivono record di 24 byte (`15B hash + 1B lunghezza + 8B password con padding`) in 256 file shard `shard_XX.bin` ordinati per chiave, e infine pubblicano un `manifest.json` con `complete: true`. Il modulo [`server/kvLookup.js`](server/kvLookup.js) fa binary search su `fs.readSync` per restituire la password in meno di un millisecondo (~130 ms end-to-end con WebSocket compresi).

### Cosa contiene la cache

| Fase | Spazio coperto | Voci | Storage |
|------|----------------|------|---------|
| 1 | `?l?u?d?s{10}` lunghezza 1–6 — minuscole + maiuscole + cifre + 10 simboli (`!@#$%&*+-_`), 72 caratteri totali | ~141 miliardi | 3.3 TB |
| 2 | `?l` lunghezza 7–8 — solo minuscole | ~217 miliardi | 5.2 TB |
| 3 | `?d` lunghezza 1–8 — solo cifre (PIN, anni di nascita, numeri di telefono corti) | 111 milioni | 2.7 GB |
| **Totale (dopo dedupe)** | | **~358 miliardi** | **~8.5 TB** |

In pratica la cache risolve istantaneamente:
- ogni password fino a 6 caratteri composta da lettere, cifre o uno dei 10 simboli base;
- ogni parola di 7 o 8 caratteri tutta minuscola (es. `password`, `juventus`, `caratter`);
- ogni PIN o numero fino a 8 cifre.

Le password più lunghe di 8 caratteri non entrano nella cache (limite del formato del record) e vengono gestite dal flusso hashcat tradizionale, che è anche la parte pedagogicamente più interessante della demo: il visitatore *vede* la GPU lavorare.

### Build & disattivazione

Costruzione completa (~1.5–2 ore su un host con 128 core e SSD veloce):

```bash
docker compose exec -d cracka bash -c '
    SORT_CONCURRENCY=8 PHASES="1 2 3" \
    bash /app/precompute-build.sh \
    > /scratch/cracka_kv/build.log 2>&1
'
tail -F /scratch/cracka_kv/build.log
```

Per disattivare la cache senza ricostruire nulla — utile come kill-switch durante l'evento — basta `PRECOMPUTE_KV_ENABLED=0` nell'ambiente del container e `docker compose up -d`: il server torna esattamente al comportamento pre-cache (potfile → dizionario → brute-force).

## Come eseguirlo

**Prerequisiti:** Docker, Docker Compose v2, una GPU NVIDIA con driver recente e [`nvidia-container-toolkit`](https://github.com/NVIDIA/nvidia-container-toolkit) configurato in modalità CDI.

```bash
docker compose build
docker compose up -d
```

Il servizio ascolta su `127.0.0.1:3100` (loopback). Per esporlo esternamente basta mettere davanti un reverse proxy — un esempio nginx minimale è in [`deploy/nginx/cracka.conf`](deploy/nginx/cracka.conf):

```bash
sudo ln -s "$PWD/deploy/nginx/cracka.conf" /etc/nginx/sites-enabled/cracka
sudo nginx -t && sudo systemctl reload nginx
```

### Configurazione

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `PORT` | `3100` | Porta interna su cui ascolta il server. |
| `HASHCAT_DEVICES` | `1,2;3,4` | Slot di GPU assegnati a rotazione per ogni richiesta di crack. Gruppi separati da `;`, dispositivi all'interno di un gruppo separati da `,`. Se vuoto, hashcat usa tutti i dispositivi visibili. |
| `PRECOMPUTE_KV_ENABLED` | `1` | Se `0`, salta la cache di hash precalcolati e usa solo il flusso hashcat. |
| `PRECOMPUTE_KV_PATH` | `/scratch/cracka_kv` | Directory che contiene i 256 shard `shard_XX.bin` e il `manifest.json`. |

### Benchmark

`frontend/bench.py` misura il tempo medio di crack generando parole casuali e inviandole al server:

```bash
cd frontend
pip install -r requirements.txt
python3 bench.py -l 6 -t 10 --lower --server_url ws://localhost:3100
```

## Nota sulla sicurezza

Questa è una demo didattica, non un servizio di produzione.

- **MD5 è scelto proprio perché è debole**: senza un algoritmo vulnerabile l'esperienza "crackiamo la password in qualche secondo" non avrebbe senso pedagogico. Non usare mai MD5 per proteggere password reali.
- Il server non ha autenticazione né rate-limiting: è pensato per girare in una rete chiusa durante l'evento, non come servizio pubblico.

## Crediti

Attività organizzata da [USI Informatica](https://www.inf.usi.ch) per UniVerso 2026. Cracking via [hashcat](https://hashcat.net).
