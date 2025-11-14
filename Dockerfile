FROM node:20-bullseye

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Install ffmpeg + pip + yt-dlp (pip gives latest yt-dlp)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3-pip ca-certificates \
  && pip3 install --upgrade pip \
  && pip3 install yt-dlp \
  && rm -rf /var/lib/apt/lists/*

# Copy app and install Node deps
COPY package.json package-lock.json* ./
RUN npm ci --production

COPY . .

# Ensure downloads dir exists and is writable
RUN mkdir -p /app/downloads && chown -R node:node /app/downloads

USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.js"]
