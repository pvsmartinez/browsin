# browsin

Browser headless por linha de comando, feito para um agente de código. Screenshot, DOM, console,
rede, PDF, clique e download — com orçamento de token no default.

```bash
browsin check localhost:5173 --wait 'document.querySelector("#root")?.children.length > 0'
```
```
check http://localhost:5173/
title Fisquin
view  1440x900 @1x · 48 nodes · page 900px tall
net   35 request(s), all ok
logs  clean (+3 log/info/debug)

snap  /tmp/browsin/<sessão>/shots/check.png
size  1440x900px · 28 KB · 1x
```

## Por que existe

Um agente que mexe em interface precisa ver o que fez. As duas opções prontas cobram caro pela
coisa errada:

- **MCP de browser** (Playwright e parentes) — quase 1 GB de Chromium em cache, `npx -y` a cada
  sessão, dezenas de tools ocupando contexto o tempo todo, e uma janela real abrindo na tela.
- **Dirigir o Chrome de verdade**, com as contas do usuário logadas. Certo quando o valor da tarefa
  **é** a sessão dele; errado para "tira um print do meu dev server".

O browsin fica no meio: um `chrome-headless-shell` (sem camada de UI — fisicamente incapaz de
aparecer na tela) com perfil descartável em `/tmp/browsin/<sessão>`, dirigido por CDP cru. 146 MB de RAM,
~700 ms do nada até o PNG.

## Instalação

**Requisitos: macOS (Apple Silicon ou Intel) e Node 22+.** Não há dependência de npm para
instalar: o `WebSocket` global do Node 22 é a única coisa que um cliente CDP precisa, e os dois
Chromium vêm direto do CDN Chrome-for-Testing do Google. O comando opcional `record stop` usa
`ffmpeg` (`brew install ffmpeg`) para montar GIF/MP4; todo o restante funciona sem ele.

```bash
git clone git@github.com:pvsmartinez/browsin.git && cd browsin
scripts/setup.sh                 # browsers + `browsin` no PATH + skill do agente
```

O `setup.sh` é idempotente — rode de novo depois de um `git pull`. Flags: `--shell-only` (195 MB
em vez de 550, abre mão do `login`), `--force` (rebaixar os browsers), `--no-link`, `--no-skill`.
Ele instala em `~/.local/bin` (troque com `BROWSIN_BIN_DIR`) e symlinka `skills/browsin` em
`~/.claude/skills/` e `~/.codex/skills/` quando existirem.

Só os browsers, sem mexer em PATH nem skill:

```bash
scripts/install-browsers.sh               # ~550 MB em ~/Library/Caches/browsin
scripts/install-browsers.sh --shell-only  # ~195 MB
```

Em **Linux** o CLI roda, mas o instalador não cobre: aponte `BROWSIN_CHROME` para um Chromium que a
máquina já tenha (ou `BROWSIN_BROWSERS` para uma pasta com o `headless-shell`). Não é caminho
testado. **Windows** não é suportado.

| | onde | pra quê |
|---|---|---|
| `headless-shell` | `<cache>/browsin/headless-shell` | o default. Sem camada de UI: **não consegue** aparecer na tela |
| `chromium` | `<cache>/browsin/chromium` | só o `login`, que precisa de janela de verdade |

`<cache>` é `~/Library/Caches` no macOS e `$XDG_CACHE_HOME` (ou `~/.cache`) fora dele.

`browsin doctor` diz qual binário está em jogo. Faltando instalação, o browsin cai no Chrome do
sistema como **último recurso** — sempre no perfil descartável, nunca no do usuário — e o `doctor`
grita, porque fallback silencioso parece que funcionou.

Atualizar: `scripts/install-browsers.sh --force`, e depois `test/suite.sh` — a renderização muda
entre versões do Chrome. `BROWSIN_BROWSERS=<dir>` aponta para outra instalação (é assim que a
instalação limpa é testada sem tocar na oficial).

### Projeto que usa Playwright como biblioteca

O instalador também cria `~/Library/Caches/browsin/playwright-compat`: symlinks no layout que o
Playwright espera, para um projeto que use a **biblioteca** (não o MCP) dirigir os mesmos binários
em vez de baixar outro giga:

```bash
export PLAYWRIGHT_BROWSERS_PATH=~/Library/Caches/browsin/playwright-compat
```

Revisão é só nome de diretório para o Playwright, então o shim cobre as que ele costuma pedir; se
pedir uma nova, acrescente na lista do instalador.

## Usar num agente

A ferramenta sozinha não é chamada: o agente precisa saber que ela existe e que texto vem antes de
pixel. `skills/browsin/SKILL.md` é essa parte, e o `setup.sh` já a instala nos diretórios de skill
que encontrar. À mão:

```bash
ln -sfn "$PWD/skills/browsin" ~/.claude/skills/browsin     # Claude Code
```

Em agente sem sistema de skills, aponte o AGENTS.md/CLAUDE.md do projeto para o arquivo, ou cole o
conteúdo. O que não funciona é instalar o CLI e não contar para ninguém.

### Como tool do harness pi

O browsin também se registra como **tool** estruturado no harness
[pi](https://github.com/earendil-works/pi) — chamada com `action` tipado, sem depender do modelo
ler skill primeiro. A integração mora no [pi-workspace-kit](../pi-workspace-kit/) (tools por
workspace + subagentes); este README só documenta o provider do browsin. Nada vem ligado por
default: cada workspace opta via `.pi/tools.json` (descoberto subindo a árvore a partir do cwd,
mesmo gate de confiança de `.pi/extensions`).

```bash
../pi-workspace-kit/scripts/install.sh   # symlinka as extensões do kit em ~/.pi/agent/extensions/
```

Configuração — workspace (`<raiz>/.pi/tools.json`) ou global (`~/.pi/agent/tools.json`):

```json
{
  "tools": {
    "browsin": { "enabled": true, "binary": "browsin", "timeout": 120000 }
  }
}
```

- `"browsin": true` (shorthand) ou `false` (registra mas deixa inativo).
- `/tools list | enable browsin | disable browsin` no pi — toggle por sessão; `--save` persiste.
- Qualquer CLI vira tool com o provider genérico `cli` (veja `../pi-workspace-kit/ext/workspace-tools.ts`).

## Comandos

| | |
|---|---|
| `check <url\|arquivo>` | navega, lista problemas, rede e print — uma chamada |
| `open <url\|arquivo>` · `reload [--hard]` · `back` | navegação |
| `snapshot` | **comece aqui**: o que tem na tela, como seletores acionáveis |
| `dom <sel>` | rect, visibilidade, estilos computados, `outerHTML` truncado |
| `text [sel]` | `innerText` do elemento (default `body`), whitespace normalizado; `--limit N` trunca, `--nth N` desempata |
| `js '<expr>'` | avalia na página (promise resolvida, exceção vira erro de verdade) |
| `logs [--all]` | console, exceção, rejection, 4xx/5xx e recurso que falhou |
| `network [url]` | toda request com o status code, no nível do protocolo |
| `snap [--clip SEL] [--full] [--jpeg]` | screenshot; default viewport em 1x |
| `pdf [url] [--format a4\|a3] [--landscape]` | imprime honrando `@page` e quebra de página |
| `record start\|status\|stop\|cancel` | grava os estados de um fluxo em GIF/MP4, sem pôr frames no output |
| `click` · `hover` · `type [--enter]` · `key` · `select` | interação |
| `upload <sel> <arquivo…>` · `download <sel>` | arquivos entrando e saindo |
| `drag <de> <para>` \| `drag <sel> --by dx,dy` | canvas, tldraw, blocos |
| `scroll <y\|top\|bottom\|seletor>` | posiciona a página |
| `viewport [1280x800\|iphone\|ipad\|desktop\|wide]` | persiste entre chamadas |
| `login [url] [--note "motivo"]` | janela **visível** para autenticar à mão, uma vez; com `--note`, abre primeiro uma intersticial explicando ao usuário por que a janela surgiu |
| `status` · `doctor` · `gc` · `down [--fresh\|--all]` | inspeciona / mata (e opcionalmente desloga) |

Seletores aceitam **CSS** ou **`text=Entrar`** — endereçar pelo que o usuário lê, em vez de
adivinhar sopa de classe Tailwind. Os dois atravessam **shadow DOM** e **iframe same-origin**.

Para ler uma página sem screenshot, `text` devolve o `innerText` normalizado (linhas em branco
colapsadas) — muito mais barato em tokens que pixel ou `outerHTML`:

```bash
browsin text                          # página inteira (default: body, cap de 2000 chars)
browsin text 'main article' --limit 400
browsin text '.card' --nth 1          # 2º match, quando o seletor casa com vários
```

### Gravar uma demonstração

`record` é propositalmente orientado a agentes: não filma o tempo de raciocínio entre comandos.
`start` guarda o estado na sessão e captura o primeiro frame; cada comando visual posterior
(`open`, `click`, `type`, `scroll`, `js` etc.) acrescenta um JPEG em disco; `stop` monta o
artefato e devolve apenas path e metadados compactos. Não há daemon ou bytes de imagem no stdout.

```bash
browsin open localhost:5173
browsin record start --name cadastro --fps 12       # default: cap de 5 min
browsin click 'text=Criar conta'
browsin type 'input[name="email"]' aluno@exemplo.com
browsin key Enter --on 'input[name="email"]' --wait 'location.pathname === "/inicio"'
browsin record stop -o out/cadastro.gif --width 960 # MP4: extensão .mp4 ou --format mp4
```

Por default, cada intervalo fica limitado a 1 segundo (`--max-gap`), eliminando as pausas do
modelo; `--max-gap 0` preserva o tempo real. `--max-seconds 0` remove o cap de cinco minutos.
`--keep-frames` preserva os JPEGs; sem ele, ficam só o GIF/MP4 e o sidecar `<saída>.json`.
`record cancel` descarta tudo, e `down` cancela uma gravação ativa. Para o agente, o artefato é o
path impresso: não leia cada frame de volta para a conversa.

## Sessões: um browser por agente

O browsin era um singleton — porta fixa e uma aba só. Dois agentes na mesma máquina brigavam pela
mesma aba: um navegava, o outro tirava print da página errada, e o `down` de um matava o browser do
outro. Agora cada sessão tem porta, perfil, `state.json` e `shots/` próprios:

| chave | quando |
|---|---|
| `BROWSIN_SESSION` | explícito, quando o chamador sabe o que está fazendo |
| `PI_SESSION_ID` | automático dentro do pi — **cada run de subagente tem o seu**, então subagentes paralelos não colidem |
| `CLAUDE_CODE_SESSION_ID` | automático no Claude Code: cada conversa tem a sua — o `login` de uma não vaza para a próxima na mesma aba |
| `TERM_SESSION_ID` | fora do pi e do Claude Code (codex, shells): isola por aba de terminal |
| `default` | sem nenhuma das anteriores — ou com `BROWSIN_DIR` explícito, que é namespace do próprio chamador |

`browsin status` mostra a sua sessão (e lista as outras vivas); `browsin down` derruba só a sua.

### Abas

Uma sessão de browser pode ter várias abas — `target=_blank`, um popup de OAuth. Por default o
próximo comando segue a aba mais recente; `browsin tabs` lista, `browsin tabs use N` fixa uma aba
para os comandos seguintes, `browsin tabs close N` fecha e `browsin tabs auto` volta a seguir a
primeira. O pin vive no `state.json`, então sobrevive entre invocações.

Comandos da mesma sessão são **serializados** por um lock cross-process: disparar dois `browsin` em
paralelo não sobe dois browsers nem faz um ler a página do outro — o segundo espera o primeiro
sair. Sessões diferentes continuam paralelas de verdade. O lock é detectado como obsoleto se o dono
morre (sem travar a sessão para sempre), e `status`/`doctor`/`gc`/`down` nunca o pegam.

A sessão `default` (sem `BROWSIN_SESSION`/`PI_SESSION_ID`) fica no layout plano, com `profile/` e
`state.json` direto em `BROWSIN_DIR` — é o que um chamador que já isola por conta própria (o kit do
pi, um teste, um run de rascunho) sempre teve. Sessões nomeadas ganham subdiretório.

### E não vaza

Sessão órfã é memória parada (~150 MB por browser), então `launch` roda um coletor antes de subir.
Sessão com browser morto é apagada; sessão ociosa há mais de `BROWSIN_TTL_MIN` (default 60 min) é
derrubada; acima de `BROWSIN_MAX_SESSIONS` (default 8) as mais ociosas são ceifadas. `browsin gc`
roda isso à mão e diz o que fez, e `browsin down --all` derruba todas de uma vez.

Dois buracos que o coletor cobre e que valem saber: browser que perdeu o `state.json` (varrido por
`ps --user-data-dir` — senão fica imortal) e a sessão `default`, que é o layout plano e por isso
precisa ser coletada pelo `gc` de *outra* sessão (uma sessão nunca derruba o browser que está
usando). Sem o `state.json`, a idade passa a ser o mtime do diretório — foi o que fez o `down`
parar de deixar 200 MB invisíveis para sempre.

O `gc` também varre os bases **irmãos** (`/tmp/browsin*`: os dirs por-run do kit, testes, runs
manuais) e mata browser órfão sob eles, porque o coletor de um `BASE` só vê o próprio base — era
assim que a máquina acumulava `chrome-headless-shell` de dias. Arquivos de base alheio não são
apagados (o kit preserva `shots/` depois de dispor o browser); a carência para um browser recém
subo é `BROWSIN_ORPHAN_GRACE_S` (default 300s).

| variável | para quê |
|---|---|
| `BROWSIN_SESSION` | namespace da sessão (default: `PI_SESSION_ID`, senão `CLAUDE_CODE_SESSION_ID`, senão `TERM_SESSION_ID`, senão `default`) |
| `BROWSIN_DIR` | raiz (default `/tmp/browsin`); sessões nomeadas viram subdiretório, a `default` fica na raiz |
| `BROWSIN_PORT` | porta fixa (default: 9377 + hash da sessão) |
| `BROWSIN_TTL_MIN` · `BROWSIN_MAX_SESSIONS` | coleta: ociosidade e teto de sessões vivas |

## Três decisões de projeto

**O orçamento é token, não megabyte.** `snap` sai em 1x por default porque `2560x1600` custa 8x
mais token que `1280x800` e quase nunca responde melhor. E a saída é texto-primeiro: `snapshot`
lista a tela inteira em ~250 tokens onde um print custa ~1500.

**Sem daemon.** O coletor de console/erro roda **dentro da página**
(`Page.addScriptToEvaluateOnNewDocument` → `window.__browsin`). Cada invocação do CLI é um
processo curto que ataca a mesma aba e drena o buffer — não existe processo de fundo guardando
estado, e o que o CDP zera ao desconectar (viewport, coletor) é restaurado no attach a partir do
`state.json` da sessão. `record` preserva essa decisão: os próprios comandos capturam keyframes;
não há gravador residente entre uma ação e outra.

**Uma resolução de seletor para todos os comandos.** `text=`, shadow DOM e iframe vivem num só
helper injetado (`window.__bq`), que devolve também o **offset do frame** — é o que faz um clique
por coordenada acertar um botão dentro de um iframe. Comando novo herda tudo isso de graça.

## Testes

```bash
test/suite.sh     # suíte de aceitação, incluindo os casos que só quebram em documento real
```

A bateria cobre console/rede/recurso, snapshot, os quatro modos de `snap`, PDF paginado, diálogo
`confirm()`, select, upload, download de blob, drag em canvas, shadow DOM, iframe, sessões
concorrentes (incluindo cold start paralelo), o lock de sessão e a coleta, e todos os caminhos de
erro. É **hermética**: roda num `BROWSIN_DIR`
temporário, então `down --all` e `gc` não tocam no browser que outro agente esteja usando. Rode
antes de mexer em qualquer coisa.

## Armadilhas

- **Esperar é a parte difícil, não capturar.** `open`/`check` já esperam (até 1,5s) o body deixar
  de ser vazio, o que tira muitos SPAs do print em branco sem configuração. Para um marcador
  próprio, `--wait '<expr>'` é sempre melhor; `--no-wait` desliga a espera automática (app
  só-canvas). `check` avisa quando ainda ficou vazio (`body renders no text`).
- **Perfil descartável = deslogado.** Todo app cai na tela de login. É a feature. Para portal
  logado, `browsin login <url>` abre uma janela visível uma vez; o cookie fica no perfil do
  browsin e todo comando headless depois herda. Com `--note "motivo"`, a janela abre primeiro
  numa intersticial explicando ao humano por que surgiu (com botão "Continue to <url>"; sem
  URL, pede pra fechar a janela ao terminar) — útil quando o agente roda sem o usuário
  esperando uma janela na tela:

  ```bash
  browsin login https://app.exemplo.com --note "Preciso que você autentique no painel X para eu continuar a tarefa."
  ```

  O primeiro comando comum depois do `login` fecha a janela visível e relança headless no mesmo
  perfil; a página volta a `about:blank` (o cookie, não a navegação, é o que persiste). O login
  é da sessão: outras não o veem, e `down --fresh` ou o TTL de ociosidade o apagam. Ambos os
  builds rodam com `--use-mock-keychain` — sem isso o chromium headed cifra o cookie com a chave
  do Keychain e o headless shell não decifra, e o login some no relançamento. A janela é ativada
  por pid (`NSRunningApplication`), porque um processo destacado nasce atrás de tudo.
- **`viewport --dpr` ≠ `snap --dpr`.** O primeiro é o `devicePixelRatio` que a *página* vê (media
  query, `srcset`); o segundo é a densidade do arquivo. O CDP multiplica os dois, então o `snap`
  divide de volta — pedir 1x num viewport @2x não pode render imagem 4x.
- **`snap` do viewport não reflui a página.** O print padrão (a área visível) captura sem
  `captureBeyondViewport`, então não dispara `resize` — apps que redesenham no resize (canvas,
  Blockly) ficam intactos. `--clip`/`--full` usam `captureBeyondViewport` para renderizar o que
  está fora da tela, e aí a página é relayoutada uma vez.
- **`logs` drena.** Ler duas vezes não repete. E qualquer comando que age (`click`, `key`, `type`)
  também drena ao reportar.
- **`--clip 'text=…'` pega o menor elemento que contém o texto**, quase sempre menor do que a
  caixa que você quer fotografar. Para print, prefira um seletor CSS do container, ou `--pad`.
- **Descendente não atravessa shadow boundary.** Use o seletor como ele é *dentro* do componente
  (`#shadowbtn`), não um caminho pelo host (`my-widget button`).
- **iframe cross-origin é invisível.** O piercing só alcança `contentDocument` acessível.
- **Chromium só.** Bug de Safari/WebKit ou Firefox não aparece aqui.
- **`state.json` pode sumir com o browser vivo** (`/tmp` limpo, dois `BROWSIN_DIR`). Nesse caso o
  `down` mata pelo dono da porta, o `status` diz `adopted from the port` e o `gc` varre o browser
  órfão pelo `--user-data-dir`. Antes disso o headless shell ficava imortal.
- **Sessão não é browser.** `down` derruba o browser e mantém perfil e `shots/` da sessão (é onde os
  cookies ficam); o coletor só apaga o diretório quando a sessão passa do TTL. Para sumir com tudo
  agora, `down --all --fresh`.

## Licença

MIT — veja [LICENSE](LICENSE).
