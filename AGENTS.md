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
- **Abas e o leak cross-base.** `tabs` (list/use/close/auto) fixa `state.targetId`, lido por
  `pageTarget`; sem pin, segue a primeira aba. `gc` também varre bases irmãos `browsin*` (dirs
  por-run do kit, testes) e mata browser órfão sem state — sem apagar arquivos alheios
  (`BROWSIN_ORPHAN_GRACE_S` dá a carência, default 300s).
- **Rode `test/suite.sh` (138 casos) antes de dar qualquer mudança por pronta.** Ele cobre os
  buracos que já morderam: escala dobrada de `--dpr`, `confirm()` que trava a página, offset de
  coordenada dentro de iframe, download de blob, PDF paginado, e sessões concorrentes (isolamento,
  `gc`, órfão, cap, `down --all`).
- A suíte é **autocontida e hermética**: cada página que um caso precisa está em `test/fixtures/`,
  e ela roda num `BROWSIN_DIR` temporário — `down`/`down --all`/`gc` nunca tocam no browser vivo de
  outro agente. Não introduza caso que dependa de arquivo fora do repo — ele passa só na máquina
  de quem escreveu.
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
