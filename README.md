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

snap  /tmp/browsin/shots/check.png
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
aparecer na tela) com perfil descartável em `/tmp/browsin`, dirigido por CDP cru. 146 MB de RAM,
~700 ms do nada até o PNG.

## Instalação

**Requisitos: macOS (Apple Silicon ou Intel) e Node 22+.** Não há dependência de npm para
instalar: o `WebSocket` global do Node 22 é a única coisa que um cliente CDP precisa, e os dois
Chromium vêm direto do CDN Chrome-for-Testing do Google.

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

## Comandos

| | |
|---|---|
| `check <url\|arquivo>` | navega, lista problemas, rede e print — uma chamada |
| `open <url\|arquivo>` · `reload [--hard]` · `back` | navegação |
| `snapshot` | **comece aqui**: o que tem na tela, como seletores acionáveis |
| `dom <sel>` | rect, visibilidade, estilos computados, `outerHTML` truncado |
| `js '<expr>'` | avalia na página (promise resolvida, exceção vira erro de verdade) |
| `logs [--all]` | console, exceção, rejection, 4xx/5xx e recurso que falhou |
| `network [url]` | toda request com o status code, no nível do protocolo |
| `snap [--clip SEL] [--full] [--jpeg]` | screenshot; default viewport em 1x |
| `pdf [url] [--format a4\|a3] [--landscape]` | imprime honrando `@page` e quebra de página |
| `click` · `hover` · `type [--enter]` · `key` · `select` | interação |
| `upload <sel> <arquivo…>` · `download <sel>` | arquivos entrando e saindo |
| `drag <de> <para>` \| `drag <sel> --by dx,dy` | canvas, tldraw, blocos |
| `scroll <y\|top\|bottom\|seletor>` | posiciona a página |
| `viewport [1280x800\|iphone\|ipad\|desktop\|wide]` | persiste entre chamadas |
| `login [url]` | janela **visível** para autenticar à mão, uma vez |
| `status` · `down [--fresh]` | inspeciona / mata (e opcionalmente desloga) |

Seletores aceitam **CSS** ou **`text=Entrar`** — endereçar pelo que o usuário lê, em vez de
adivinhar sopa de classe Tailwind. Os dois atravessam **shadow DOM** e **iframe same-origin**.

## Três decisões de projeto

**O orçamento é token, não megabyte.** `snap` sai em 1x por default porque `2560x1600` custa 8x
mais token que `1280x800` e quase nunca responde melhor. E a saída é texto-primeiro: `snapshot`
lista a tela inteira em ~250 tokens onde um print custa ~1500.

**Sem daemon.** O coletor de console/erro roda **dentro da página**
(`Page.addScriptToEvaluateOnNewDocument` → `window.__browsin`). Cada invocação do CLI é um
processo curto que ataca a mesma aba e drena o buffer — não existe processo de fundo guardando
estado, e o que o CDP zera ao desconectar (viewport, coletor) é restaurado no attach a partir de
`/tmp/browsin/state.json`.

**Uma resolução de seletor para todos os comandos.** `text=`, shadow DOM e iframe vivem num só
helper injetado (`window.__bq`), que devolve também o **offset do frame** — é o que faz um clique
por coordenada acertar um botão dentro de um iframe. Comando novo herda tudo isso de graça.

## Testes

```bash
test/suite.sh     # 56 casos, incluindo os que só quebram em documento real
```

A bateria cobre console/rede/recurso, snapshot, os quatro modos de `snap`, PDF paginado, diálogo
`confirm()`, select, upload, download de blob, drag em canvas, shadow DOM, iframe, e todos os
caminhos de erro. Rode antes de mexer em qualquer coisa.

## Armadilhas

- **Esperar é a parte difícil, não capturar.** Num SPA, sem `--wait` você fotografa o `#root`
  vazio. `check` avisa (`body renders no text`), mas o conserto é o `--wait`.
- **Perfil descartável = deslogado.** Todo app cai na tela de login. É a feature. Para portal
  logado, `browsin login <url>` abre uma janela visível uma vez; o cookie fica no perfil do
  browsin e todo comando headless depois herda.
- **`viewport --dpr` ≠ `snap --dpr`.** O primeiro é o `devicePixelRatio` que a *página* vê (media
  query, `srcset`); o segundo é a densidade do arquivo. O CDP multiplica os dois, então o `snap`
  divide de volta — pedir 1x num viewport @2x não pode render imagem 4x.
- **`logs` drena.** Ler duas vezes não repete. E qualquer comando que age (`click`, `key`, `type`)
  também drena ao reportar.
- **`--clip 'text=…'` pega o menor elemento que contém o texto**, quase sempre menor do que a
  caixa que você quer fotografar. Para print, prefira um seletor CSS do container, ou `--pad`.
- **Descendente não atravessa shadow boundary.** Use o seletor como ele é *dentro* do componente
  (`#shadowbtn`), não um caminho pelo host (`my-widget button`).
- **iframe cross-origin é invisível.** O piercing só alcança `contentDocument` acessível.
- **Chromium só.** Bug de Safari/WebKit ou Firefox não aparece aqui.
- **`state.json` pode sumir com o browser vivo** (`/tmp` limpo, dois `BROWSIN_DIR`). Nesse caso o
  `down` mata pelo dono da porta, e o `status` diz `adopted from the port`. Antes disso o headless
  shell ficava imortal.

## Licença

MIT — veja [LICENSE](LICENSE).
