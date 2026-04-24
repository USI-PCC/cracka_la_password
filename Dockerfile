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
        git build-essential cmake pkg-config ca-certificates libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${HASHCAT_TAG}" https://github.com/hashcat/hashcat.git
WORKDIR /src/hashcat
RUN make -B -j"$(nproc)"

# Build the pre-compute helpers (md5fill_kv, shard_sort) in the same
# stage so they ride into the runtime image without pulling build tools
# into the final layers.
WORKDIR /src/cracka-bin
COPY server/src/md5fill_kv.c server/src/shard_sort.c server/src/Makefile ./
RUN make

# ---------- Stage 2: runtime ----------
FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION} AS runtime

ARG NODE_MAJOR
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg python3 python3-pip wget \
        cuda-nvrtc-13-0 \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && pip install --break-system-packages gpustat \
    && rm -rf /var/lib/apt/lists/*

# Register the NVIDIA OpenCL ICD so hashcat's OpenCL backend can find the
# platform. nvidia-container-toolkit in CDI mode does NOT auto-create this
# file the way the legacy nvidia runtime did, and the CUDA runtime base
# image doesn't ship it either.
RUN mkdir -p /etc/OpenCL/vendors && \
    echo 'libnvidia-opencl.so.1' > /etc/OpenCL/vendors/nvidia.icd

# hashcat v7.x dlopens the unversioned `libnvrtc.so` (and falls through to
# `libnvrtc.so.1`), but the `cuda-nvrtc-13-0` apt package installs only
# `libnvrtc.so.13` / `libnvrtc.so.13.0.88` — no unversioned symlink. Without
# this link hashcat prints "Failed to initialize NVIDIA RTC library" and
# falls back to OpenCL. Link the unversioned name to the installed SONAME
# and refresh ldconfig.
RUN ln -sf /usr/local/cuda/targets/x86_64-linux/lib/libnvrtc.so.13 \
           /usr/local/cuda/targets/x86_64-linux/lib/libnvrtc.so && \
    ldconfig

WORKDIR /app

# Copy the full built hashcat tree — server.js invokes `hashcat/hashcat` and
# hashcat needs its OpenCL/charset/kernel subdirectories at runtime.
COPY --from=hashcat-builder /src/hashcat /app/hashcat

# Pre-compute helpers for the KV cache.
COPY --from=hashcat-builder /src/cracka-bin/md5fill_kv /app/bin/md5fill_kv
COPY --from=hashcat-builder /src/cracka-bin/shard_sort /app/bin/shard_sort

# Install Node deps from the lockfile
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# App code
COPY server/server.js server/kvLookup.js ./
COPY server/bruteforce.txt server/parole_uniche.txt ./
COPY server/precompute-build.sh /app/precompute-build.sh
RUN chmod +x /app/precompute-build.sh

# Frontend served by express.static('public')
COPY frontend/ ./public/

ENV PORT=3100
EXPOSE 3100

CMD ["node", "server.js"]
