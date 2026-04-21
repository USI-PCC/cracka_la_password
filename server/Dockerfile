FROM ubuntu:22.04

# Install essential packages and CUDA dependencies
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    cmake \
    pkg-config \
    nodejs \
    npm \
    wget \
    gnupg2 \
    software-properties-common \
    # opencl-headers \
    # ocl-icd-opencl-dev \
    # ocl-icd-libopencl1 \
    # nvidia-opencl-dev \
    # intel-opencl-icd \
    # pocl-opencl-icd \
    # libpocl-dev \
    && rm -rf /var/lib/apt/lists/*

# Add CUDA repository and install CUDA toolkit
RUN wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.0-1_all.deb && \
    dpkg -i cuda-keyring_1.0-1_all.deb && \
    apt-get update && \
    apt-get install -y cuda-toolkit-12-0 && \
    rm -rf /var/lib/apt/lists/* && \
    rm cuda-keyring_1.0-1_all.deb

# Set CUDA environment variables
ENV PATH=/usr/local/cuda/bin:${PATH}
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH}

# Copy hashcat source files
COPY . .

# Install Node.js dependencies
RUN npm install express cors

RUN git clone https://github.com/hashcat/hashcat.git

WORKDIR hashcat

# Create obj directory and build hashcat with CUDA support
RUN make -B

# Install python and pip
RUN apt-get update && apt-get install -y python3 python3-pip
RUN pip install gpustat

# Expose the port the app runs on
EXPOSE 3000

WORKDIR /

# Command to run the server
CMD ["node", "server.js"]