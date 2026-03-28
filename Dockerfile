FROM node:22-slim

# Build tools needed by better-sqlite3 (native C++ module)
RUN apt-get update && apt-get install -y python3 make g++ wget && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

# Install deps (postinstall runs patch-kokoro.js)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Download voices to /app/voices/
# patch-kokoro.js makes kokoro resolve: process.cwd()/../voices/ = /app/voices/
RUN mkdir -p /app/voices && \
    for voice in af_heart af_bella af_nicole am_fenrir am_michael am_puck bf_emma bm_george; do \
      wget -q -O /app/voices/${voice}.bin \
        "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${voice}.bin"; \
    done

# Pre-download ONNX model (~82 MB) into the image layer to avoid slow cold starts
RUN node scripts/download-model.mjs

EXPOSE 7860
ENV PORT=7860
ENV NODE_ENV=production

CMD ["node", "server.js"]
