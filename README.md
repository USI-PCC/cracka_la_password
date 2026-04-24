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
- **Server WebSocket** (`server/server.js`) — Node.js 22. Tenta prima un attacco con dizionario combinatorio usando le liste `bruteforce.txt` e `parole_uniche.txt`, poi ripiega su un brute-force incrementale. Ogni richiesta di crack viene assegnata a un sottoinsieme di GPU tramite round-robin (variabile `HASHCAT_DEVICES`), così più visitatori possono giocare in parallelo senza contesa.

Il `Dockerfile` multi-stage compila [hashcat](https://hashcat.net) `v7.1.2` contro CUDA 13 e lo copia in un'immagine runtime basata su `nvidia/cuda:13.0.0-runtime-ubuntu24.04`. Il frontend è servito dallo stesso container via `express.static`.

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
