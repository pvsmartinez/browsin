---
name: browsin
description: Ver e manipular página web pelo terminal com o browsin — screenshot, PDF, DOM, console, rede, clique, upload e download num Chromium headless de perfil descartável. Use sempre que a tarefa precisar de feedback visual (dev server, protótipo, proposta, slide, landing), de inspeção de DOM/erro de console, ou de dirigir uma interface.
---

# browsin

CLI de browser headless para agente de código. Node puro, **zero dependência**, sobe um
`chrome-headless-shell` com perfil descartável em `/tmp/browsin/<sessão>`. Uma sessão por agente:
dentro do pi isso é automático (`PI_SESSION_ID`), então dois agentes não dividem a mesma aba. (Quem
já passa um `BROWSIN_DIR` — o kit do pi — é dono do namespace e fica na sessão `default`, no layout
plano.)

Se `browsin` não está no PATH, a instalação é `scripts/setup.sh` no checkout do
[browsin](https://github.com/pvsmartinez/browsin). `browsin doctor` diz o que está em jogo.

**Não toca no Chrome do usuário.** O headless shell não tem camada de UI: não aparece na tela dele,
não vê cookie dele, não abre janela. É o motivo de a ferramenta existir.

## Comece pelo texto, não pelo pixel

Esta é a regra que mais economiza no dia a dia:

```bash
browsin check localhost:5173 --wait 'document.querySelector("#root")?.children.length > 0'
browsin snapshot        # a tela inteira em ~250 tokens, com seletores acionáveis
```

`snapshot` responde "o que tem na tela?" listando cada controle com um seletor que `click` e
`type` aceitam de volta. Um screenshot custa ~1500 tokens e responde pior — **peça pixel só
quando a pergunta for estética** (espaçamento, cor, alinhamento, "está feio?").

`snap` sai em **1x e no viewport** por default de propósito: `2560x1600` custa 8x mais token que
`1280x800`. Use `--clip '<seletor CSS>'` para recortar só o componente em discussão.

## Comandos

```bash
# navegar e diagnosticar
browsin check <url|arquivo>      # navega + problemas + rede + print, uma chamada
browsin open <url|arquivo> · browsin reload [--hard] · browsin back
browsin logs [--all]             # console, exceção, rejection, 4xx/5xx, recurso que falhou
browsin network [url]            # toda request com status, no nível do protocolo

# entender
browsin snapshot [--onscreen] [--limit N]
browsin dom <seletor> [--nth N] [--html N]
browsin text [seletor] [--limit N] [--nth N]   # innerText normalizado — leia a página sem pixel
browsin js '<expr>'

# capturar
browsin snap [--clip SEL] [--pad px] [--full] [--jpeg] [--dpr N] [--name X]
browsin pdf [url] [--format a4|a3|letter] [--landscape] [--css-page-size] [--margin in]
browsin record start [--name X] [--fps N] [--quality N] [--max-seconds N]
browsin record status
browsin record stop [-o saida.gif|saida.mp4] [--width N] [--max-gap s] [--keep-frames]
browsin record cancel

# agir
browsin click <sel> · hover <sel> · type <sel> <texto> [--enter] [--append]
browsin key <Enter|Tab|Escape|ArrowDown|…> [--mod cmd,shift] [--on SEL]
browsin select <sel> <valor|rótulo> · upload <sel> <arquivo…> · download <sel>
browsin drag <de> <para> | browsin drag <sel> --by dx,dy [--steps N]
browsin scroll <y|top|bottom|seletor>

# gerir
browsin viewport [1280x800|iphone|ipad|desktop|wide] [--dpr N] [--mobile]
browsin login [url] [--note "motivo"]  # janela visível, para autenticar à mão uma vez;
                               # com --note, abre intersticial explicando o porquê
browsin status · browsin doctor · browsin gc · browsin down [--fresh|--all]
```

Seletor aceita **CSS** ou **`text=Entrar`** (o que o usuário lê — melhor que adivinhar sopa de
classe Tailwind). Os dois atravessam **shadow DOM** e **iframe same-origin**.

## Receitas

```bash
# app React/Vite: espere o mount, senão você fotografa a tela branca
browsin check localhost:5173 --wait 'document.querySelector("#root")?.children.length > 0'

# preencher e submeter formulário (os seletores vêm do snapshot)
browsin type 'input[type="email"]' alguem@exemplo.com
browsin type 'input[type="password"]' segredo
browsin key Enter --on 'input[type="password"]' --wait 'location.pathname !== "/"'

# documento HTML virando PDF, honrando o @page do próprio documento
browsin pdf ./out/documento.html --css-page-size --margin 0 -o documento.pdf

# quebrou no celular?
browsin viewport iphone && browsin check localhost:5173

# captura precisa: posição, aba certa, print limpo
browsin viewport wide && browsin scroll 1650 && browsin click 'text=Recursos' && browsin snap --name hero

# conferir que um fluxo funciona de ponta a ponta
browsin click 'text=Exemplo' --wait 'document.querySelectorAll("svg rect").length > 3'
browsin download 'text=Baixar'

# ler a página como texto (barato em tokens; shadow DOM e iframe same-origin funcionam)
browsin text                          # body inteiro, cap de 2000 chars
browsin text 'main article' --limit 400
browsin text '.card' --nth 1          # desempata seletor que casa com vários

# um componente só
browsin snap --clip '[data-testid="card"]' --pad 16

# demonstração animada sem mandar uma sequência de screenshots ao modelo
browsin record start --name fluxo --fps 12
browsin click 'text=Começar'
browsin type 'input[name="message"]' 'Hello!'
browsin key Enter --on 'input[name="message"]' --wait 'document.querySelector(".reply")'
browsin record stop -o out/fluxo.gif --width 960
```

## Login de verdade (portal que exige conta)

O perfil é descartável, mas é **em disco** — não na janela. Isso é o que faz o fluxo abaixo
funcionar, e é o que os agentes costumam desconfiar sem razão:

1. A tarefa cai numa tela de login. **Não preencha credenciais via `type`** e não peça senha no
   chat — diga ao usuário, numa frase, por que precisa da janela ("preciso que você autentique
   no painel X, vou abrir a janela do browsin").
2. Abra a janela **visível** para o usuário autenticar:

   ```bash
   browsin login https://app.exemplo.com --note "Preciso que você autentique no painel X para eu continuar a tarefa."
   ```

   Com `--note`, a janela abre primeiro numa **intersticial** simples ("browsin login" + o
   motivo + botão "Continue to <url>"); o usuário clica e cai na tela de login. Sem URL
   passada, a intersticial pede pra fechar a janela ao terminar. Use quando o agente roda sem
   o usuário estar esperando uma janela surgir na tela.

3. **Espere a confirmação do usuário.** Você não vê a janela dele (é headed, não headless);
   não tente adivinhar que ele terminou — pergunte. Fechar a janela não desloga nada.
4. Siga headless normalmente. O próximo comando relança o browser no **mesmo perfil** e já
   entra autenticado:

   ```bash
   browsin check https://app.exemplo.com/painel
   ```

Os cookies ficam no perfil do browsin até `down --fresh`; `down` comum, `gc` e o TTL de sessão
ociosa não os tocam. Se `doctor` mostrar `login unavailable`, a instalação foi `--shell-only`
(sem camada de UI) — rode `scripts/install-browsers.sh` para ter o chromium headed.

## Gravação e orçamento de contexto

`record` não filma o tempo de parede: captura um keyframe inicial e outro ao fim de cada comando
visual. Assim a pausa do agente entre `click` e `type` não vira vídeo; `--max-gap` limita cada
intervalo a 1 segundo por default. O resultado é arquivo + sidecar JSON, nunca frames no output.
Prefira isso quando o entregável for uma demonstração animada. Não leia cada JPEG nem o GIF de
volta na conversa; valide duração/frames com `ffprobe` e só peça pixel de um frame específico se
houver uma dúvida estética. `record stop` requer `ffmpeg`; `record cancel` e `down` descartam uma
gravação ativa.

## Armadilhas

- **Esperar é o problema difícil, não capturar.** Sem `--wait` num SPA você fotografa o `#root`
  vazio. `check` avisa (`body renders no text — app may not have mounted`), mas o `--wait` é o
  conserto.
- **Seletor não casou? O erro ensina.** `no match` vem com dica: zero match sugere endereçar
  pelo que o usuário lê (`click 'text=Entrar'`); múltiplos matches dizem quantos e apontam
  `--nth N` (0-based). Prefira `text=` a adivinhar classe gerada por framework.
- **`text` normaliza whitespace** (linhas em branco somem) e trunca em 2000 chars por default
  (`--limit N` para mais/menos) — é proposital: ler página custa tokens.
- **Portal logado tem receita própria.** Veja "Login de verdade" acima: `browsin login <url>`
  abre uma janela **visível** para o usuário autenticar à mão, uma vez; o cookie fica no perfil
  do browsin (em disco) e todo comando headless depois herda. Nunca peça as credenciais do
  usuário, nem as digite via `type`, nem as procure em arquivo do projeto.
- **`viewport --dpr` ≠ `snap --dpr`.** O primeiro é o `devicePixelRatio` que a *página* vê (media
  query, `srcset`); o segundo é a densidade do arquivo de saída.
- **`logs` drena** — ler duas vezes não repete. `click`/`key`/`type` também drenam ao reportar.
- **`--clip 'text=…'` pega o menor elemento com aquele texto**, quase sempre menor que a caixa que
  você queria. Para print, use seletor CSS do container (ou `--pad`).
- **Shadow DOM: descendente não atravessa a fronteira.** Use o seletor de dentro do componente
  (`#shadowbtn`), não `my-widget button`.
- **iframe cross-origin é invisível**; same-origin funciona, com offset de coordenada correto.
- **`browsin down` ao terminar** — senão o Chromium fica de pé (~150 MB). Se outra IA trabalha em
  paralelo, `down` mata só a *sua* sessão; `down --all --fresh` limpa tudo. Sessão ociosa por mais
  de uma hora é ceifada sozinha. `down` também cancela a gravação ativa; rode `record stop` antes
  dele se quiser preservar o GIF/MP4.
- **Uma sessão, um browser.** Dentro do pi cada sessão e cada run de subagente ganha a sua
  (`PI_SESSION_ID`), então agentes paralelos não brigam pela mesma aba. Fora do pi — codex, Claude
  Code, shell — a sessão vem da aba do terminal (`TERM_SESSION_ID`); para separar dois fluxos na
  mesma aba, `BROWSIN_SESSION=nome`. `browsin status` mostra a sua e as outras vivas; `browsin gc`
  mostra e força a coleta.
- **Binário faltando é `scripts/install-browsers.sh`**, não `npm install`. `browsin doctor` mostra
  qual está em jogo e grita se caiu no fallback para o Chrome do sistema.
- **Chromium só.** Bug de Safari/WebKit ou Firefox não aparece aqui.
- **Antes de mexer no browsin**, rode `test/suite.sh` (121 casos).
