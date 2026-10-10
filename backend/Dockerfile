# Build context: repository root (needs wardrobe-bot/prompts).
FROM python:3.12-slim

# Set INSTALL_PLAYWRIGHT=true to add headless Chromium for JS-rendered drop pages (+~400MB).
ARG INSTALL_PLAYWRIGHT=false

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PROMPTS_DIR=/srv/prompts MEDIA_ROOT=/data/media
WORKDIR /srv

# ffmpeg: video frame extraction + merging yt-dlp video/audio streams
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then \
      pip install --no-cache-dir playwright==1.49.1 && playwright install --with-deps chromium; \
    fi

COPY backend/app ./app
COPY wardrobe-bot/prompts ./prompts
RUN useradd -m appuser && mkdir -p /data/media && chown -R appuser /data/media
USER appuser

EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${API_PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
