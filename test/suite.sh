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
# back per command. The janitor stays off too: a background gc between suite
# steps would race the cases that prepare orphan/idle sessions by hand (the
# dedicated janitor section below re-enables it per case).
export BROWSIN_DIR="$(mktemp -d /tmp/browsin-suite.XXXXXX)"
export BROWSIN_JANITOR=off
unset PI_SESSION_ID CLAUDE_CODE_SESSION_ID BROWSIN_SESSION
trap 'browsin down --all >/dev/null 2>&1; rm -rf "$BROWSIN_DIR"' EXIT

tx() { # tx <nome> <exit esperado> <regex esperado> <comando...> — quando o código de saída é contrato
  local nome="$1" wantc="$2" want="$3"; shift 3
  local out code; out=$("$@" 2>&1); code=$?
  if [ "$code" = "$wantc" ] && echo "$out" | grep -qE "$want"; then PASS=$((PASS+1)); printf '  ok   %s\n' "$nome"
  else FAIL=$((FAIL+1)); FAILED+=("$nome"); printf '  FAIL %s\n       esperava exit %s e /%s/, veio exit %s: %s\n' "$nome" "$wantc" "$want" "$code" "$(echo "$out" | head -3 | tr '\n' '|')"; fi
}

tnot() { # tnot <nome> <regex proibido> <comando...>
  local nome="$1" bad="$2"; shift 2
  local out; out=$("$@" 2>&1)
  if ! echo "$out" | grep -qE "$bad"; then PASS=$((PASS+1)); printf '  ok   %s\n' "$nome"
  else FAIL=$((FAIL+1)); FAILED+=("$nome"); printf '  FAIL %s\n       não devia ter /%s/: %s\n' "$nome" "$bad" "$(echo "$out" | grep -E "$bad" | head -2 | tr '\n' '|')"; fi
}

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
# Exceção que chega depois do comando que a armou: `logs` (o buffer da página)
# a pega. O hover arma o timer e não lê log; a suíte espera a condição (o timer
# disparou), não um tempo fixo. Antes o timer era o da própria página (50 ms) e,
# com a máquina carregada, o check acima terminava depois dele e levava a exceção.
browsin js "document.getElementById('b').onmouseover = () => setTimeout(() => { document.body.dataset.late = '1'; null.lateboom }, 100); 1" >/dev/null
browsin hover '#b' >/dev/null
for _ in $(seq 1 100); do browsin dom 'body[data-late]' >/dev/null 2>&1 && break; sleep 0.1; done
t "logs pega exceção atrasada"               'exception.*lateboom'  browsin logs
t "network lista tudo"                        'request\(s\)'         browsin network $SP/basic.html
t "reload"                                    'reload'               browsin reload
t "js avalia"                                 'Teste browsin'        browsin js 'document.title'
t "js propaga erro da página"                 'browsin js:'          browsin js 'null.explode'
t "alias eval é js"                           'Teste browsin'        browsin eval 'document.title'

# SPA que só pinta depois do load: a espera de mount padrão pega; --no-wait não.
echo "— espera de mount (SPA) —"
t "open espera o mount por padrão" 'title Montou'      browsin open $SP/slowmount.html
# Monta em 10 s, não nos 500 ms de cima: provar que o --no-wait não espera não
# pode depender de o open terminar antes de um timer curto.
t "open --no-wait não espera"      'title Aguardando'  browsin open "$SP/slowmount.html?ms=10000" --no-wait
browsin open $SP/basic.html >/dev/null

# Âncora (#) só: navegação no mesmo documento não tem load event; esperar por
# ele custava o --timeout inteiro e uma nota falsa.
t "check só de âncora não espera load" '^check .*#secao' browsin check "$SP/basic.html#secao" --no-snap --timeout 4000
tnot "check só de âncora sem nota falsa" 'load event never fired' browsin check "$SP/basic.html#outra" --no-snap --timeout 4000

# QA gate (check --fail-on): servidor HTTP de verdade, porque status 4xx/5xx,
# API lenta que falha depois do mount, abort e request sem fim não existem em
# file://. Cada página monta como SPA (#root vazio até um timer).
echo "— QA gate (check --fail-on / --json) —"
GATE_PORT_FILE="$BROWSIN_DIR/gate-port"
node "$SP/gate-server.mjs" > "$GATE_PORT_FILE" 2>/dev/null &
GATE_PID=$!
trap 'kill $GATE_PID 2>/dev/null; browsin down --all >/dev/null 2>&1; rm -rf "$BROWSIN_DIR"' EXIT
for _ in $(seq 1 50); do [ -s "$GATE_PORT_FILE" ] && break; sleep 0.1; done
G="http://127.0.0.1:$(head -1 "$GATE_PORT_FILE")"
MOUNT='document.querySelector("#root")?.children.length > 0'
tx "gate: página limpa sai 0"             0 '^gate  ok$'                 browsin check "$G/clean" --wait "$MOUNT" --fail-on errors --no-snap
tx "gate: json limpo"                     0 '^  "ok": true'              browsin check "$G/clean" --wait "$MOUNT" --fail-on errors --json --no-snap
tx "gate: 500 tardio da API sai 2"        2 'gate  FAIL.*1 exception.*1 console error.*1 failed request' browsin check "$G/late" --wait "$MOUNT" --fail-on errors --no-snap
tx "gate: json traz URL e status"         2 '"status": 500'              browsin check "$G/late" --wait "$MOUNT" --fail-on errors --json --no-snap
tx "gate: json traz exceção tardia"       2 'late boom'                  browsin check "$G/late" --wait "$MOUNT" --fail-on errors --json --no-snap
tx "gate: só a categoria pedida conta"    0 '^gate  ok$'                 browsin check "$G/late" --wait "$MOUNT" --fail-on wait --no-snap
tx "gate: --settle 0 não espera a API"    0 '^gate  ok$'                 browsin check "$G/late" --wait "$MOUNT" --fail-on errors --settle 0 --no-snap
tx "gate: 404 de recurso falha"           2 '\[404\] Image .*/noise\.png' browsin check "$G/noise" --wait "$MOUNT" --fail-on errors --no-snap
tx "gate: --ignore tira o ruído"          0 'gate  ok \(1 ignored\)'     browsin check "$G/noise" --wait "$MOUNT" --fail-on errors --ignore 'noise\.png$' --no-snap
tx "gate: --ignore repete"                0 '"failedRequests": 1'        browsin check "$G/noise" --wait "$MOUNT" --fail-on errors --ignore 'nada' --ignore 'noise\.png$' --json --no-snap
tx "gate: erro antes de redirect conta"   2 'FAIL — 1 exception · 1 console error' browsin check "$G/redirect" --wait "$MOUNT" --fail-on errors --no-snap
tx "gate: rejection tratada depois não conta" 0 '^gate  ok$'             browsin check "$G/handled" --wait "$MOUNT" --fail-on errors --no-snap
# Runtime.enable devolve o histórico do console da página que o comando anterior deixou.
browsin open "$G/clean" >/dev/null 2>&1; browsin js 'console.error("historico velho"); 1' >/dev/null 2>&1
tx "gate: histórico da página anterior não conta" 0 '^gate  ok$'         browsin check "$G/clean" --wait "$MOUNT" --fail-on errors --no-snap
tx "gate: 404 abortado depois dos headers conta" 2 '\[404\] Fetch .*/api/slowbody404' browsin check "$G/abort404" --wait "$MOUNT" --fail-on network --no-snap
browsin open "$G/noisy" >/dev/null 2>&1
tx "gate: erro da rota anterior não vaza"  0 '^gate  ok$'                browsin check "$G/slowdoc" --wait "$MOUNT" --fail-on errors --no-snap
browsin open "$G/iframeloop" >/dev/null 2>&1
tx "gate: iframe 404 da rota anterior não vaza" 0 '^gate  ok$'          browsin check "$G/slowdoc" --wait "$MOUNT" --fail-on errors --no-snap
tx "gate: fetch abortado não é falha"     0 '^gate  ok$'                 browsin check "$G/abort" --wait "$MOUNT" --fail-on errors --no-snap
tx "gate: falha de rede traz a URL"       2 '\[net::ERR_[A-Z_]+\] Fetch http://127\.0\.0\.1:1/recusado' browsin check "$G/netfail" --wait "$MOUNT" --fail-on network --no-snap
tx "gate: documento 500 falha"            2 '\[500\] Document'           browsin check "$G/doc500" --fail-on network --no-snap
tx "gate: --wait nunca verdadeiro sai 2"  2 'FAIL — --wait never true'   browsin check "$G/nomount" --wait "$MOUNT" --fail-on errors --timeout 1000 --no-snap
tx "gate: request sem fim é pending, não falha" 0 '"pending": \[$'       browsin check "$G/stream" --wait "$MOUNT" --fail-on errors --settle 200 --timeout 1500 --json --no-snap
# CORS: um POST JSON credenciado a outra origem leva um preflight (OPTIONS) com
# requestId próprio. Se a página aborta o POST no meio do preflight (StrictMode
# no dev), o Chromium não diz mais nada do preflight: ele segurava o settle até
# o --timeout. Preflight que nunca é respondido segue pending.
tx "gate: POST cross-origin com preflight sem pending" 0 '"pending": \[\],' browsin check "$G/cors" --wait "$MOUNT" --fail-on errors --settle 200 --timeout 5000 --json --no-snap
tx "gate: preflight de POST abortado não fica pending" 0 '"pending": \[\],' browsin check "$G/corsabort" --wait "$MOUNT" --fail-on errors --settle 200 --timeout 5000 --json --no-snap
tx "gate: preflight de POST abortado não segura o settle" 0 '"settleMs": ([0-9]{1,3}|[0-4][0-9]{3})$' browsin check "$G/corsabort" --wait "$MOUNT" --fail-on errors --settle 200 --timeout 5000 --json --no-snap
tx "gate: preflight sem resposta segue pending" 0 '"method": "OPTIONS"' browsin check "$G/corshang" --wait "$MOUNT" --fail-on errors --settle 200 --timeout 1500 --json --no-snap
tx "gate: página inalcançável sai 2 com json" 2 '"error": "net::ERR_'    browsin check http://127.0.0.1:1/ --fail-on errors --json
tx "gate: categoria inválida sai 1 com json" 1 '"fatal":true'            browsin check "$G/clean" --fail-on bogus --json
tx "gate: regex inválida sai 1"           1 'invalid regex'              browsin check "$G/clean" --fail-on errors --ignore '(' --no-snap
tx "gate: json traz o screenshot"         0 '"shot": ".*/gate-clean\.png"' browsin check "$G/clean" --wait "$MOUNT" --fail-on errors --json --name gate-clean
tx "gate: --name com barra vira nome de arquivo" 0 '"shot": ".*/experiments-detail\.png"' browsin check "$G/clean" --wait "$MOUNT" --fail-on errors --json --name experiments/detail
tx "gate: --ignore não espera o stream"   0 '"settleMs": ([0-9]{1,3}|[0-4][0-9]{3})$'     browsin check "$G/stream" --wait "$MOUNT" --fail-on errors --settle 200 --timeout 5000 --ignore '/api/stream$' --json --no-snap
t  "open --wait falso avisa"              'never became true'           browsin open "$G/nomount" --wait 'false' --timeout 300
tx "check sem --fail-on segue saindo 0"   0 'logs  [0-9]+ problem'       browsin check "$SP/basic.html" --no-snap
tx "check --json sem --fail-on sai 0"     0 '^  "ok": false'             browsin check "$SP/basic.html" --json --no-snap
# open, reload e as ações leem erro e exceção pelo protocolo, como o check: o
# buffer na página morre com o documento, e o que a página logava antes de se
# substituir sumia ("logs  clean" na página final).
BOUNCE_OUT=$(browsin open "$G/bounce" --wait "$MOUNT" 2>&1)
t "open: erro antes do redirect aparece"     '^  \[error\] erro antes do bounce$'                 echo "$BOUNCE_OUT"
t "open: exceção antes do redirect aparece"  '^  \[exception\] Uncaught Error: boom antes do bounce' echo "$BOUNCE_OUT"
t "open: sem duplicata (protocolo + buffer)" '^logs  2 problem\(s\):$'                          echo "$BOUNCE_OUT"
BOUNCE_OUT=$(browsin reload --wait "$MOUNT" 2>&1)
t "reload: erro antes do redirect aparece"   '^  \[error\] erro antes do bounce$'                 echo "$BOUNCE_OUT"
t "reload: exceção antes do redirect aparece" '^  \[exception\] Uncaught Error: boom antes do bounce' echo "$BOUNCE_OUT"
t "reload: sem duplicata"                    '^logs  2 problem\(s\):$'                          echo "$BOUNCE_OUT"
browsin open "$G/clicklog" >/dev/null 2>&1
t "click que navega traz o erro da página que deixou" '\[error\] erro no clique' browsin click '#go' --wait 'location.pathname === "/clean"'
# Erro logado entre comandos (o hover não lê log) sobrevive a um comando que
# falha antes de ler o buffer, e sai uma vez na ação seguinte, junto com o dela.
browsin open "$G/clicklog" >/dev/null 2>&1
browsin hover '#hov' >/dev/null 2>&1
browsin click '#nada' >/dev/null 2>&1
CLICK_OUT=$(browsin click '#err' 2>&1)
t "ação: erro da própria ação sai uma vez" '^1$' echo "$(echo "$CLICK_OUT" | grep -c 'erro do botão')"
t "ação: erro entre comandos sobrevive a comando que falhou, uma vez" '^1$' echo "$(echo "$CLICK_OUT" | grep -c 'erro entre comandos')"
# Erro emitido no meio da marca de início (/marked loga de dentro do mark()):
# protocolo e buffer têm a mesma fronteira, então sai uma vez. Navegação: só o
# do documento novo (#1, a marca do fim); o do anterior fica antes da janela.
marks() { echo "$1" | grep '\[error\] marca' | sed 's/.*marca //' | tr '\n' ' '; }
browsin open "$G/marked" >/dev/null 2>&1
t "open: erro na fronteira sai uma vez, só o da página nova" '^#1 $' marks "$(browsin open "$G/marked" 2>&1)"
t "reload: erro na fronteira sai uma vez, só o da página nova" '^#1 $' marks "$(browsin reload 2>&1)"
t "ação: erro emitido durante a marca sai uma vez" '^#2 #3 $' marks "$(browsin click '#parado' 2>&1)"
# Os blocos seguintes leem a página de teste básica.
browsin open "$SP/basic.html" >/dev/null 2>&1
# O servidor sai aqui: um `wait` sem pid mais adiante esperaria por ele para sempre.
kill $GATE_PID 2>/dev/null; wait $GATE_PID 2>/dev/null

echo "— entender a tela —"
t "snapshot lista controles"      '\[button\]'                browsin snapshot
t "snapshot desambigua"           'input\[type="text"\]|--nth' browsin snapshot
t "dom por CSS"                   '"tag": "div"'               browsin dom '#alvo'
t "dom por texto"                 'Bloco alvo'                 browsin dom 'text=Bloco alvo'
t "dom sem match é claro"         'no match'                   browsin dom '#nada-aqui'

echo "— texto (text) —"
t "text extrai body"            'Bloco alvo pro --clip' browsin text
t "text seletor"                'Clicar'                browsin text '#b'
t "text --nth"                  'Clicar'                browsin text '.card' --nth 1
t "text --limit trunca"         'more chars'            browsin text --limit 30
t "text sem match"              'no match for'          browsin text '#nada'
t "text sem match ensina text=" "hint.*text="           browsin text '#nada'
t "alias txt"                   'Clicar'                browsin txt '#b'

# Resistência a argumentos colados: o agente cola a linha inteira do snapshot.
echo "— resistência de argumentos —"
t "--nth colado no seletor"     'click \.card'          browsin click '.card --nth 1'
t "js não serializável não falha" 'não serializável'     browsin js 'window'

echo "— pixels —"
t "snap viewport 1x"   '1280x800px'  browsin snap --name s1
t "snap dpr 2"         '2560x1600px' browsin snap --dpr 2 --name s2
t "snap clip"          'snap  /tmp'  browsin snap --clip '#alvo' --name s3
t "snap clip + pad"    'snap  /tmp'  browsin snap --clip '#alvo' --pad 20 --name s4
t "snap full"          'snap  /tmp'  browsin snap --full --name s5
t "snap jpeg"          '\.jpg'       browsin snap --jpeg --quality 60 --name s6
t "alias screenshot é snap" 'snap  /tmp' browsin screenshot --name s7
t "snap clip sem match falha" 'no match' browsin snap --clip '#nada'

# Um snap do viewport não pode reflowmar a página: sem captureBeyondViewport,
# não há resize (o --full/--clip continua usando, para renderizar o que está
# fora da tela).
browsin viewport laptop >/dev/null
browsin open $SP/resize.html >/dev/null
browsin js 'window.__ev=[]' >/dev/null
t "snap viewport não dispara resize" '^\[\]$' browsin js 'JSON.stringify(window.__ev)'
browsin open $SP/basic.html >/dev/null

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
t "click sem match ensina text="   'hint.*text='  browsin click '#nada'
t "click multi-match aponta --nth" 'hint.*--nth'  browsin click 'div' --nth 50
t "type"                  'ditado'             browsin type '#inp' 'ditado pelo agente'
t "type sem match ensina text="    'hint.*text='  browsin type '#nada' 'x'
t "type --append"         'ditado pelo agente mais' browsin type '#inp' ' mais' --append
t "key Tab"               'key   Tab'          browsin key Tab
t "key com modificador"   'shift'              browsin key ArrowDown --mod shift
# --wait que nunca fica verdadeiro depois de uma ação tem que aparecer: o
# silêncio era lido como "o fluxo funcionou".
t "click --wait falso avisa"  'never became true'  browsin click '#b' --wait 'false' --timeout 300
t "key --wait falso avisa"    'never became true'  browsin key Tab --wait 'false' --timeout 300
t "reload --wait falso avisa" 'never became true'  browsin reload --wait 'false' --timeout 300
tnot "click --wait verdadeiro não avisa" 'never became true' browsin click '#b' --wait 'true'
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
t "text atravessa shadow DOM" 'Botão sombra'        browsin text '#shadowbtn'
t "text no iframe"           'iframe ok'            browsin text '#ip'
# multi-match com --nth já coberto no bloco de texto ('.card' --nth 1); as rows
deste fixture mutam nos testes de drag/select acima, então aqui seria frágil.

echo "— PDF e download —"
t "pdf a4"          'A4'                     browsin pdf $SP/hard.html --name p-a4
t "pdf a3 paisagem" 'A3 landscape'           browsin pdf --format a3 --landscape --name p-a3
t "pdf formato inválido" 'unknown --format'   browsin pdf --format a9
browsin open $SP/download.html >/dev/null
browsin click 'text=Exemplo' --wait 'document.querySelectorAll("svg rect").length > 3' >/dev/null
t "download .bpmn"  'completed'              browsin download 'text=Baixar .bpmn'
t "download sem alvo de download" 'no download|never completed' browsin download 'text=Limpar'

echo "— login --note (intersticial pura, sem janela) —"
login_html() { node --input-type=module -e "
  import { buildLoginNoteHtml } from '$HERE/../src/login-note.mjs';
  process.stdout.write(buildLoginNoteHtml(process.argv[1], process.argv[2] === '' ? null : process.argv[2]));
" "$1" "$2"; }
NOTE_HTML="$(login_html 'Preciso que você autentique no painel de faturas' 'https://app.exemplo.com/login')"
if echo "$NOTE_HTML" | grep -q 'painel de faturas' && echo "$NOTE_HTML" | grep -q 'href="https://app.exemplo.com/login"' && echo "$NOTE_HTML" | grep -q 'browsin login'; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "login note: contém a note e o href do destino"
else
  FAIL=$((FAIL+1)); FAILED+=("login note: contém a note e o href do destino"); printf '  FAIL %s\n' "login note"
fi
GUIDE="$(node --input-type=module -e "
  import { loginGuideLines } from '$HERE/../src/login-note.mjs';
  console.log(loginGuideLines({ ttlMin: 60, maxSessions: 8 }).join(' '));")"
if echo "$GUIDE" | grep -q 'down --fresh' && echo "$GUIDE" | grep -q 'TTL (60 min)' && echo "$GUIDE" | grep -q 'more than 8 sessions are alive (BROWSIN_MAX_SESSIONS)' && echo "$GUIDE" | grep -q 'profile deleted, the login with it'; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "login diz as 3 formas de perder o login (fresh, TTL, teto de sessões)"
else
  FAIL=$((FAIL+1)); FAILED+=("login diz as 3 formas de perder o login (fresh, TTL, teto de sessões)"); printf '  FAIL %s\n' "login diz as 3 formas de perder o login"
fi
NOTE_HTML2="$(login_html 'só explicar' '')"
if echo "$NOTE_HTML2" | grep -q 'Close this window when done' && ! echo "$NOTE_HTML2" | grep -q 'href='; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "login note sem url: pede pra fechar a janela"
else
  FAIL=$((FAIL+1)); FAILED+=("login note sem url: pede pra fechar a janela"); printf '  FAIL %s\n' "login note sem url"
fi
if echo "$(login_html '<script>alert(1)</script>' 'https://a.com/?q=<x>')" | grep -q '&lt;script&gt;'; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "login note escapa html da note"
else
  FAIL=$((FAIL+1)); FAILED+=("login note escapa html da note"); printf '  FAIL %s\n' "login note escapa"
fi

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
t "CLAUDE_CODE_SESSION_ID vence a aba" 'sess  cc-conv-9' env -u PI_SESSION_ID CLAUDE_CODE_SESSION_ID=cc-conv-9 TERM_SESSION_ID=term-tab-77 BROWSIN_DIR= browsin status
# Sem mock keychain o chromium headed cifra o cookie com a chave do Keychain e o
# headless shell não decifra: o login some no relançamento headless.
APID=$(sess suite-a status | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+')
t "browser sobe com --use-mock-keychain" 'use-mock-keychain' ps -p "$APID" -o args=

# Depois do `login` (estado headed), um comando comum relança headless no mesmo
# perfil — a janela visível não é dirigida por baixo.
sess suite-headed open $SP/basic.html >/dev/null 2>&1
HPID=$(sess suite-headed status | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+')
node -e "const fs=require('fs');const f='$BROWSIN_DIR/suite-headed/state.json';const d=JSON.parse(fs.readFileSync(f));d.headed=true;fs.writeFileSync(f,JSON.stringify(d,null,2))"
sess suite-headed js '1' >/dev/null 2>&1
NPID=$(sess suite-headed status | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+')
if [ -n "$HPID" ] && [ "$HPID" != "$NPID" ] && sess suite-headed status | grep -q 'headless shell'; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "login fecha a janela e sobe headless"
else
  FAIL=$((FAIL+1)); FAILED+=("login fecha a janela e sobe headless"); printf '  FAIL %s\n' "login fecha a janela e sobe headless (pid $HPID -> $NPID)"
fi
sess suite-headed down >/dev/null 2>&1

PA=$(sess suite-a status | grep -oE 'port [0-9]+')
PB=$(sess suite-b status | grep -oE 'port [0-9]+')
if [ -n "$PA" ] && [ "$PA" != "$PB" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "portas distintas ($PA vs $PB)"
else FAIL=$((FAIL+1)); FAILED+=("portas distintas por sessão"); printf '  FAIL portas distintas: %s vs %s\n' "$PA" "$PB"; fi

# Cold start concorrente: sem o lock da sessão, os dois processos veem a porta
# livre e sobem DOIS browsers no mesmo perfil (um vira órfão que `down` não
# mata), e o segundo comando lê a página que o primeiro abriu. Com o lock, eles
# serializam: um browser só, e cada um lê a sua própria página.
CDIR="$(mktemp -d /tmp/browsin-conc.XXXXXX)"
( BROWSIN_DIR="$CDIR" browsin open $SP/basic.html > "$CDIR/a.out" 2>&1 ) &
( BROWSIN_DIR="$CDIR" browsin open $SP/tall.html  > "$CDIR/b.out" 2>&1 ) &
wait
NMAIN=$(ps -axo command= | grep -- "--user-data-dir=$CDIR/profile" | grep -v -- '--type=' | grep -c 'chrome-headless-shell' || true)
if [ "$NMAIN" -eq 1 ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "launch concorrente sobe um browser só"
else FAIL=$((FAIL+1)); FAILED+=("launch concorrente sobe um browser só"); printf '  FAIL %s\n       esperava 1 browser, achei %s\n' "launch concorrente sobe um browser só" "$NMAIN"; fi
if grep -q 'basic.html' "$CDIR/a.out" && grep -q 'tall.html' "$CDIR/b.out"; then PASS=$((PASS+1)); printf '  ok   %s\n' "comandos concorrentes leem cada um a sua página"
else FAIL=$((FAIL+1)); FAILED+=("comandos concorrentes leem cada um a sua página"); printf '  FAIL %s\n       a=%s b=%s\n' "comandos concorrentes leem cada um a sua página" "$(head -1 "$CDIR/a.out")" "$(head -1 "$CDIR/b.out")"; fi
BROWSIN_DIR="$CDIR" browsin down >/dev/null 2>&1
rm -rf "$CDIR"

sess suite-a down >/dev/null 2>&1
t "down da A não derruba a B"     'up '               sess suite-b status

echo "— gc —"
mkdir -p "$BROWSIN_DIR/suite-morta"
echo '{"pid": 999999, "port": 9390, "lastUsed": 1}' > "$BROWSIN_DIR/suite-morta/state.json"
t "gc apaga sessão de browser morto" 'suite-morta'    browsin gc

# Fake browser: um processo cujo argv carrega --user-data-dir da sessão, para o
# gc verificar a identidade do pid (state.json pode ter pid reutilizado) sem
# envolver Chrome real. Um `sleep` no state.json é justamente o pid alheio que
# o gc agora se recusa a matar.
mkdir -p "$BROWSIN_DIR/suite-velha"
node "$SP/fake-browser.mjs" --user-data-dir="$BROWSIN_DIR/suite-velha/profile" & FPID=$!
echo "{\"pid\": $FPID, \"port\": 9391, \"lastUsed\": 1}" > "$BROWSIN_DIR/suite-velha/state.json"
t "gc ceifa sessão idle"          'suite-velha'       browsin gc
if kill -0 "$FPID" 2>/dev/null; then
  FAIL=$((FAIL+1)); FAILED+=("gc mata o processo da sessão idle"); printf '  FAIL %s\n' "gc mata o processo da sessão idle"
else PASS=$((PASS+1)); printf '  ok   %s\n' "gc mata o processo da sessão idle"; fi

# Reuso de pid: um pid VIVO no state.json que não é um browser da sessão (ps
# não mostra --user-data-dir do perfil) nunca é morto — e a sessão fica para o
# próximo gc, porque pode haver browser real sob ela.
mkdir -p "$BROWSIN_DIR/suite-ajena"
sleep 300 & GSP=$!
echo "{\"pid\": $GSP, \"port\": 9392, \"lastUsed\": 1}" > "$BROWSIN_DIR/suite-ajena/state.json"
t "gc poupa pid reutilizado (não-browser)" 'keep suite-ajena' browsin gc
if kill -0 "$GSP" 2>/dev/null; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "gc não mata pid alheio do state.json"
else FAIL=$((FAIL+1)); FAILED+=("gc não mata pid alheio do state.json"); printf '  FAIL %s\n' "gc não mata pid alheio do state.json"; fi
kill "$GSP" 2>/dev/null; rm -rf "$BROWSIN_DIR/suite-ajena"

# O fecho do TOCTOU do janitor: mesmo sem o protect-snapshot ver, o gc revalida
# o lock da sessão NO ponto de matar — comando ativo, browser não é tocado.
mkdir -p "$BROWSIN_DIR/suite-ativa"
node "$SP/fake-browser.mjs" --user-data-dir="$BROWSIN_DIR/suite-ativa/profile" & GAP=$!
STALE_MS=$(( ($(date +%s) - 7200) * 1000 ))
printf '{"pid": %s, "port": 9393, "lastUsed": %s}' "$GAP" "$STALE_MS" > "$BROWSIN_DIR/suite-ativa/state.json"
printf '%s' "$$" > "$BROWSIN_DIR/suite-ativa/.lock"
t "gc poupa sessão com comando ativo" 'keep suite-ativa' browsin gc
if kill -0 "$GAP" 2>/dev/null && [ -d "$BROWSIN_DIR/suite-ativa" ]; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "gc não mata sob lock de comando ativo"
else FAIL=$((FAIL+1)); FAILED+=("gc não mata sob lock de comando ativo"); printf '  FAIL %s\n' "gc não mata sob lock de comando ativo"; fi
kill "$GAP" 2>/dev/null; rm -rf "$BROWSIN_DIR/suite-ativa"

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

# Órfão sob OUTRO BROWSIN_DIR: invisível ao coletor daquele BASE, mas a
# varredura de irmãos `browsin*` mata o processo — sem apagar os arquivos do
# base alheio (o kit preserva shots/ depois de dispor o browser).
OBASE="$(mktemp -d /tmp/browsin-outro.XXXXXX)"
( BROWSIN_DIR="$OBASE" browsin open $SP/basic.html ) >/dev/null 2>&1
OPID=$(grep -o '"pid": [0-9]*' "$OBASE/state.json" 2>/dev/null | grep -o '[0-9]*' | head -1)
rm -f "$OBASE/state.json"
BROWSIN_ORPHAN_GRACE_S=0 browsin gc >/dev/null 2>&1
if [ -n "$OPID" ] && ! kill -0 "$OPID" 2>/dev/null; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "gc mata órfão de outro BROWSIN_DIR"
else
  FAIL=$((FAIL+1)); FAILED+=("gc mata órfão de outro BROWSIN_DIR"); printf '  FAIL %s\n' "gc mata órfão de outro BROWSIN_DIR"
fi
if [ -d "$OBASE" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "gc preserva arquivos do base alheio"
else FAIL=$((FAIL+1)); FAILED+=("gc preserva arquivos do base alheio"); printf '  FAIL %s\n' "gc preserva arquivos do base alheio"; fi
rm -rf "$OBASE"

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

# BROWSIN_DIR apontando para um diretório de sessão (layout plano) não pode
# tratar profile/ e shots/ como sessões velhas e ceifá-los: eles são da default.
mkdir -p "$BROWSIN_DIR/flat/profile" "$BROWSIN_DIR/flat/shots"
touch "$BROWSIN_DIR/flat/profile/Cookies"
echo '{"pid": 999999, "port": 9500, "lastUsed": 1}' > "$BROWSIN_DIR/flat/state.json"
BROWSIN_DIR="$BROWSIN_DIR/flat" browsin gc >/dev/null 2>&1
if [ -f "$BROWSIN_DIR/flat/profile/Cookies" ] && [ -d "$BROWSIN_DIR/flat/shots" ]; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "layout default não ceifa profile/shots como sessões"
else
  FAIL=$((FAIL+1)); FAILED+=("layout default não ceifa profile/shots como sessões"); printf '  FAIL %s\n' "layout default não ceifa profile/shots como sessões"
fi
rm -rf "$BROWSIN_DIR/flat"

sess suite-a open $SP/basic.html >/dev/null 2>&1
gc_cap() { BROWSIN_MAX_SESSIONS=1 browsin gc; }
t "cap de sessões ceifa a mais antiga" 'acima do cap' gc_cap

echo "— abas —"
browsin open $SP/basic.html >/dev/null
# Espera a aba existir (condição, limitada), não um tempo fixo.
wait_tabs() { for _ in $(seq 1 50); do browsin tabs 2>/dev/null | grep -q "^tabs  $1 aba" && return 0; sleep 0.1; done; return 1; }
browsin js "void window.open('file://$SP/tall.html','browsin-suite-tab')" >/dev/null
wait_tabs 2
t "tabs lista as abas"        'aba\(s\)'   browsin tabs
t "tabs use fixa uma aba"     'usando 1'   browsin tabs use 1
t "tabs auto descarta o pin"  'auto'       browsin tabs auto
# Duas abas extras: um close não pode levar a última página (no headless shell isso
# derruba o browser) e o caso de confirmação precisa de outra aba para fechar.
browsin js "void window.open('file://$SP/tall.html','browsin-suite-tab2')" >/dev/null
wait_tabs 3
t "tabs close fecha uma aba"  'fechou 0'   browsin tabs close 0
# `/json/close/<id>` responde 200 com texto puro (`Target is closing`): parsear
# como JSON fazia todo close real imprimir "sem confirmação do browser".
tnot "tabs close confirma (200 texto, não 'sem confirmação')" 'sem confirmação' browsin tabs close 0
browsin open $SP/basic.html >/dev/null

echo "— resiliência da fronteira CDP —"
# As fixtures em test/resilience.mjs simulam browser mudo/morto em sockets locais:
# sem deadline, `send` não rejeitava nunca (nem no close), e o comando ficava
# pendurado segurando o lock da sessão.
tx "deadlines e fechamento do CDP (sem browser)" 0 'RESULTADO: [0-9]+ ok, 0 falhas' node "$HERE/resilience.mjs"

# Renderer travado num laço (fixture spin.html): o browser responde em
# /json/version e /json/list, mas nenhum round trip de protocolo volta. O
# comando tem que falhar rápido e não-zero, não esperar para sempre.
# A sonda repete até o laço começar (condição, limitada), em vez de um sleep
# fixo que, com a máquina carregada, caía antes ou depois da janela travada. Com
# deadline quebrado a sonda que pega o laço pendura até o fim dele e sai 0: as
# duas asserções abaixo continuam reprovando.
browsin open "$SP/spin.html?delay=1500&ms=5000" --no-wait >/dev/null 2>&1
for _ in $(seq 1 40); do
  SPIN_T0=$(date +%s)
  SPIN_OUT=$(BROWSIN_CDP_TIMEOUT_MS=800 browsin js '1' 2>&1); SPIN_CODE=$?
  SPIN_MS=$(( ($(date +%s) - SPIN_T0) * 1000 ))
  [ "$SPIN_CODE" = 0 ] || break
  sleep 0.1
done
if [ "$SPIN_CODE" = 1 ] && echo "$SPIN_OUT" | grep -qE 'timed out after 800ms'; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "renderer travado: deadline vira erro (exit 1)"
else FAIL=$((FAIL+1)); FAILED+=("renderer travado: deadline vira erro"); printf '  FAIL renderer travado: exit %s, veio: %s\n' "$SPIN_CODE" "$(echo "$SPIN_OUT" | head -2 | tr '\n' '|')"; fi
if [ "$SPIN_MS" -lt 15000 ]; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "renderer travado: falha limitada (${SPIN_MS}ms)"
else FAIL=$((FAIL+1)); FAILED+=("renderer travado: falha limitada"); printf '  FAIL renderer travado levou %sms\n' "$SPIN_MS"; fi
# Lock liberado e browser intacto: o comando seguinte anda sozinho depois do laço.
SPIN_RECOVER=0
for _ in $(seq 1 30); do browsin js 'document.title' >/dev/null 2>&1 && { SPIN_RECOVER=1; break; }; sleep 0.4; done
if [ "$SPIN_RECOVER" = 1 ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "comando seguinte anda (lock liberado, browser vivo)"
else FAIL=$((FAIL+1)); FAILED+=("comando seguinte anda após timeout"); printf '  FAIL sessão ficou presa após o timeout\n'; fi

# Browser morto no meio de um comando: o pendente rejeita e o CLI sai não-zero.
LOCKED_OUT="$(mktemp /tmp/browsin-kill.XXXXXX)"
browsin open $SP/basic.html >/dev/null 2>&1
( browsin js 'document.title = "pendente"; new Promise(r => setTimeout(r, 5000))' >"$LOCKED_OUT" 2>&1; echo $? >"$LOCKED_OUT.code" ) &
KILLW=$!
# Mata quando o comando está de fato pendente (o título que ele pôs aparece no
# /json/list do browser), não depois de um tempo fixo.
BPORT=$(node -p "JSON.parse(require('fs').readFileSync(process.env.BROWSIN_DIR + '/state.json','utf8')).port" 2>/dev/null)
for _ in $(seq 1 100); do curl -s "http://127.0.0.1:$BPORT/json/list" 2>/dev/null | grep -q pendente && break; sleep 0.1; done
BPID=$(node -p "(JSON.parse(require('fs').readFileSync(process.env.BROWSIN_DIR + '/state.json','utf8')).pid) || ''" 2>/dev/null)
kill -9 "$BPID" 2>/dev/null
wait "$KILLW"
KILL_CODE=$(cat "$LOCKED_OUT.code" 2>/dev/null)
if [ "$KILL_CODE" = 1 ] && grep -qE 'socket closed|socket error|closed before' "$LOCKED_OUT"; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "browser morto no meio: pendente rejeita (exit 1)"
else FAIL=$((FAIL+1)); FAILED+=("browser morto no meio: pendente rejeita"); printf '  FAIL exit %s: %s\n' "$KILL_CODE" "$(head -2 "$LOCKED_OUT" | tr '\n' '|')"; fi
rm -f "$LOCKED_OUT" "$LOCKED_OUT.code"
t "próximo comando sobe outro browser" 'Teste browsin' browsin open $SP/basic.html

echo "— sandbox aninhado (harness sob Seatbelt) —"
# Under an outer macOS sandbox Chromium cannot sandbox its children, which die
# and drop the socket on Page.enable. connect must relaunch with --no-sandbox.
if command -v sandbox-exec >/dev/null; then
  SBX() { BROWSIN_SESSION=suite-sbx sandbox-exec -p '(version 1)(allow default)' "$HERE/../bin/browsin" "$@"; }
  tx "check sob sandbox cai para --no-sandbox" 0 'Teste browsin' SBX check $SP/basic.html
  t "sessão lembra noSandbox" '"noSandbox": true' cat "$BROWSIN_DIR/suite-sbx/state.json"
  tx "comando seguinte reusa o browser" 0 'Teste browsin' SBX open $SP/basic.html
  sess suite-sbx down >/dev/null 2>&1
  t "fora do sandbox o sandbox do Chrome continua ligado" '"noSandbox": false' bash -c "BROWSIN_SESSION=suite-nsb '$HERE/../bin/browsin' open $SP/basic.html >/dev/null 2>&1; cat '$BROWSIN_DIR/suite-nsb/state.json'"
  sess suite-nsb down >/dev/null 2>&1
fi

echo "— down --all —"
sess suite-a open $SP/basic.html >/dev/null 2>&1
t "down --all derruba todas"      'all sessions'      browsin down --all
t "B caiu com --all"             'no browser running' sess suite-b status
t "A caiu com --all"             'no browser running' sess suite-a status

echo "— janitor (zelador autônomo) —"
# Sem Chrome real: processos `sleep` fazem vez de browser no state.json. Cada
# caso roda num BROWSIN_DIR próprio, então o gc do janitor nunca enxerga o
# browser vivo da suíte nem o de outro agente.
JAN="$HERE/../src/janitor.mjs"

# Base sem sessões: o janitor sai de imediato e não deixa lock.
JDE="$(mktemp -d /tmp/browsin-jan-empty.XXXXXX)"
BROWSIN_DIR="$JDE" node "$JAN" --max-ticks 1 >/dev/null 2>&1
if [ ! -f "$JDE/.janitor-lock" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "janitor em base vazia sai sem lock"
else FAIL=$((FAIL+1)); FAILED+=("janitor em base vazia sai sem lock"); printf '  FAIL %s\n' "janitor em base vazia sai sem lock"; fi
rm -rf "$JDE"

# Sessão ociosa com "browser" vivo: ceifada, e o janitor sai (nada vivo restou).
JDI="$(mktemp -d /tmp/browsin-jan-idle.XXXXXX)"
mkdir -p "$JDI/sess-x"
node "$SP/fake-browser.mjs" --user-data-dir="$JDI/sess-x/profile" & JFP=$!
printf '{"pid": %s, "port": 9491, "lastUsed": 1}' "$JFP" > "$JDI/sess-x/state.json"
BROWSIN_DIR="$JDI" BROWSIN_TTL_MIN=0 BROWSIN_JANITOR_LOG="$JDI/jan.log" node "$JAN" --max-ticks 1 >/dev/null 2>&1
if ! kill -0 "$JFP" 2>/dev/null && [ ! -d "$JDI/sess-x" ]; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "janitor ceifa sessão ociosa e sai"
else FAIL=$((FAIL+1)); FAILED+=("janitor ceifa sessão ociosa e sai"); printf '  FAIL janitor não ceifou (pid vivo? dir?)\n'; fi
if ! kill -0 "$JFP" 2>/dev/null && [ ! -f "$JDI/.janitor-lock" ]; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "janitor mata o processo da sessão ociosa e libera o lock"
else FAIL=$((FAIL+1)); FAILED+=("janitor mata o processo da sessão ociosa e libera o lock"); printf '  FAIL janitor deixou rastro\n'; fi
rm -rf "$JDI"

# Um janitor por base: com lock de dono vivo, o segundo sai sem fazer nada.
JDS="$(mktemp -d /tmp/browsin-jan-single.XXXXXX)"
sleep 300 & JLK=$!
mkdir -p "$JDS/sess-x"; printf '{"pid": 999999, "lastUsed": 1}' > "$JDS/sess-x/state.json"
printf '%s' "$JLK" > "$JDS/.janitor-lock"
BROWSIN_DIR="$JDS" BROWSIN_TTL_MIN=0 node "$JAN" --max-ticks 1 >/dev/null 2>&1
if [ -d "$JDS/sess-x" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "segundo janitor respeita o lock do primeiro"
else FAIL=$((FAIL+1)); FAILED+=("segundo janitor respeita o lock do primeiro"); printf '  FAIL segundo janitor ceifou mesmo com lock de dono vivo\n'; fi
# Dono morto: o lock é roubado (e a sessão ociosa, ceifada).
kill "$JLK" 2>/dev/null
BROWSIN_DIR="$JDS" BROWSIN_TTL_MIN=0 node "$JAN" --max-ticks 1 >/dev/null 2>&1
if [ ! -d "$JDS/sess-x" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "janitor rouba lock de dono morto"
else FAIL=$((FAIL+1)); FAILED+=("janitor rouba lock de dono morto"); printf '  FAIL lock de dono morto não roubado\n'; fi
rm -rf "$JDS"

# Sessão sob comando ativo (lock de sessão segurado por processo vivo) nunca é
# ceifada — mesmo ociosa além do TTL.
JDA="$(mktemp -d /tmp/browsin-jan-active.XXXXXX)"
mkdir -p "$JDA/sess-act"
node "$SP/fake-browser.mjs" --user-data-dir="$JDA/sess-act/profile" & JFP2=$!
printf '{"pid": %s, "port": 9492, "lastUsed": 1}' "$JFP2" > "$JDA/sess-act/state.json"
printf '%s' "$$" > "$JDA/sess-act/.lock"
BROWSIN_DIR="$JDA" BROWSIN_TTL_MIN=0 node "$JAN" --max-ticks 1 >/dev/null 2>&1
if kill -0 "$JFP2" 2>/dev/null && [ -d "$JDA/sess-act" ]; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "janitor poupou sessão com comando ativo"
else FAIL=$((FAIL+1)); FAILED+=("janitor poupou sessão com comando ativo"); printf '  FAIL janitor ceifou sessão ativa\n'; fi
kill "$JFP2" 2>/dev/null; rm -rf "$JDA"

# Nenhuma outra sessão viva nesta base: senão o janitor fica, com razão, e o teste mede a ordem da suíte.
browsin down --all >/dev/null 2>&1
# Lançamento cria um janitor por base, deduplicado; ele morre sozinho quando a
# última sessão viva some. Intervalo curto só para o teste.
BROWSIN_JANITOR=on BROWSIN_JANITOR_INTERVAL_S=2 sess suite-jan open $SP/basic.html >/dev/null 2>&1
JPID=
for _ in $(seq 1 50); do JPID=$(cat "$BROWSIN_DIR/.janitor-lock" 2>/dev/null); [ -n "$JPID" ] && kill -0 "$JPID" 2>/dev/null && break; sleep 0.1; done
if [ -n "$JPID" ] && kill -0 "$JPID" 2>/dev/null; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "launch cria janitor vivo"
else FAIL=$((FAIL+1)); FAILED+=("launch cria janitor vivo"); printf '  FAIL launch não deixou janitor (lock=%s)\n' "$JPID"; fi
BROWSIN_JANITOR=on BROWSIN_JANITOR_INTERVAL_S=2 sess suite-jan open $SP/basic.html >/dev/null 2>&1
JPID2=$(cat "$BROWSIN_DIR/.janitor-lock" 2>/dev/null)
if [ "$JPID" = "$JPID2" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "lançamentos repetidos não criam segundo janitor"
else FAIL=$((FAIL+1)); FAILED+=("lançamentos repetidos não criam segundo janitor"); printf '  FAIL janitor trocou de pid (%s -> %s)\n' "$JPID" "$JPID2"; fi
BROWSIN_JANITOR=on BROWSIN_JANITOR_INTERVAL_S=2 sess suite-jan down >/dev/null 2>&1
JGONE=0
for _ in $(seq 1 20); do kill -0 "$JPID" 2>/dev/null || { JGONE=1; break; }; sleep 0.5; done
if [ "$JGONE" = 1 ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "janitor sai quando a última sessão morre"
else FAIL=$((FAIL+1)); FAILED+=("janitor sai quando a última sessão morre"); printf '  FAIL janitor sobreviveu à última sessão\n'; kill "$JPID" 2>/dev/null; fi

echo "— setup.sh (hermético: home, bin e cache temporários) —"
# Nunca escreve no home de verdade: BROWSIN_BIN_DIR + BROWSIN_SKILL_DIRS + --no-browsers.
REPO="$(cd "$HERE/.." && pwd)"
ST="$(mktemp -d /tmp/browsin-setup.XXXXXX)"
mkdir -p "$ST/claude/skills" "$ST/codex/skills/ui-mocks" "$ST/bin" "$ST/browsers"
ln -s "$ST/velho" "$ST/claude/skills/browsin"        # link antigo: é substituído
touch "$ST/codex/skills/ui-mocks/MINHA.md"           # pasta de verdade: é de outra pessoa
setup_run() { BROWSIN_BIN_DIR="$ST/bin" BROWSIN_SKILL_DIRS="$ST/claude/skills:$ST/codex/skills" BROWSIN_BROWSERS="$ST/browsers" \
  bash "$REPO/scripts/setup.sh" --no-browsers; }
GIT_BEFORE=$(git -C "$REPO" status --porcelain)
SETUP_OUT=$(setup_run 2>&1); SETUP_CODE=$?
links_ok() {
  [ "$(readlink "$ST/claude/skills/browsin")" = "$REPO/skills/browsin" ] &&
  [ "$(readlink "$ST/claude/skills/ui-mocks")" = "$REPO/skills/ui-mocks" ] &&
  [ "$(readlink "$ST/codex/skills/browsin")" = "$REPO/skills/browsin" ] &&
  [ "$(readlink "$ST/bin/browsin")" = "$REPO/bin/browsin" ]
}
if [ "$SETUP_CODE" = 0 ] && links_ok; then PASS=$((PASS+1)); printf '  ok   %s\n' "setup liga as duas skills e o CLI (link antigo substituído)"
else FAIL=$((FAIL+1)); FAILED+=("setup liga as duas skills e o CLI"); printf '  FAIL setup (exit %s): %s\n' "$SETUP_CODE" "$(echo "$SETUP_OUT" | tail -4 | tr '\n' '|')"; fi
if [ ! -L "$ST/codex/skills/ui-mocks" ] && [ -f "$ST/codex/skills/ui-mocks/MINHA.md" ] && echo "$SETUP_OUT" | grep -q 'ui-mocks existe e não é um link'; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "setup deixa pasta de verdade com nome de skill e diz"
else FAIL=$((FAIL+1)); FAILED+=("setup deixa pasta de verdade com nome de skill"); printf '  FAIL setup mexeu numa pasta que não é dele\n'; fi
if ! echo "$SETUP_OUT" | grep -q '==> browsers' && [ -z "$(ls -A "$ST/browsers")" ] &&
   [ "$(echo "$SETUP_OUT" | grep -c "bash $REPO/scripts/install-browsers.sh")" = 1 ]; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "setup --no-browsers não instala browser e diz o comando numa linha"
else FAIL=$((FAIL+1)); FAILED+=("setup --no-browsers"); printf '  FAIL setup --no-browsers: %s\n' "$(echo "$SETUP_OUT" | head -3 | tr '\n' '|')"; fi
SETUP_OUT2=$(setup_run 2>&1); SETUP_CODE2=$?
if [ "$SETUP_CODE2" = 0 ] && links_ok && [ "$(git -C "$REPO" status --porcelain)" = "$GIT_BEFORE" ]; then
  PASS=$((PASS+1)); printf '  ok   %s\n' "setup é idempotente e não muda arquivo versionado"
else FAIL=$((FAIL+1)); FAILED+=("setup idempotente"); printf '  FAIL segunda rodada (exit %s) ou árvore mudou\n' "$SETUP_CODE2"; fi
tx "setup: flag desconhecida sai 2" 2 'flag desconhecida' bash "$REPO/scripts/setup.sh" --banana
rm -rf "$ST"

echo
echo "RESULTADO: $PASS ok, $FAIL falhas"
[ $FAIL -gt 0 ] && printf 'falharam: %s\n' "${FAILED[*]}"
exit $FAIL
