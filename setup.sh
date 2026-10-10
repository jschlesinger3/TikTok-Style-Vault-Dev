#!/usr/bin/env bash
# One-shot setup for the wardrobe system (Style Vault + Telegram stylist bot) on a Mac Mini or Linux box.
# Asks a few questions, writes .env, starts everything with Docker Compose, and registers the Telegram webhook.
# Safe to re-run: current answers in .env are offered as defaults (press Enter to keep).
# Works with macOS's built-in bash 3.2 and BSD tools.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---------- Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  if [ "$(uname)" = "Darwin" ]; then
    die "Docker isn't installed. Install Docker Desktop (or OrbStack), start it, then re-run ./setup.sh"
  fi
  bold "Installing Docker…"
  curl -fsSL https://get.docker.com | sudo sh
fi
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if [ "$(uname)" != "Darwin" ] && sudo docker info >/dev/null 2>&1; then DOCKER="sudo docker"
  else die "Docker isn't running. Start Docker Desktop / OrbStack and re-run ./setup.sh"; fi
fi
$DOCKER compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose …)"

# ---------- Helpers ----------
get_env() {  # current value from .env, without surrounding single quotes
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed "s/^'\(.*\)'\$/\1/"
}
ask() {  # ask VAR "Question" "default" [secret] [optional]
  local var=$1 q=$2 def=${3:-} secret=${4:-} optional=${5:-} ans hint=""
  if [ -n "$def" ]; then if [ -n "$secret" ]; then hint=" [keep current]"; else hint=" [$def]"; fi; fi
  while true; do
    if [ -n "$secret" ]; then read -rsp "$q$hint: " ans; echo; else read -rp "$q$hint: " ans; fi
    ans=${ans:-$def}
    if [ -n "$ans" ] || [ -n "$optional" ]; then break; fi
    echo "  (required)"
  done
  printf -v "$var" '%s' "$ans"
}
yes_no() {  # yes_no "Question" default(y|n) -> exit status
  local ans def=$2
  read -rp "$1 [$( [ "$def" = y ] && echo Y/n || echo y/N )]: " ans
  ans=${ans:-$def}
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}
secret_or() { local cur; cur=$(get_env "$1"); [ -n "$cur" ] && [ "$cur" != "CHANGE_ME" ] && echo "$cur" || openssl rand -hex 24; }

bold "Wardrobe system setup"
echo "Press Enter to accept the value in [brackets]."
echo

# ---------- 1. Login ----------
bold "1/5  Style Vault login"
DEF_USER=$(get_env APP_USER); ask APP_USER "Username" "${DEF_USER:-me}"
APP_PASSWORD_HASH=$(get_env APP_PASSWORD_HASH)
if [ -n "$APP_PASSWORD_HASH" ] && ! yes_no "Change password?" n; then :; else
  while true; do
    read -rsp "Password (8+ characters): " PW; echo
    read -rsp "Repeat password: " PW2; echo
    if [ "$PW" = "$PW2" ] && [ ${#PW} -ge 8 ]; then break; fi
    echo "  Passwords didn't match or were too short, try again."
  done
  APP_PASSWORD_HASH=$($DOCKER run --rm caddy:2.8-alpine caddy hash-password --plaintext "$PW")
  unset PW PW2
fi
echo

# ---------- 2. Claude ----------
bold "2/5  Claude API key (console.anthropic.com > API Keys)"
ask ANTHROPIC_API_KEY "API key" "$(get_env ANTHROPIC_API_KEY)" secret
echo

# ---------- 3. Telegram ----------
bold "3/5  Telegram bot (message @BotFather > /newbot)"
ask TELEGRAM_BOT_TOKEN "Bot token" "$(get_env TELEGRAM_BOT_TOKEN)" secret
ask ALLOWED_CHAT_IDS "Your chat id (leave blank for now - the bot will tell you it)" "$(get_env ALLOWED_CHAT_IDS)" "" optional
echo

# ---------- 4. Cloudflare Tunnel ----------
bold "4/5  Public address (Cloudflare Tunnel)"
echo "In Cloudflare Zero Trust > Networks > Tunnels, add a public hostname (e.g. style.yourdomain.com)"
echo "pointing to http://localhost:8080 (cloudflared on the Mac) or http://web:80 (cloudflared in Docker)."
DEF_URL=$(get_env PUBLIC_URL); [ -z "$DEF_URL" ] || [ "$DEF_URL" = "https://style.example.com" ] && DEF_URL="https://style.kalmankatse.bid"
ask PUBLIC_URL "Public URL" "$DEF_URL"
case "$PUBLIC_URL" in https://*) ;; *) PUBLIC_URL="https://${PUBLIC_URL#http://}" ;; esac
PUBLIC_URL=${PUBLIC_URL%/}
PROFILES=""
CLOUDFLARE_TUNNEL_TOKEN=$(get_env CLOUDFLARE_TUNNEL_TOKEN)
if yes_no "Is cloudflared already running on this Mac?" "$( [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ] && echo n || echo y )"; then
  CLOUDFLARE_TUNNEL_TOKEN=""
else
  ask CLOUDFLARE_TUNNEL_TOKEN "Tunnel token (Zero Trust > Tunnels > your tunnel > install command, the long eyJ… string)" "$CLOUDFLARE_TUNNEL_TOKEN" secret
  PROFILES="tunnel"
fi
echo

# ---------- 5. n8n ----------
bold "5/5  n8n (runs /fit, /worn, /purge, /audit)"
CUR_N8N=$(get_env N8N_BASE_URL)
if yes_no "Is n8n already running on this Mac (port 5678)?" "$( [ "$CUR_N8N" = "http://n8n:5678" ] && echo n || echo y )"; then
  N8N_BASE_URL="http://host.docker.internal:5678"
else
  N8N_BASE_URL="http://n8n:5678"
  PROFILES="${PROFILES:+$PROFILES,}n8n"
fi
echo

# If Postgres (or anything) already listens on 5432 on this Mac, publish ours on 5433 instead.
DB_PORT=$(get_env DB_PORT)
if [ -z "$DB_PORT" ]; then
  DB_PORT=5432
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1 \
     && ! $DOCKER compose ps db 2>/dev/null | grep -q 5432; then
    DB_PORT=5433
    echo "Port 5432 is already in use on this Mac - the wardrobe database will be on 5433."
  fi
fi
POSTGRES_PASSWORD=$(secret_or POSTGRES_PASSWORD)
TELEGRAM_WEBHOOK_SECRET=$(secret_or TELEGRAM_WEBHOOK_SECRET)
BOT_SHARED_SECRET=$(secret_or BOT_SHARED_SECRET)
TZ_NAME=$(get_env TZ); [ -z "$TZ_NAME" ] && TZ_NAME=$( (readlink /etc/localtime 2>/dev/null || true) | sed -n 's#.*zoneinfo/##p'); TZ_NAME=${TZ_NAME:-UTC}
keep() { local v; v=$(get_env "$1"); echo "${v:-$2}"; }

q() { printf "'%s'" "$1"; }  # single quotes keep $ characters (bcrypt hash) literal for Compose
[ -f .env ] && cp .env ".env.bak.$(date +%s)"
umask 077
cat > .env <<EOF
# Written by setup.sh - re-run it to change values. See .env.example for what each setting does.
ANTHROPIC_API_KEY=$(q "$ANTHROPIC_API_KEY")
TELEGRAM_BOT_TOKEN=$(q "$TELEGRAM_BOT_TOKEN")
TELEGRAM_WEBHOOK_SECRET=$(q "$TELEGRAM_WEBHOOK_SECRET")
ALLOWED_CHAT_IDS=$(q "$ALLOWED_CHAT_IDS")
BOT_SHARED_SECRET=$(q "$BOT_SHARED_SECRET")

POSTGRES_USER=wardrobe
POSTGRES_PASSWORD=$(q "$POSTGRES_PASSWORD")
POSTGRES_DB=wardrobe
DATABASE_URL=$(q "postgresql://wardrobe:$POSTGRES_PASSWORD@localhost:$DB_PORT/wardrobe")

APP_USER=$(q "$APP_USER")
APP_PASSWORD_HASH=$(q "$APP_PASSWORD_HASH")
PUBLIC_URL=$(q "$PUBLIC_URL")

WEB_PORT=$(keep WEB_PORT 8080)
API_PORT=$(keep API_PORT 8000)
DB_PORT=$DB_PORT
N8N_BASE_URL=$(q "$N8N_BASE_URL")
COMPOSE_PROFILES=$(q "$PROFILES")
CLOUDFLARE_TUNNEL_TOKEN=$(q "$CLOUDFLARE_TUNNEL_TOKEN")
TZ=$(q "$TZ_NAME")

STORAGE_BACKEND=$(keep STORAGE_BACKEND local)
MAX_VIDEO_MB=$(keep MAX_VIDEO_MB 95)
MAX_IMAGE_MB=$(keep MAX_IMAGE_MB 15)
STORE_VIDEOS=$(keep STORE_VIDEOS true)
S3_ENDPOINT_URL=$(q "$(get_env S3_ENDPOINT_URL)")
S3_REGION=$(q "$(get_env S3_REGION)")
S3_BUCKET=$(q "$(get_env S3_BUCKET)")
S3_ACCESS_KEY=$(q "$(get_env S3_ACCESS_KEY)")
S3_SECRET_KEY=$(q "$(get_env S3_SECRET_KEY)")
S3_PUBLIC_BASE_URL=$(q "$(get_env S3_PUBLIC_BASE_URL)")

ANALYSIS_MODEL=$(keep ANALYSIS_MODEL claude-sonnet-5-5)
ANALYSIS_FRAMES=$(keep ANALYSIS_FRAMES 6)
SCRAPER_INTERVAL_MINUTES=$(keep SCRAPER_INTERVAL_MINUTES 30)
SCRAPER_TIMEOUT_SECONDS=$(keep SCRAPER_TIMEOUT_SECONDS 20)
SCRAPER_USE_PLAYWRIGHT=$(keep SCRAPER_USE_PLAYWRIGHT false)
INSTALL_PLAYWRIGHT=$(keep INSTALL_PLAYWRIGHT false)
API_KEY=
CORS_ORIGINS=$(q "$PUBLIC_URL")
EOF

# ---------- Start ----------
bold "Building and starting (the first build takes a few minutes)…"
$DOCKER compose up -d --build

for _ in $(seq 1 30); do
  $DOCKER compose exec -T db pg_isready -U wardrobe >/dev/null 2>&1 && break; sleep 2
done
# Idempotent: upgrades an existing database to the current schema (no-op on a fresh one).
$DOCKER compose exec -T db psql -q -U wardrobe wardrobe < wardrobe-bot/schema.sql >/dev/null 2>&1 || true

WEB_PORT_NOW=$(get_env WEB_PORT)
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:${WEB_PORT_NOW:-8080}/" || true)
  [ "$code" = "401" ] && break; sleep 2
done
[ "${code:-}" = "401" ] || die "Style Vault didn't come up on http://localhost:${WEB_PORT_NOW:-8080}. Check: docker compose logs web api"

bold "Registering the Telegram webhook…"
if $DOCKER compose exec -T bot node scripts/set-webhook.js; then :; else
  echo "Couldn't register the webhook yet - make sure $PUBLIC_URL reaches this Mac through the tunnel, then run:"
  echo "  docker compose exec bot node scripts/set-webhook.js"
fi

echo
bold "✅ Running."
echo "   Style Vault:  $PUBLIC_URL   (local: http://localhost:${WEB_PORT_NOW:-8080}, user '$APP_USER')"
if [ -z "$ALLOWED_CHAT_IDS" ]; then
  echo "   Next: message your bot - it replies with your chat id. Re-run ./setup.sh and enter it."
fi
echo "   n8n: build the fit / worn / purge / audit workflows - see wardrobe-bot/README.md."
echo "        n8n's Postgres credential: host localhost, port $DB_PORT, database + user wardrobe, password = POSTGRES_PASSWORD in .env"
