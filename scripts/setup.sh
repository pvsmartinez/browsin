#!/bin/bash
# Instalação completa numa chamada: os dois Chromium, o `browsin` no PATH e as
# skills (skills/*) no diretório do agente.
#
# Nada aqui é irreversível: os browsers vivem num cache, o CLI é um symlink e a
# skill também. Rode de novo depois de um `git pull` — é idempotente, e não muda
# nenhum arquivo versionado (o toolbox do /amp:dev roda isto dentro de um clone
# fixado numa tag).
#
# Uso: scripts/setup.sh [--shell-only] [--force] [--no-browsers] [--no-skill] [--no-link]
#
#   --no-browsers  não baixa os Chromium: eles vivem num cache que toda versão
#                  compartilha, então quem instala várias versões baixa uma vez só
#                  (o comando aparece no fim).
#   BROWSIN_BIN_DIR     onde fica o link do CLI (padrão ~/.local/bin)
#   BROWSIN_SKILL_DIRS  diretórios de skill, separados por `:` (padrão
#                       ~/.claude/skills:~/.codex/skills) — é como os testes
#                       instalam sem tocar no home de verdade.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${BROWSIN_BIN_DIR:-$HOME/.local/bin}"
if [ -n "${BROWSIN_SKILL_DIRS:-}" ]; then
  IFS=: read -r -a SKILL_DIRS <<< "$BROWSIN_SKILL_DIRS"
else
  SKILL_DIRS=("$HOME/.claude/skills" "$HOME/.codex/skills")
fi
LINK=1; SKILL=1; BROWSERS=1; PASS=()

for a in "$@"; do
  case "$a" in
    --no-link)     LINK=0 ;;
    --no-skill)    SKILL=0 ;;
    --no-browsers) BROWSERS=0 ;;
    --shell-only|--force) PASS+=("$a") ;;
    *) echo "flag desconhecida: $a" >&2; exit 2 ;;
  esac
done

node_major=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$node_major" -lt 22 ]; then
  echo "erro: browsin precisa de Node 22+ (achei ${node_major:-nenhum}). brew install node" >&2
  exit 1
fi

if [ "$BROWSERS" -eq 1 ]; then
  echo "==> browsers"
  "$HERE/scripts/install-browsers.sh" ${PASS[@]+"${PASS[@]}"}
fi

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
  for d in ${SKILL_DIRS[@]+"${SKILL_DIRS[@]}"}; do
    [ -n "$d" ] || continue
    [ -d "$(dirname "$d")" ] || continue
    mkdir -p "$d"
    # Toda skill do repo: a `browsin` (a ferramenta) e as que a usam (ui-mocks).
    for s in "$HERE"/skills/*/; do
      s="${s%/}"; n="$(basename "$s")"
      # Uma pasta de verdade (não symlink) com esse nome é de outra pessoa: não apagar.
      if [ -e "$d/$n" ] && [ ! -L "$d/$n" ]; then
        echo "  $d/$n existe e não é um link: deixei como está"
        continue
      fi
      ln -sfn "$s" "$d/$n"
      echo "  $d/$n -> $s"
    done
    found=1
  done
  [ "$found" -eq 1 ] || echo "  nenhum diretório de agente conhecido; copie as pastas de skills/ à mão"
fi

echo
if [ "$BROWSERS" -eq 0 ]; then
  echo "browsers: não instalados aqui (--no-browsers). Uma vez por máquina: bash $HERE/scripts/install-browsers.sh"
fi
echo "pronto:"
echo "  browsin check example.com     # ou: $HERE/bin/browsin check example.com"
echo "  browsin doctor                # qual binário está em jogo"
