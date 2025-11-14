FROM node:20-bullseye

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Install ffmpeg + pip + yt-dlp (pip gives latest yt-dlp)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3-pip ca-certificates \
  && pip3 install --upgrade pip \
  && pip3 install yt-dlp \
  && rm -rf /var/lib/apt/lists/*

# Copy package manifest(s) and install node deps (no lockfile required)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy app files
COPY . .

# Ensure downloads dir exists and is writable
RUN mkdir -p /app/downloads && chown -R node:node /app/downloads

# Run as non-root for safety
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]
