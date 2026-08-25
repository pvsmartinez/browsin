# AGENT.md — browsin

CLI de browser headless. **É a única ferramenta de browser do workspace** desde 2026-08-25 (o MCP
do Playwright e a skill `browser-harness` foram removidos). **Leia a skill `browsin` antes de usar
ou mexer** — ela tem os comandos, as receitas e as armadilhas.

- Código: `bin/browsin` (CLI), `src/` — `cdp` (cliente WebSocket), `browser` (lançar/reusar/matar),
  `collector` (console/erro dentro da página), `query` (seletores + snapshot), `commands`, `paths`.
- Node puro, **zero dependência** — não adicione nenhuma. O `WebSocket` global do Node 22+ é a
  única coisa que um cliente CDP precisa, e o valor da ferramenta é justamente não pesar.
- Estado descartável em `/tmp/browsin` (perfil, `state.json`, `shots/`, `downloads/`). Nunca aponte
  para o perfil real do Chrome do Pedro — é o motivo de a ferramenta existir.
- **Rode `test/suite.sh` (56 casos) antes de dar qualquer mudança por pronta.** Ele cobre os
  buracos que já morderam: escala dobrada de `--dpr`, `confirm()` que trava a página, offset de
  coordenada dentro de iframe, download de blob, e PDF paginado em documento real.
- Comando ou flag novo: atualize `README.md`, a skill **e** a suíte. Ferramenta sem skill em dia
  não é chamada por ninguém.
- Os binários são **nossos**: `~/Library/Caches/browsin/{headless-shell,chromium}`, baixados do CDN
  Chrome-for-Testing por `scripts/install-browsers.sh` (sem npm, sem Playwright). `BROWSIN_BROWSERS`
  aponta para outra pasta — é assim que a instalação limpa é testada sem mexer na oficial.
- **Nunca deixe o fallback silencioso.** Sem instalação o browsin usa o Chrome do Pedro como último
  recurso; o `doctor` tem que gritar, senão instalação quebrada passa por sucesso.
