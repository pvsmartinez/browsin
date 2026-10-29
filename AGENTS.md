# AGENTS.md — browsin

CLI de browser headless para agente de código. **Leia `skills/browsin/SKILL.md` antes de usar ou de
mexer** — ela tem os comandos, as receitas e as armadilhas.

- Código: `bin/browsin` (CLI), `src/` — `cdp` (cliente WebSocket), `browser` (lançar/adotar/matar),
  `gc` (ceifa sessões mortas/ociosas), `collector` (console/erro dentro da página), `query`
  (seletores + snapshot), `commands`, `paths`.
- Node puro, **zero dependência** — não adicione nenhuma. O `WebSocket` global do Node 22+ é a
  única coisa que um cliente CDP precisa, e o valor da ferramenta é justamente não pesar.
- **Uma sessão, um browser.** `BROWSIN_SESSION` > `PI_SESSION_ID` > `TERM_SESSION_ID` > `default`
  escolhe o namespace; cada um tem `profile`, `state.json`, `shots/` e uma porta próprios (9377 +
  hash, com salto se colidir). A `default` fica no layout plano (`BROWSIN_DIR/profile`), porque um `BROWSIN_DIR`
  explícito já é namespace do chamador — o kit do pi isola cada run assim, e a limpeza dele lê
  `<dir>/state.json`. Foi o que tirou duas IAs do mesmo browser: antes eram porta fixa, aba única e
  `state.json` compartilhado. O `gc` roda no topo de `launch` e o TTL (60 min) é o preço de não
  vazar memória. **Nunca aponte para o perfil real do Chrome do usuário** — é o motivo de a
  ferramenta existir.
- O `state.json` é uma dica, não a verdade: ele pode desaparecer com o browser vivo. Quem sabe
  quem está de pé é a porta (`portOwner()` em `src/browser.mjs`) e a varredura `ps` por
  `--user-data-dir` (`browsersOnDisk()`, em `src/gc.mjs`). Já custou um headless shell imortal uma
  vez, e o órfão sem `state.json` tem caso próprio na suíte.
- **Idade de sessão = `lastUsed` do state, ou o mtime do diretório quando o state sumiu.** Sem o
  fallback, o `down` (que apaga o `state.json`) tornava o perfil de ~200 MB invisível ao coletor.
  A `default` só é coletada pelo `gc` de outra sessão — `own` nunca é tocada.
- **Um comando por vez, por sessão.** `src/lock.mjs` é um lock cross-process por sessão; `launch`
  o adquire e o segura até o processo sair. Sem ele, dois comandos concorrentes a frio subiam dois
  browsers no mesmo perfil/porta (e o `down` deixava um órfão), e um comando lia a página do outro.
  `status`/`doctor`/`gc`/`down` nunca pegam o lock — inspecionar/resetar não pode esperar.
- **O gc só roda em invocação — por isso existe o janitor.** `src/janitor.mjs` é um processo Node
  destacado que `launch` cria: um por base (lock com pid do dono em `.janitor-lock`, dono morto é
  roubado), repete o **mesmo** `gc` no timer (≤ 10 min, `BROWSIN_JANITOR_INTERVAL_S`) e sai quando
  nenhuma sessão tem browser vivo. É a rede para browser cujo harness (run do pi, sessão Claude)
  morreu sem rodar `gc` de novo. Ele protege sessão com lock de comando vivo (`protect` no gc) e
  **revalida o lock no ponto de matar** (adquire o lock da sessão sem bloquear; quem o segurou
  depois do snapshot é poupado — sem isso um comando que começou entre snapshot e ceifa perdia o
  browser). Antes de qualquer `terminate` (também no `gc`), o pid tem que se provar no ps como
  browser do perfil da sessão (`--user-data-dir` exato + mesmo uid; ps falhou = poupado, nunca
  matar às cegas) — `state.pid` é dica e pode ter sido reutilizado por processo alheio. Nunca toca
  em processo de outro usuário (ps filtra por uid, timeout de 5s) e desliga com `BROWSIN_JANITOR=off`.
  Não instale nada global por ele — por design ele nasce do launch e morre sozinho.
- **Abas e o leak cross-base.** `tabs` (list/use/close/auto) fixa `state.targetId`, lido por
  `pageTarget`; sem pin, segue a primeira aba. `gc` também varre bases irmãos `browsin*` (dirs
  por-run do kit, testes) e mata browser órfão sem state — sem apagar arquivos alheios
  (`BROWSIN_ORPHAN_GRACE_S` dá a carência, default 300s).
- **Rode `test/suite.sh` (147 casos) antes de dar qualquer mudança por pronta.** Ele cobre os
  buracos que já morderam: escala dobrada de `--dpr`, `confirm()` que trava a página, offset de
  coordenada dentro de iframe, download de blob, PDF paginado, e sessões concorrentes (isolamento,
  `gc`, órfão, cap, `down --all`).
- A suíte é **autocontida e hermética**: cada página que um caso precisa está em `test/fixtures/`,
  e ela roda num `BROWSIN_DIR` temporário — `down`/`down --all`/`gc` nunca tocam no browser vivo de
  outro agente. O janitor roda desligado na suíte (`BROWSIN_JANITOR=off`: um gc em segundo plano
  entre passos corromperia os casos que preparam órfão/ociosa à mão — a seção própria do janitor
  reativa por caso). Não introduza caso que dependa de arquivo fora do repo — ele passa só na
  máquina de quem escreveu.
- Comando ou flag novo: atualize `README.md`, `skills/browsin/SKILL.md` **e** a suíte. Ferramenta
  sem skill em dia não é chamada por ninguém.
- Os binários são do browsin: `~/Library/Caches/browsin/{headless-shell,chromium}` (ou
  `$XDG_CACHE_HOME/browsin` fora do macOS), baixados do CDN Chrome-for-Testing por
  `scripts/install-browsers.sh` — sem npm, sem Playwright. `BROWSIN_BROWSERS` aponta para outra
  pasta: é assim que a instalação limpa é testada sem mexer na oficial.
- **Nunca deixe o fallback silencioso.** Sem instalação o browsin usa o Chrome do sistema como
  último recurso; o `doctor` tem que gritar, senão instalação quebrada passa por sucesso.
- macOS é a plataforma que o instalador cobre. Em Linux o CLI funciona, mas via `BROWSIN_CHROME` /
  `BROWSIN_BROWSERS` apontados à mão — não é caminho testado; não prometa que é.
