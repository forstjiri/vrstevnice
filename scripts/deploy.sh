#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Vrstevnice — Deploy Script
#
# Synchronizuje kód + data a rozjede aplikaci na vzdáleném serveru.
# Idempotentní — bezpečné spustit opakovaně (přeskočí hotové kroky).
#
# Použití:
#   bash scripts/deploy.sh                         # plný deploy, Photon DB se zeptá
#   bash scripts/deploy.sh --photon                # plný deploy + Photon databáze
#   bash scripts/deploy.sh --code-only             # jen kód + build + restart
#   REMOTE=root@10.0.0.30 bash scripts/deploy.sh
#
# Proměnné (přes env):
#   REMOTE        SSH cíl            (defalult: root@10.0.0.11)
#   REMOTE_DIR    Cíl na serveru     (default: /opt/vrstevnice)
#   GH_HEAP       GraphHopper -Xmx   (default: 1500m)
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Config ──
REMOTE="${REMOTE:-root@10.0.0.11}"
REMOTE_DIR="${REMOTE_DIR:-/opt/vrstevnice}"
GH_HEAP="${GH_HEAP:-1500m}"
BE_PORT="${BE_PORT:-3002}"
COMPOSE_PROJECT="vrstevnice"

CODE_ONLY=false
TRANSFER_PHOTON=false
for arg in "$@"; do
  [[ "$arg" == "--code-only" ]] && CODE_ONLY=true
  [[ "$arg" == "--photon" ]] && TRANSFER_PHOTON=true
done

# ── Detect project root ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Output helpers ──
info()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m⚠\033[0m %s\n' "$*"; }
die()   { printf '\n\033[1;31m✗ %s\033[0m\n\n' "$*"; exit 1; }
phase() { printf '\n\033[1;36m══ %s ══\033[0m\n' "$*"; }
runc()  { ssh "$REMOTE" "$@"; }  # run command on remote

# ═══════════════════════════════════════════════════════════════════════
# PHASE 1: Pre-flight checks
# ═══════════════════════════════════════════════════════════════════════
phase "PRE-FLIGHT CHECKS"

# SSH
info "SSH connectivity"
runc 'echo ok' >/dev/null 2>&1 || die "Nelze se připojit na $REMOTE"
ok "SSH OK"

# Docker
info "Docker on remote"
runc 'docker info >/dev/null 2>&1' || die "Docker není k dispozici na $REMOTE"
DOCKER_VER=$(runc 'docker --version')
ok "$DOCKER_VER"

runc 'docker compose version >/dev/null 2>&1' || die "Docker Compose chybí"
ok "Docker Compose OK"

# RAM
info "Server resources"
RAM_KB=$(runc 'awk "/MemTotal/{print \$2}" /proc/meminfo')
RAM_GB=$((RAM_KB / 1024 / 1024))
DISK_AVAIL=$(runc 'df -BG / | tail -1 | awk "{print \$4}" | tr -d G')

if [[ "$RAM_GB" -lt 2 ]]; then
  die "RAM ${RAM_GB}GB je příliš málo (minimálně 2GB, doporučeno 3GB)"
fi
[[ "$RAM_GB" -lt 3 ]] && warn "RAM ${RAM_GB}GB — těsné, GH heap bude omezené" || ok "RAM ${RAM_GB}GB"
[[ "$DISK_AVAIL" -lt 10 ]] && die "Disk ${DISK_AVAIL}GB volných — potřeb min 10GB" || ok "Disk ${DISK_AVAIL}GB volných"

# Local data files
info "Local data files"
for f in data/cz.mbtiles data/cz-terrain.mbtiles data/cycleroutes.geojson data/cz-pois.sqlite; do
  [[ -f "$f" ]] || die "Chybí $f — spusť nejdřív setup skripty lokálně"
done
ok "Datové soubory přítomny"

# Summary
echo ""
printf "\033[1;37mCíl:\033[0m  %s:%s  (%s)\n" "$REMOTE" "$BE_PORT" "$REMOTE_DIR"
printf "\033[1;37mRAM:\033[0m  %sGB\n" "$RAM_GB"
printf "\033[1;37mGH:  \033[0m  -Xmx%s\n" "$GH_HEAP"
MODE_DESC="plný deploy"
[[ "$CODE_ONLY" == true ]] && MODE_DESC="jen kód+restart"
[[ "$TRANSFER_PHOTON" == true ]] && MODE_DESC+=" + Photon DB"
printf "\033[1;37mRežim:\033[0m %s\n" "$MODE_DESC"

if [[ "$CODE_ONLY" == false ]]; then
  printf "\n\033[1;32m✓ Photon + SQLite POI — 100%% self-hosted, žádné externí API\033[0m\n"
fi

echo ""
read -r -p "Pokračovat? [Enter/n] " response
[[ "$response" =~ ^[nN]$ ]] && exit 0

# ═══════════════════════════════════════════════════════════════════════
# PHASE 2: Toolchain (skip if present)
# ═══════════════════════════════════════════════════════════════════════
phase "TOOLCHAIN"

info "Node.js"
if runc 'command -v node >/dev/null 2>&1' 2>/dev/null; then
  ok "Node $(runc 'node --version')"
else
  runc 'export DEBIAN_FRONTEND=noninteractive; curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null 2>&1'
  ok "Node $(runc 'node --version') installed"
fi

info "pnpm"
if runc 'command -v pnpm >/dev/null 2>&1' 2>/dev/null; then
  ok "pnpm $(runc 'pnpm --version')"
else
  runc 'npm install -g pnpm >/dev/null 2>&1'
  ok "pnpm installed"
fi

info "Bun"
if runc 'command -v bun >/dev/null 2>&1 || test -x ~/.bun/bin/bun' 2>/dev/null; then
  ok "Bun present"
else
  runc 'curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1'
  ok "Bun installed"
fi

info "rsync"
if ! runc 'command -v rsync >/dev/null 2>&1' 2>/dev/null; then
  runc 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y rsync >/dev/null 2>&1'
fi
ok "rsync ready"

# ═══════════════════════════════════════════════════════════════════════
# PHASE 3: Code sync
# ═══════════════════════════════════════════════════════════════════════
phase "CODE SYNC"

info "Synchronizace zdrojového kódu"
runc "mkdir -p $REMOTE_DIR/data"

rsync -az --delete \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='*.log' \
  --exclude='data.db*' \
  -e ssh \
  "$PROJECT_ROOT/" "$REMOTE:$REMOTE_DIR/" >/dev/null 2>&1

ok "Kód synchronizován"

# ═══════════════════════════════════════════════════════════════════════
# PHASE 4: Data sync (skip if --code-only)
# ═══════════════════════════════════════════════════════════════════════
if [[ "$CODE_ONLY" == false ]]; then
  phase "DATA SYNC"

for f in data/cz.mbtiles data/cz-terrain.mbtiles data/cycleroutes.geojson data/cz-pois.sqlite; do
    fname=$(basename "$f")
    info "$fname"

    # Check if file exists on remote with matching size
    LOCAL_SIZE=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
    REMOTE_SIZE=$(runc "stat -c%s $REMOTE_DIR/$f 2>/dev/null || echo 0")

    if [[ "$LOCAL_SIZE" == "$REMOTE_SIZE" ]]; then
      ok "$fname už je aktuální ($(( LOCAL_SIZE / 1024 / 1024 ))MB)"
    else
      printf "  přenáším %sMB...\n" "$(( LOCAL_SIZE / 1024 / 1024 ))"
      rsync -az --progress -e ssh "$PROJECT_ROOT/$f" "$REMOTE:$REMOTE_DIR/data/" 2>&1 | tail -1
      ok "$fname přenesen"
    fi
  done
fi

# ═══════════════════════════════════════════════════════════════════════
# PHASE 5: Docker image + volumes (skip if --code-only)
# ═══════════════════════════════════════════════════════════════════════
if [[ "$CODE_ONLY" == false ]]; then
  phase "DOCKER IMAGE + VOLUMES"

  # GH image — must match local graph-cache version!
  info "GraphHopper Docker image"
  GH_IMAGE_ON_REMOTE=$(runc 'docker images -q israelhikingmap/graphhopper:latest 2>/dev/null | head -1')
  if [[ -n "$GH_IMAGE_ON_REMOTE" ]]; then
    ok "GH image už na serveru"
  else
    warn "Přenáším GH image (verze musí sedět s graph-cache)..."
    docker save israelhikingmap/graphhopper:latest | runc 'docker load >/dev/null 2>&1'
    ok "GH image přenesen"
  fi

  # gh-data volume — graph-cache
  info "GraphHopper graph-cache volume"
  GH_VOL="${COMPOSE_PROJECT}_gh-data"
  GH_CACHE_EXISTS=$(runc "docker run --rm -v ${GH_VOL}:/d alpine sh -c 'test -d /d/graph-cache && echo yes || echo no' 2>/dev/null" || echo "no")
  if [[ "$GH_CACHE_EXISTS" == "yes" ]]; then
    ok "graph-cache volume už populovaný"
  else
    warn "Přenáším graph-cache..."
    runc "docker volume create $GH_VOL >/dev/null 2>&1"
    docker run --rm -v vrstevnice_gh-data:/d alpine tar c -C /d . 2>/dev/null \
      | runc "docker run --rm -i -v ${GH_VOL}:/d alpine tar x -C /d 2>/dev/null"
    ok "graph-cache přenesen"
  fi

  # photon-data volume — CZ Photon database
  info "Photon CZ database volume"
  PHOTON_VOL="${COMPOSE_PROJECT}_photon-data"
  PHOTON_DB_EXISTS=$(runc "docker run --rm -v ${PHOTON_VOL}:/d alpine sh -c 'test -f /d/photon_data.lock && echo yes || echo no' 2>/dev/null" || echo "no")
  if [[ "$PHOTON_DB_EXISTS" == "yes" ]]; then
    ok "photon-data volume už populované"
  else
    if [[ "$TRANSFER_PHOTON" == false ]]; then
      echo ""
      read -r -p "  Přenést Photon databázi (~1.7GB)? [y/N] " transfer_choice
      [[ "$transfer_choice" =~ ^[yY]$ ]] && TRANSFER_PHOTON=true
    fi
    if [[ "$TRANSFER_PHOTON" == true ]]; then
      warn "Přenáším Photon CZ databázi..."
      runc "docker volume create $PHOTON_VOL >/dev/null 2>&1"
      docker run --rm -v vrstevnice_photon-data:/d alpine tar c -C /d . 2>/dev/null \
        | runc "docker run --rm -i -v ${PHOTON_VOL}:/d alpine tar x -C /d 2>/dev/null"
      ok "photon-data přeneseno"
    else
      ok "Přeskočeno — Photon DB se přenese při prvním spuštění (trvá ~5 min)"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════
# PHASE 6: Configure
# ═══════════════════════════════════════════════════════════════════════
phase "CONFIGURE"

info "docker-compose.override.yml (low-RAM, bez Photon)"
GH_HEAP_NUM="${GH_HEAP%[mg]}"            # "1500m" → "1500"
GH_XMS="$(( GH_HEAP_NUM / 2 ))m"          # compute locally, not in heredoc
runc "cat > $REMOTE_DIR/docker-compose.override.yml << 'EOFOVERRIDE'
# Auto-generated by deploy.sh — low-RAM override
services:
  graphhopper:
    environment:
      JAVA_OPTS: \"-Xmx${GH_HEAP} -Xms${GH_XMS}\"
EOFOVERRIDE"
ok "override vytvořen (-Xmx${GH_HEAP} -Xms${GH_XMS})"

info "Dummy OSM PBF stub (GH mount fix)"
# Docker compose mountuje data/czech-republic-latest.osm.pbf jako file.
# Pokud neexistuje, Docker vytvoří dir → mount selže. Graph-cache už má všechno.
runc "rm -rf $REMOTE_DIR/data/czech-republic-latest.osm.pbf; touch $REMOTE_DIR/data/czech-republic-latest.osm.pbf"
ok "stub vytvořen"

info "systemd služba pro BE"
runc "cat > /etc/systemd/system/vrstevnice-be.service << 'EOFSERVICE'
[Unit]
Description=Vrstevnice Backend (Bun)
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR
ExecStart=/root/.bun/bin/bun src/be/index.ts
Environment=NODE_ENV=production
Environment=GRAPHHOPPER_URL=http://localhost:8989
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOFSERVICE
systemctl daemon-reload && systemctl enable vrstevnice-be >/dev/null 2>&1"
ok "systemd služba vytvořena"

# ═══════════════════════════════════════════════════════════════════════
# PHASE 7: Build
# ═══════════════════════════════════════════════════════════════════════
phase "BUILD"

info "pnpm install"
runc "export BUN_INSTALL=\$HOME/.bun; export PATH=\$BUN_INSTALL/bin:\$PATH; cd $REMOTE_DIR && pnpm install --frozen-lockfile" >/dev/null 2>&1
ok "Dependencies installed"

info "FE build"
runc "export BUN_INSTALL=\$HOME/.bun; export PATH=\$BUN_INSTALL/bin:\$PATH; cd $REMOTE_DIR && pnpm --filter @vrstevnice/fe build" 2>&1 | grep -E '(built|error)' | head -3
ok "FE postaven"

# ═══════════════════════════════════════════════════════════════════════
# PHASE 8: Launch
# ═══════════════════════════════════════════════════════════════════════
phase "LAUNCH"

info "Docker: GraphHopper + tileserver + photon"
runc "cd $REMOTE_DIR && docker compose -p $COMPOSE_PROJECT up -d graphhopper tileserver photon" 2>&1 | grep -E '(Starting|Started|Error)' | head -6

info "Čekám na GraphHopper health..."
for i in $(seq 1 24); do
  if runc 'curl -sf --max-time 3 http://localhost:8989/health' >/dev/null 2>&1; then
    ok "GraphHopper healthy (${i}x5s)"
    break
  fi
  [[ $i -eq 24 ]] && die "GraphHopper se neozval jako healthy — zkontroluj: ssh $REMOTE 'docker logs vrstevnice-gh --tail 30'"
  sleep 5
done

info "Čekám na Photon health..."
for i in $(seq 1 12); do
  if runc 'curl -sf --max-time 3 http://localhost:2322/status' >/dev/null 2>&1; then
    ok "Photon healthy (${i}x5s)"
    break
  fi
  [[ $i -eq 12 ]] && die "Photon se neozval jako healthy — zkontroluj: ssh $REMOTE 'docker logs vrstevnice-photon --tail 30'"
  sleep 5
done

info "Backend (Bun)"
runc "systemctl restart vrstevnice-be"
sleep 3
runc 'systemctl is-active vrstevnice-be' >/dev/null 2>&1 || die "BE služba nenastartovala — zkontroluj: ssh $REMOTE 'journalctl -u vrstevnice-be -n 20'"
ok "BE aktivní"

# ═══════════════════════════════════════════════════════════════════════
# PHASE 9: Verify
# ═══════════════════════════════════════════════════════════════════════
phase "VERIFIKACE"

FAIL=0

info "FE served"
if runc "curl -sf --max-time 5 http://localhost:$BE_PORT/" >/dev/null 2>&1; then
  ok "FE HTML OK"
else
  warn "FE HTML — ještě se стартuje?"
  FAIL=1
fi

info "API: /api/history"
if runc "curl -sf --max-time 5 http://localhost:$BE_PORT/api/history" >/dev/null 2>&1; then
  ok "/api/history OK"
else
  warn "/api/history selhalo"
  FAIL=1
fi

info "API: /api/geocode (Photon fallback)"
GEOCODE_RESULT=$(runc "curl -sf --max-time 10 'http://localhost:$BE_PORT/api/geocode?q=Praha'" 2>/dev/null | head -c 50)
if [[ -n "$GEOCODE_RESULT" ]]; then
  ok "Geocode OK — $GEOCODE_RESULT..."
else
  warn "Geocode — žádný výsledek (Photon nedostupný?)"
fi

info "API: route výpočet"
ROUTE_RESULT=$(runc "curl -sf --max-time 30 -X POST http://localhost:$BE_PORT/api/route \
  -H 'Content-Type: application/json' \
  -d '{\"stops\":[{\"lat\":50.7671,\"lng\":15.0562,\"name\":\"Liberec\"},{\"lat\":50.7233,\"lng\":15.1697,\"name\":\"Jablonec\"}],\"elevationCoefficient\":0.7,\"roadAvoidanceCoefficient\":1,\"cyclewayCoefficient\":1,\"lemonadeCoefficient\":0}'" 2>/dev/null)
if echo "$ROUTE_RESULT" | grep -q '"geometry"'; then
  ROUTE_KM=$(echo "$ROUTE_RESULT" | python3 -c "import sys,json; print(f'{json.load(sys.stdin)[\"distance\"]:.1f}')" 2>/dev/null || echo "?")
  ok "Route OK — ${ROUTE_KM}km"
else
  warn "Route — ještě se GraphHopper zahřívá?"
  FAIL=1
fi

info "RAM"
USED_MB=$(runc 'awk "/MemTotal/{t=\$2} /MemAvailable/{a=\$2} END{print int((t-a)/1024)}" /proc/meminfo')
AVAIL_MB=$(runc 'awk "/MemAvailable/{print int(\$2/1024)}" /proc/meminfo')
ok "RAM: ${USED_MB}MB použito, ${AVAIL_MB}MB volných"

# ═══════════════════════════════════════════════════════════════════════
# PHASE 10: Summary
# ═══════════════════════════════════════════════════════════════════════
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    DEPLOY DOKONČEN                         ║"
echo "╠══════════════════════════════════════════════════════════════╣"

# Get server IP for display
SERVER_IP="${REMOTE#*@}"
echo "║                                                              ║"
printf "║  \033[1;32mOtevři v prohlížeči:\033[0m  http://%s:%-23s║\n" "$SERVER_IP" "$BE_PORT"
echo "║                                                              ║"
echo "║  \033[1;37mCo funguje:\033[0m                                             ║"
echo "║    • Plánování tras, 3D terén, stíny, vrstevnice             ║"
echo "║    • Profilový graf s barvením povrchu                       ║"
echo "║    • GPX export, ride animation                             ║"
echo "║                                                              ║"
echo "║  \033[1;32m✓ 100%% self-hosted: lokální Photon + SQLite POI\033[0m       ║"
echo "║                                                              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  \033[1;37mÚdržba:\033[0m                                                  ║"
echo "║    Update kódu:  bash scripts/deploy.sh --code-only         ║"
echo "║    BE logy:      ssh $REMOTE 'journalctl -u vrstevnice-be -f'   ║"
echo "║    GH logy:      ssh $REMOTE 'docker logs vrstevnice-gh -f'     ║"
echo "║    Restart BE:   ssh $REMOTE 'systemctl restart vrstevnice-be' ║"
echo "║    Restart GH:   ssh $REMOTE 'cd $REMOTE_DIR && docker compose -p vrstevnice restart graphhopper' ║"
echo "╚══════════════════════════════════════════════════════════════╝"

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  warn "Některé checky selhaly — možná služby ještě startují. Zkus za 30s refresh."
fi

echo ""
