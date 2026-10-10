FROM python:3.12-slim

# Set INSTALL_PLAYWRIGHT=true to add headless Chromium for JS-rendered pages (+~400MB).
ARG INSTALL_PLAYWRIGHT=false

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

# ffmpeg: frame extraction + merging yt-dlp video/audio streams
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then \
      pip install --no-cache-dir playwright==1.49.1 && playwright install --with-deps chromium; \
    fi

COPY app ./app
RUN useradd -m appuser
USER appuser

EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${API_PORT:-8000}"]
