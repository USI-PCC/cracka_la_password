# syntax=docker/dockerfile:1.7

ARG CUDA_VERSION=13.0.0
ARG UBUNTU_VERSION=24.04
ARG HASHCAT_TAG=v7.1.2
ARG NODE_MAJOR=22

# ---------- Stage 1: build hashcat against CUDA dev toolkit ----------
FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_VERSION} AS hashcat-builder

ARG HASHCAT_TAG
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential cmake pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${HASHCAT_TAG}" https://github.com/hashcat/hashcat.git
WORKDIR /src/hashcat
RUN make -B -j"$(nproc)"

# ---------- Stage 2: runtime ----------
FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION} AS runtime

ARG NODE_MAJOR
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg python3 python3-pip wget \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && pip install --break-system-packages gpustat \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the full built hashcat tree — server.js invokes `hashcat/hashcat` and
# hashcat needs its OpenCL/charset/kernel subdirectories at runtime.
COPY --from=hashcat-builder /src/hashcat /app/hashcat

# Install Node deps from the lockfile
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# App code
COPY server/server.js ./
COPY server/bruteforce.txt server/parole_uniche.txt ./

# Frontend served by express.static('public')
COPY frontend/ ./public/

ENV PORT=3100
EXPOSE 3100

CMD ["node", "server.js"]
