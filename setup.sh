#!/usr/bin/env bash
# One-shot installer for Style Vault on a fresh Ubuntu/Debian server.
# Asks a few questions, writes .env, starts everything, and prints your app URL.
# Safe to re-run: existing answers in .env are offered as defaults (press Enter to keep).
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# ---------- Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  bold "Installing Docker…"
  curl -fsSL https://get.docker.com | $SUDO sh
fi
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="$SUDO docker"
$DOCKER compose version >/dev/null 2>&1 || die "Docker Compose plugin missing (sudo apt install docker-compose-plugin)"

# ---------- Existing answers ----------
get_env() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1 | sed "s/^'\(.*\)'$/\1/" || true; }
ask() {  # ask VAR "Question" "default" [secret]
  local var=$1 q=$2 def=${3:-} secret=${4:-} ans hint=""
  if [ -n "$def" ]; then
    if [ -n "$secret" ]; then hint=" [keep current]"; else hint=" [$def]"; fi
  fi
  while true; do
    if [ -n "$secret" ]; then read -rsp "$q$hint: " ans; echo; else read -rp "$q$hint: " ans; fi
    ans=${ans:-$def}
    [ -n "$ans" ] && break
    echo "  (required)"
  done
  printf -v "$var" '%s' "$ans"
}

bold "Style Vault setup"
echo "Press Enter to accept the value in [brackets]."
echo

IP=$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || true)
DEFAULT_DOMAIN=$(get_env DOMAIN)
[ -z "$DEFAULT_DOMAIN" ] && [ -n "$IP" ] && DEFAULT_DOMAIN="${IP//./-}.sslip.io"

bold "1/4  Web address"
echo "Use your own domain (point its DNS A record at ${IP:-this server} first),"
echo "or keep the free sslip.io address, which works with no setup."
ask DOMAIN "Domain" "$DEFAULT_DOMAIN"
echo

bold "2/4  Login for the app"
DEF_USER=$(get_env APP_USER || true)
ask APP_USER "Username" "${DEF_USER:-me}"
APP_PASSWORD_HASH=$(get_env APP_PASSWORD_HASH)
if [ -n "$APP_PASSWORD_HASH" ]; then
  read -rp "Change password? [y/N]: " yn
  [[ "$yn" =~ ^[Yy] ]] && APP_PASSWORD_HASH=""
fi
if [ -z "$APP_PASSWORD_HASH" ]; then
  while true; do
    read -rsp "Password (8+ characters): " PW; echo
    read -rsp "Repeat password: " PW2; echo
    [ "$PW" = "$PW2" ] && [ ${#PW} -ge 8 ] && break
    echo "  Passwords didn't match or were too short, try again."
  done
  APP_PASSWORD_HASH=$($DOCKER run --rm caddy:2.8-alpine caddy hash-password --plaintext "$PW")
  unset PW PW2
fi
echo

bold "3/4  Storage bucket (DigitalOcean Spaces / Linode / AWS S3)"
echo "DigitalOcean: Spaces > Create bucket, then API > Spaces Keys > Generate."
DEF_EP=$(get_env S3_ENDPOINT_URL || true)
[ -f .env ] && [ -z "$DEF_EP" ] && DEF_EP="aws"
ask S3_ENDPOINT_URL "Endpoint URL (type 'aws' for Amazon S3)" "${DEF_EP:-https://nyc3.digitaloceanspaces.com}"
[ "$S3_ENDPOINT_URL" = "aws" ] && S3_ENDPOINT_URL=""
DEF_REGION=$(get_env S3_REGION)
[ -z "$DEF_REGION" ] && DEF_REGION=$(printf '%s' "$S3_ENDPOINT_URL" | sed -n 's#https://\([a-z0-9-]*\)\.\(digitaloceanspaces\|linodeobjects\)\.com.*#\1#p')
ask S3_REGION "Region" "${DEF_REGION:-us-east-1}"
ask S3_BUCKET "Bucket name" "$(get_env S3_BUCKET || true)"
ask S3_ACCESS_KEY "Access key" "$(get_env S3_ACCESS_KEY || true)"
ask S3_SECRET_KEY "Secret key" "$(get_env S3_SECRET_KEY || true)" secret
echo

bold "4/4  Claude API key (console.anthropic.com > API Keys)"
ask ANTHROPIC_API_KEY "API key" "$(get_env ANTHROPIC_API_KEY || true)" secret
echo

POSTGRES_PASSWORD=$(get_env POSTGRES_PASSWORD)
[ -z "$POSTGRES_PASSWORD" ] || [ "$POSTGRES_PASSWORD" = "change-me" ] && POSTGRES_PASSWORD=$(openssl rand -hex 16)

q() { printf "'%s'" "$1"; }  # single quotes: Compose keeps $ characters (bcrypt hash) literal
[ -f .env ] && cp .env ".env.bak.$(date +%s)"
umask 077
cat > .env <<EOF
# Written by setup.sh - re-run it to change values.
DOMAIN=$(q "$DOMAIN")
APP_USER=$(q "$APP_USER")
APP_PASSWORD_HASH=$(q "$APP_PASSWORD_HASH")

API_PORT=8000
API_KEY=
CORS_ORIGINS=$(q "https://$DOMAIN")

POSTGRES_USER=vault
POSTGRES_PASSWORD=$(q "$POSTGRES_PASSWORD")
POSTGRES_DB=vault

S3_ENDPOINT_URL=$(q "$S3_ENDPOINT_URL")
S3_REGION=$(q "$S3_REGION")
S3_BUCKET=$(q "$S3_BUCKET")
S3_ACCESS_KEY=$(q "$S3_ACCESS_KEY")
S3_SECRET_KEY=$(q "$S3_SECRET_KEY")
S3_PUBLIC_BASE_URL=$(q "$(get_env S3_PUBLIC_BASE_URL || true)")
MAX_IMAGE_MB=15
MAX_VIDEO_MB=150
STORE_VIDEOS=true

ANTHROPIC_API_KEY=$(q "$ANTHROPIC_API_KEY")
ANALYSIS_MODEL=$(q "$(get_env ANALYSIS_MODEL || true)")
ANALYSIS_FRAMES=6

SCRAPER_INTERVAL_MINUTES=30
SCRAPER_TIMEOUT_SECONDS=20
SCRAPER_USE_PLAYWRIGHT=false
INSTALL_PLAYWRIGHT=false
EOF
# Empty ANALYSIS_MODEL would override the default; drop it.
sed -i "/^ANALYSIS_MODEL=''$/d" .env

# ---------- Firewall ----------
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 80/tcp >/dev/null; $SUDO ufw allow 443/tcp >/dev/null; $SUDO ufw allow 443/udp >/dev/null
fi

# ---------- Start ----------
bold "Building and starting (first build takes a few minutes)…"
$DOCKER compose up -d --build

# Existing databases need the newer columns (no-op on fresh installs).
for _ in $(seq 1 30); do
  $DOCKER compose exec -T db pg_isready -U vault >/dev/null 2>&1 && break; sleep 2
done
$DOCKER compose exec -T db psql -q -U vault vault < db/init.sql >/dev/null 2>&1 || true

bold "Waiting for HTTPS certificate…"
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/" || true)
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then
    echo
    bold "✅ Style Vault is live:  https://$DOMAIN"
    echo "   Log in as '$APP_USER' with the password you chose."
    echo "   On your phone: open it, then 'Add to Home Screen' (see README > Phone)."
    exit 0
  fi
  sleep 3
done
echo
echo "Started, but https://$DOMAIN isn't answering yet. Check:"
echo "  - ports 80 and 443 are open in your cloud firewall"
echo "  - if using your own domain, its DNS points to ${IP:-this server}"
echo "  - logs: docker compose logs web"
exit 1
