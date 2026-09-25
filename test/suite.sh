#!/bin/bash
# Acceptance suite for browsin. Run from anywhere: test/suite.sh
#
# Every case asserts a pattern in the command's own output, so a regression
# shows up as a named failure instead of a silent behaviour change. Every page a
# case needs is in fixtures/ — including the awkward ones (tall page, blob
# download, paginated print), because a suite that reaches outside the repo only
# passes on the machine it was written on.
# Resolve the paths before cd: after it, a relative $0 no longer resolves.
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="$HERE/fixtures"
cd "$HERE/.." || exit 1
# The checkout's own CLI, so the suite tests this tree and not whatever the PATH
# happens to point at.
browsin() { "$HERE/../bin/browsin" "$@"; }
PASS=0; FAIL=0; FAILED=()

# Hermetic: the suite gets its own base directory, so `down`/`down --all`/`gc`
# never touch a live browser another agent may be driving in /tmp/browsin.
# PI_SESSION_ID is cleared so "default" is deterministic; session cases set it
# back per command.
export BROWSIN_DIR="$(mktemp -d /tmp/browsin-suite.XXXXXX)"
unset PI_SESSION_ID BROWSIN_SESSION
trap 'browsin down --all >/dev/null 2>&1; rm -rf "$BROWSIN_DIR"' EXIT

t() { # t <nome> <regex esperado> <comando...>
  local nome="$1" want="$2"; shift 2
  local out; out=$("$@" 2>&1)
  if echo "$out" | grep -qE "$want"; then PASS=$((PASS+1)); printf '  ok   %s\n' "$nome"
  else FAIL=$((FAIL+1)); FAILED+=("$nome"); printf '  FAIL %s\n       esperava /%s/, veio: %s\n' "$nome" "$want" "$(echo "$out" | head -3 | tr '\n' '|')"; fi
}

browsin down >/dev/null 2>&1

echo "— navegação e diagnóstico —"
browsin viewport laptop >/dev/null
t "check acha console/rede/recurso/overflow" 'horizontal overflow' browsin check $SP/basic.html --no-snap
t "logs pega exceção atrasada"               'exception.*boom'      browsin logs
t "network lista tudo"                        'request\(s\)'         browsin network $SP/basic.html
t "reload"                                    'reload'               browsin reload
t "js avalia"                                 'Teste browsin'        browsin js 'document.title'
t "js propaga erro da página"                 'browsin js:'          browsin js 'null.explode'
t "alias eval é js"                           'Teste browsin'        browsin eval 'document.title'

echo "— entender a tela —"
t "snapshot lista controles"      '\[button\]'                browsin snapshot
t "snapshot desambigua"           'input\[type="text"\]|--nth' browsin snapshot
t "dom por CSS"                   '"tag": "div"'               browsin dom '#alvo'
t "dom por texto"                 'Bloco alvo'                 browsin dom 'text=Bloco alvo'
t "dom sem match é claro"         'no match'                   browsin dom '#nada-aqui'

echo "— pixels —"
t "snap viewport 1x"   '1280x800px'  browsin snap --name s1
t "snap dpr 2"         '2560x1600px' browsin snap --dpr 2 --name s2
t "snap clip"          'snap  /tmp'  browsin snap --clip '#alvo' --name s3
t "snap clip + pad"    'snap  /tmp'  browsin snap --clip '#alvo' --pad 20 --name s4
t "snap full"          'snap  /tmp'  browsin snap --full --name s5
t "snap jpeg"          '\.jpg'       browsin snap --jpeg --quality 60 --name s6
t "alias screenshot é snap" 'snap  /tmp' browsin screenshot --name s7
t "snap clip sem match falha" 'no match' browsin snap --clip '#nada'

echo "— gravação —"
RECORD_OUT="$BROWSIN_DIR/demo/flow.gif"
t "record start" 'started.*frame' browsin record start --name flow --fps 8 --max-seconds 30
browsin click '#b' >/dev/null
browsin type '#inp' 'fluxo gravado' >/dev/null
t "record status conta frames" 'active.*3 frame' browsin record status
if command -v ffmpeg >/dev/null 2>&1; then
  # --width ímpar: o pipeline passa por um MP4 intermediário que exige
  # dimensões pares — o stop deve normalizar e gravar 640x400.
  t "record stop gera GIF" 'record  .*flow\.gif' browsin record stop -o "$RECORD_OUT" --width 641 --max-gap 0.2
  if [ -s "$RECORD_OUT" ] && [ -s "$RECORD_OUT.json" ]; then
    PASS=$((PASS+1)); printf '  ok   %s\n' "record grava artefato + sidecar"
  else
    FAIL=$((FAIL+1)); FAILED+=("record grava artefato + sidecar"); printf '  FAIL %s\n' "record grava artefato + sidecar"
  fi
  if grep -q '"width": 640' "$RECORD_OUT.json"; then
    PASS=$((PASS+1)); printf '  ok   %s\n' "record normaliza largura ímpar para par"
  else
    FAIL=$((FAIL+1)); FAILED+=("record normaliza largura ímpar para par"); printf '  FAIL %s\n' "record normaliza largura ímpar para par"
  fi
  if command -v ffprobe >/dev/null 2>&1 && [ "$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$RECORD_OUT")" -gt 1 ]; then
    PASS=$((PASS+1)); printf '  ok   %s\n' "record GIF tem múltiplos frames"
  else
    FAIL=$((FAIL+1)); FAILED+=("record GIF tem múltiplos frames"); printf '  FAIL %s\n' "record GIF tem múltiplos frames"
  fi
else
  t "record stop sem ffmpeg é claro" 'ffmpeg not found' browsin record stop -o "$RECORD_OUT"
  browsin record cancel >/dev/null
fi
t "record terminou" 'not recording' browsin record status
t "record reinicia com nome hostil sanitizado" 'started' browsin record start --name '../../etc/x'
t "record rejeita conflito de formato" 'conflicts' browsin record stop -o "$BROWSIN_DIR/x.gif" --format mp4
t "record rejeita max-gap inválido" 'non-negative' browsin record stop --max-gap abc
t "record cancel" 'canceled' browsin record cancel
t "record cancel limpa estado" 'not recording' browsin record status

echo "— interação —"
t "click"                 'clicado|click '     browsin click '#b'
t "click confirma efeito" 'clicado!'           browsin js "document.getElementById('out').textContent"
t "type"                  'ditado'             browsin type '#inp' 'ditado pelo agente'
t "type --append"         'ditado pelo agente mais' browsin type '#inp' ' mais' --append
t "key Tab"               'key   Tab'          browsin key Tab
t "key com modificador"   'shift'              browsin key ArrowDown --mod shift
t "hover"                 'hover'              browsin hover '#b'
browsin open $SP/tall.html >/dev/null
t "scroll y (página alta)" "scrl  y=200" browsin scroll 200
browsin open $SP/basic.html >/dev/null
t "scroll bottom"         'scrl  y='           browsin scroll bottom
t "scroll top"            'scrl  y=0'          browsin scroll top
t "scroll por seletor"    'scrl  y='           browsin scroll '#alvo'

echo "— casos difíceis —"
browsin open $SP/hard.html >/dev/null
t "dialog auto-aceito"      'auto-accepted confirm' browsin click '#confirma'
t "select por label"        'Rio de Janeiro'        browsin select '#uf' 'Rio de Janeiro'
t "select opção inexistente" 'no option matches'    browsin select '#uf' 'Acre'
t "select em não-select"     'not a <select>'       browsin select '#cv' 'x'
t "upload"                   '2 file\(s\)'          browsin upload '#arq' $SP/basic.html $SP/hard.html
t "upload arquivo faltando"  'no such file'         browsin upload '#arq' /nao/existe.txt
t "drag em canvas"           'in 20 steps'          browsin drag '#cv' --by 100,50 --steps 20
t "canvas registrou traço"   'traço com'            browsin js "document.getElementById('cvout').textContent"
t "drag HTML5 entre alvos"   'drag '                browsin drag '#handle' '#drop'
t "shadow DOM: dom"          '"tag": "button"'      browsin dom '#shadowbtn'
t "shadow DOM: click"        'click #shadowbtn'     browsin click '#shadowbtn'
t "iframe: dom"              'Botão no iframe'      browsin dom '#inner'
t "iframe: click"            'click #inner'         browsin click '#inner'

echo "— PDF e download —"
t "pdf a4"          'A4'                     browsin pdf $SP/hard.html --name p-a4
t "pdf a3 paisagem" 'A3 landscape'           browsin pdf --format a3 --landscape --name p-a3
t "pdf formato inválido" 'unknown --format'   browsin pdf --format a9
browsin open $SP/download.html >/dev/null
browsin click 'text=Exemplo' --wait 'document.querySelectorAll("svg rect").length > 3' >/dev/null
t "download .bpmn"  'completed'              browsin download 'text=Baixar .bpmn'
t "download sem alvo de download" 'no download|never completed' browsin download 'text=Limpar'

echo "— gestão —"
t "viewport preset iphone" '390x844 @2x mobile' browsin viewport iphone
t "viewport explícito"     '820x1180'           browsin viewport 820x1180 --dpr 2
t "viewport inválido"      'usage'              browsin viewport 99banana
t "status"                 'headless shell'     browsin status
t "comando desconhecido"   'unknown command'    browsin banana
t "desconhecido sugere próximo" 'did you mean.*snap' browsin snsp
t "desconhecido aponta --help"  'browsin --help'     browsin banana
t "url no lugar de comando" 'looks like a URL'   browsin localhost:59999
t "arquivo no lugar de comando" 'looks like a' browsin package.json
t "--help lista comandos"    'as actionable selectors' browsin --help
t "-h é help"                'as actionable selectors' browsin -h
t "help é help"              'as actionable selectors' browsin help
t "--version imprime versão" 'browsin [0-9]+(\.[0-9]+)+' browsin --version
t "-v imprime versão"        'browsin [0-9]+(\.[0-9]+)+' browsin -v
t "arquivo inexistente"    'no such file'       browsin open ./nao/existe.html
t "url morta"              'ERR_'               browsin open http://127.0.0.1:59998
browsin record start --name down-cancels >/dev/null
t "down cancela gravação"   'active recording canceled' browsin down
t "gravação caiu com down"  'not recording'       browsin record status
t "status com browser off"  'no browser running' browsin status

echo "— sessões e concorrência —"
sess() { local s="$1"; shift; BROWSIN_SESSION="$s" browsin "$@"; }
# Auto-namespacing por PI_SESSION_ID só vale sem BROWSIN_DIR explícito (quem passa
# o dir é dono do namespace) — por isso o status roda no BASE real, sem lançar nada.
pi_sess() { local i="$1"; shift; BROWSIN_DIR= PI_SESSION_ID="$i" browsin "$@"; }

t "sessão A sobe isolada"         'open '              sess suite-a open $SP/basic.html
t "sessão B não vê a A"           'no browser running' sess suite-b status
sess suite-b open $SP/tall.html >/dev/null 2>&1
t "A continua viva com B viva"    'on port'            sess suite-a status
t "aba da A é a da A"             'Teste browsin'      sess suite-a js 'document.title'
t "aba da B é a da B"             'Página alta'        sess suite-b js 'document.title'
t "status lista as outras vivas"  'também vivas'       sess suite-a status
t "PI_SESSION_ID vira sessão"     'sess  pi-auto-42'   pi_sess pi-auto-42 status
t "TERM_SESSION_ID vira sessão"   'sess  term-tab-77'  env -u PI_SESSION_ID TERM_SESSION_ID=term-tab-77 BROWSIN_DIR= browsin status

PA=$(sess suite-a status | grep -oE 'port [0-9]+')
PB=$(sess suite-b status | grep -oE 'port [0-9]+')
if [ -n "$PA" ] && [ "$PA" != "$PB" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "portas distintas ($PA vs $PB)"
else FAIL=$((FAIL+1)); FAILED+=("portas distintas por sessão"); printf '  FAIL portas distintas: %s vs %s\n' "$PA" "$PB"; fi

sess suite-a down >/dev/null 2>&1
t "down da A não derruba a B"     'up '               sess suite-b status

echo "— gc —"
mkdir -p "$BROWSIN_DIR/suite-morta"
echo '{"pid": 999999, "port": 9390, "lastUsed": 1}' > "$BROWSIN_DIR/suite-morta/state.json"
t "gc apaga sessão de browser morto" 'suite-morta'    browsin gc

sleep 300 & FPID=$!
mkdir -p "$BROWSIN_DIR/suite-velha"
echo "{\"pid\": $FPID, \"port\": 9391, \"lastUsed\": 1}" > "$BROWSIN_DIR/suite-velha/state.json"
t "gc ceifa sessão idle"          'suite-velha'       browsin gc
if kill -0 "$FPID" 2>/dev/null; then
  FAIL=$((FAIL+1)); FAILED+=("gc mata o processo da sessão idle"); printf '  FAIL %s\n' "gc mata o processo da sessão idle"
else PASS=$((PASS+1)); printf '  ok   %s\n' "gc mata o processo da sessão idle"; fi
t "gc preserva sessão viva"       'suite-b'           browsin gc

# O caso que a AGENTS.md chama de headless shell imortal: o state.json some
# mas o browser segue de pé, sem pid que o reconheça.
sess suite-orf open $SP/basic.html >/dev/null 2>&1
ORFPID=$(sess suite-orf status | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+')
rm -f "$BROWSIN_DIR/suite-orf/state.json"
t "gc mata órfão sem state.json"  'kill órfão'        browsin gc
if [ -n "$ORFPID" ] && kill -0 "$ORFPID" 2>/dev/null; then
  FAIL=$((FAIL+1)); FAILED+=("gc mata o browser órfão"); printf '  FAIL %s\n' "gc mata o browser órfão"
else PASS=$((PASS+1)); printf '  ok   %s\n' "gc mata o browser órfão"; fi

# O outro lado da história do state sumido: sem sweep due, o browser órfão é
# adotado de volta — e a aba sobrevive.
sess suite-adopt open $SP/basic.html >/dev/null 2>&1
APID=$(sess suite-adopt status | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+')
rm -f "$BROWSIN_DIR/suite-adopt/state.json"
touch "$BROWSIN_DIR/.gc-stamp"
t "state sumido, pid recuperado"  "pid $APID"         sess suite-adopt status
t "adoção mantém a aba"           'Teste browsin'      sess suite-adopt js 'document.title'

sess suite-ttl open $SP/basic.html >/dev/null 2>&1
ttl_gc() { BROWSIN_TTL_MIN=0 browsin gc; }
t "TTL configurável ceifa sessão ociosa" 'suite-ttl' ttl_gc

# `down` apaga o state.json: sem a idade caindo para o mtime do diretório, esse
# profile ficaria invisível ao coletor para sempre.
sess suite-parada open $SP/basic.html >/dev/null 2>&1
sess suite-parada down >/dev/null 2>&1
t "gc ceifa sessão parada (sem state.json)" 'suite-parada' ttl_gc
if [ ! -d "$BROWSIN_DIR/suite-parada" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "diretório da sessão parada removido"
else FAIL=$((FAIL+1)); FAILED+=("diretório da sessão parada removido"); printf '  FAIL %s\n' "diretório da sessão parada removido"; fi

# A sessão "default" é o layout plano dentro do BASE (é o que um chamador com
# BROWSIN_DIR próprio sempre teve). Ela envelhece como qualquer outra — mas quem
# a coleta é outra sessão, já que `own` nunca é tocada.
mkdir -p "$BROWSIN_DIR/profile"; touch "$BROWSIN_DIR/profile/Cookies"
echo '{"pid": 999999, "lastUsed": 1}' > "$BROWSIN_DIR/state.json"
reap_default() { BROWSIN_SESSION=suite-de-fora BROWSIN_TTL_MIN=0 browsin gc; }
t "gc coleta a sessão default parada" 'default' reap_default
if [ ! -d "$BROWSIN_DIR/profile" ] && [ ! -f "$BROWSIN_DIR/state.json" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "layout default coletado"
else FAIL=$((FAIL+1)); FAILED+=("layout default coletado"); printf '  FAIL %s\n' "layout default coletado"; fi

sess suite-a open $SP/basic.html >/dev/null 2>&1
gc_cap() { BROWSIN_MAX_SESSIONS=1 browsin gc; }
t "cap de sessões ceifa a mais antiga" 'acima do cap' gc_cap

echo "— down --all —"
sess suite-a open $SP/basic.html >/dev/null 2>&1
t "down --all derruba todas"      'all sessions'      browsin down --all
t "B caiu com --all"             'no browser running' sess suite-b status
t "A caiu com --all"             'no browser running' sess suite-a status

echo
echo "RESULTADO: $PASS ok, $FAIL falhas"
[ $FAIL -gt 0 ] && printf 'falharam: %s\n' "${FAILED[*]}"
exit $FAIL
