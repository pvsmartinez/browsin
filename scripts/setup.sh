#!/bin/bash
# Instalação completa numa chamada: os dois Chromium, o `browsin` no PATH e a
# skill no diretório do agente.
#
# Nada aqui é irreversível: os browsers vivem num cache, o CLI é um symlink e a
# skill também. Rode de novo depois de um `git pull` — é idempotente.
#
# Uso: scripts/setup.sh [--shell-only] [--force] [--no-skill] [--no-link]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${BROWSIN_BIN_DIR:-$HOME/.local/bin}"
SKILL_DIRS=("$HOME/.claude/skills" "$HOME/.codex/skills")
LINK=1; SKILL=1; PASS=()

for a in "$@"; do
  case "$a" in
    --no-link)  LINK=0 ;;
    --no-skill) SKILL=0 ;;
    --shell-only|--force) PASS+=("$a") ;;
    *) echo "flag desconhecida: $a" >&2; exit 2 ;;
  esac
done

node_major=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$node_major" -lt 22 ]; then
  echo "erro: browsin precisa de Node 22+ (achei ${node_major:-nenhum}). brew install node" >&2
  exit 1
fi

echo "==> browsers"
"$HERE/scripts/install-browsers.sh" ${PASS[@]+"${PASS[@]}"}

if [ "$LINK" -eq 1 ]; then
  echo "==> CLI"
  mkdir -p "$BIN_DIR"
  ln -sfn "$HERE/bin/browsin" "$BIN_DIR/browsin"
  echo "  $BIN_DIR/browsin -> $HERE/bin/browsin"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "  ATENÇÃO: $BIN_DIR não está no PATH. Acrescente no seu shell rc:"
       echo "           export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
fi

# A ferramenta sem a skill existe e ninguém chama: o agente não sabe que ela está
# lá, nem que texto vem antes de pixel. O symlink mantém as duas em dia juntas.
if [ "$SKILL" -eq 1 ]; then
  echo "==> skill"
  found=0
  for d in "${SKILL_DIRS[@]}"; do
    [ -d "$(dirname "$d")" ] || continue
    mkdir -p "$d"
    ln -sfn "$HERE/skills/browsin" "$d/browsin"
    echo "  $d/browsin -> $HERE/skills/browsin"
    found=1
  done
  [ "$found" -eq 1 ] || echo "  nenhum diretório de agente conhecido; copie skills/browsin/ à mão"
fi

echo
echo "pronto:"
echo "  browsin check example.com     # ou: $HERE/bin/browsin check example.com"
echo "  browsin doctor                # qual binário está em jogo"
