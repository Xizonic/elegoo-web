#!/bin/bash
#
# Elegoo Web — Installation Script
# Installs elegoo-web as a systemd service
#

set -e

INSTALL_DIR="/opt/elegooweb"
SERVICE_NAME="elegooweb"
SERVICE_USER="elegooweb"
SERVICE_PORT="${1:-8088}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    log_error "This script must be run as root (or via sudo)"
    exit 1
fi

# Check for Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ $NODE_VERSION -lt 18 ]]; then
    log_error "Node.js version 18+ required. Found: $(node -v)"
    exit 1
fi
log_info "Node.js version: $(node -v)"

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
    log_error "pnpm is not installed. Install with: npm install -g pnpm"
    exit 1
fi
log_info "pnpm version: $(pnpm -v)"

# Resolve source directory (repo root = parent of contrib/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Create service user if not exists
if ! id "$SERVICE_USER" &>/dev/null; then
    log_info "Creating service user: $SERVICE_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# Create installation directory
log_info "Creating installation directory: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"

# Copy source files
log_info "Copying files..."
cp -r "$SCRIPT_DIR/src" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/dist" "$INSTALL_DIR/" 2>/dev/null || true
cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/pnpm-lock.yaml" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/tsconfig.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/tsconfig.server.json" "$INSTALL_DIR/" 2>/dev/null || true
cp -r "$SCRIPT_DIR/public" "$INSTALL_DIR/" 2>/dev/null || true

# Create .env if it doesn't already exist (preserve existing config on upgrades)
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    log_info "Creating default .env configuration..."
    cat > "$INSTALL_DIR/.env" << EOF
# Elegoo Web — Service Configuration
# See README.md for all available options

# Printer connection
PRINTER_IP=172.20.100.236
PRINTER_PASSWORD=123456

# Service port (web UI + API)
SERVICE_PORT=${SERVICE_PORT}

# Camera (auto-detected from printer IP if not set)
# CAMERA_ENABLED=true
# CAMERA_URL=http://172.20.100.236:8080

# Telegram notifications (optional)
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
# PROGRESS_INTERVAL=25

# Data persistence directory
DATA_DIR=/opt/elegooweb/data

# AI monitoring (optional)
# AI_ENABLED=false
# AI_VLM_ENABLED=true
# AI_VLM_API_KEY=
# AI_VLM_PROVIDER=ollama
# AI_VLM_BASE_URL=http://localhost:11434
# AI_VLM_MODEL=llava
# AI_LOCAL_ENABLED=true
# AI_LOCAL_MODEL=Xenova/siglip-base-patch16-224
# AI_INTERVAL=60
EOF
    log_info "  Edit $INSTALL_DIR/.env to configure your printer IP and options"
else
    log_info "Keeping existing .env configuration"
fi

# Build frontend if dist/ doesn't exist
if [[ ! -d "$INSTALL_DIR/dist" ]]; then
    log_info "Building frontend..."
    cd "$INSTALL_DIR"
    pnpm install
    pnpm build
else
    # Production install for server deps only
    log_info "Installing dependencies..."
    cd "$INSTALL_DIR"
    pnpm install --prod
fi

# Set ownership
log_info "Setting permissions..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# Install systemd service
log_info "Installing systemd service..."
cp "$SCRIPT_DIR/contrib/${SERVICE_NAME}.service" /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload

# Enable and (re)start service
log_info "Enabling and restarting service..."
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Check status
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    log_info "✓ ${SERVICE_NAME} service is running!"
    log_info "  Web UI:  http://localhost:${SERVICE_PORT}"
    log_info "  Config:  $INSTALL_DIR/.env"
    log_info "  Logs:    journalctl -u $SERVICE_NAME -f"
else
    log_warn "Service may not have started correctly"
    log_info "Check logs with: journalctl -u $SERVICE_NAME -e"
fi

log_info "Installation complete!"
