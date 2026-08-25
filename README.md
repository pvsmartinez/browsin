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

Um agente que mexe em interface precisa ver o que fez. As duas opções prontas cobravam caro
pela coisa errada:

- **Playwright MCP** — 985 MB de Chromium em cache, `npx -y` a cada sessão, 25 tools ocupando
  contexto o tempo todo, e uma janela real abrindo na tela.
- **browser-harness** — dirige o Chrome *real*, com as contas reais do usuário logadas. Certo
  quando o valor da tarefa **é** a sessão dele; errado para "tira um print do meu dev server".

O browsin fica no meio: um `chrome-headless-shell` (sem camada de UI — fisicamente incapaz de
aparecer na tela) com perfil descartável em `/tmp/browsin`, dirigido por CDP cru. 146 MB de RAM,
~700 ms do nada até o PNG.

## Instalação

Node 22+ (o `WebSocket` global é a única coisa que um cliente CDP precisa) e os dois binários, que
o browsin baixa direto do CDN Chrome-for-Testing do Google — sem npm, sem Playwright, sem Homebrew:

```bash
scripts/install-browsers.sh               # ~550 MB em ~/Library/Caches/browsin
scripts/install-browsers.sh --shell-only  # ~195 MB, abre mão do `login`
ln -sf "$PWD/bin/browsin" ~/.local/bin/browsin
```

| | onde | pra quê |
|---|---|---|
| `headless-shell` | `~/Library/Caches/browsin/headless-shell` | o default. Sem camada de UI: **não consegue** aparecer na tela |
| `chromium` | `~/Library/Caches/browsin/chromium` | só o `login`, que precisa de janela de verdade |

`browsin doctor` diz qual binário está em jogo. Faltando instalação, o browsin cai no
`/Applications/Google Chrome.app` como **último recurso** — sempre no perfil descartável, nunca no
do usuário — e o `doctor` grita, porque fallback silencioso parece que funcionou.

Atualizar: `scripts/install-browsers.sh --force`, e depois `test/suite.sh` — a renderização muda
entre versões do Chrome. `BROWSIN_BROWSERS=<dir>` aponta para outra instalação (é assim que a
instalação limpa é testada sem tocar na oficial).

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
- **Chromium só.** Bug de Safari/WebKit não aparece aqui — e não existe mais Playwright no
  workspace para cobrir isso. Se precisar, é instalar na hora.
