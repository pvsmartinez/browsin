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
t "snap clip sem match falha" 'no match' browsin snap --clip '#nada'

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
t "arquivo inexistente"    'no such file'       browsin open ./nao/existe.html
t "url morta"              'ERR_'               browsin open http://127.0.0.1:59998
t "down"                   'down '              browsin down
t "status com browser off" 'no browser running' browsin status

echo
echo "RESULTADO: $PASS ok, $FAIL falhas"
[ $FAIL -gt 0 ] && printf 'falharam: %s\n' "${FAILED[*]}"
exit $FAIL
