---
area: context-maps-hook
covers:
  - "scripts/context-maps.mjs"
  - "scripts/explain.mjs"
  - "scripts/context-docs.mjs"
  - "scripts/lib/documentation.mjs"
  - "scripts/lib/source-fingerprints.mjs"
  - "scripts/lib/auto-review-state.mjs"
  - "scripts/lib/auto-review-candidates.mjs"
  - "scripts/lib/session-write-journal.mjs"
  - "scripts/lib/roots.mjs"
  - "scripts/lib/md-hint.mjs"
  - "scripts/handoff.mjs"
  - "scripts/codex-hook.mjs"
  - "scripts/lib/i18n.mjs"
  - "scripts/lib/markdown-sections.mjs"
  - "install.mjs"
  - "install-codex.mjs"
  - ".claude/.gitignore"
  - "hooks/codex-hooks.json"
  - "scripts/lib/state-store.mjs"
  - "scripts/lib/review-findings.mjs"
  - "scripts/lib/review-engine.mjs"
  - "scripts/lib/review-metadata.mjs"
  - "scripts/lib/document-dependencies.mjs"
  - "scripts/review.mjs"
  - "scripts/tracked-edit.mjs"
  - "scripts/lib/setup-engine.mjs"
  - "scripts/lib/setup-targets.mjs"
verified_at: HEAD
verified_date: 2026-10-07
source_fingerprints: {"hooks/codex-hooks.json":"sha256:cd434b2c41b1c647f3587f6bd83f874653889cda5fc263c39a9714ab146720de","scripts/codex-hook.mjs":"sha256:5ff736bffd03260406c4453e0a477c5cc195b355998cedb181d0453107567383","scripts/context-maps.mjs":"sha256:1091311ead045ba6670529e1acc24e1a12ee5215cd1753c8ffb81f8d3f1f0cd3","scripts/lib/auto-review-state.mjs":"sha256:6a831cf5c976ce2380e277bda08e9d6398c65b106ebe36731a0c88badb24a4d6","scripts/lib/session-write-journal.mjs":"sha256:1f0a91563bf4562019affc01058071547b6b98c10f014e201e1416fee16f282a","scripts/explain.mjs":"sha256:d03095b179c2a791280bd441f21a2713ad70a4f83a1fb1194db635566bdcc88d","scripts/context-docs.mjs":"sha256:e18cae22d25afdd37ab058f476d802b06fe6e7ef63d28cecbf9040a488ebc35f","scripts/lib/documentation.mjs":"sha256:e436eb9dc4f350d4ca55d719530959635a2a40aed268abb8f2a3c730ccf4831c","scripts/lib/source-fingerprints.mjs":"sha256:b274b3be934e68b20b02ddba3b58c8e22e2880c0d20fd5f8c9bf2c18ba749189","scripts/lib/auto-review-candidates.mjs":"sha256:fdaa3864fcf5e5e90e7d8ed9af0508ef6754b2008149184f5db51b31723ae425","scripts/lib/md-hint.mjs":"sha256:266614609b0ca3619ab6421e16846ead169dbb1b3c4c161afa8ebc2f69161d5f","scripts/lib/i18n.mjs":"sha256:17dc499f2525e1a5e3c84bf86b02289816d6b309c442e12846a2c4bfeaeb6e2b","install-codex.mjs":"sha256:a3905a544b3c63b17b735841c278ba32704020ba4b28f319978f3e9b3ff8820b","scripts/lib/state-store.mjs":"sha256:a212a2d921648dd44e00ad3fd29d56f63dc54ccbf0ed895b795a9aa8dea4ac79","scripts/lib/review-findings.mjs":"sha256:72996581beb530a6add204b93e1c3db680ba81e77abd0decf102f700c7df6922","scripts/lib/review-engine.mjs":"sha256:2bf245816b6636b8f19f9d792911e746ffd9762fe849e69a886b80afb73139f4","scripts/lib/review-metadata.mjs":"sha256:6d5e900dee4f3b75dc58ce168610b50546e74888d562f98177f794c86eaf71d7","scripts/lib/document-dependencies.mjs":"sha256:d8e1242afd84aa2ede52d34ea14114fc5f871bbf380b26da1c06f96910aca7e8","scripts/review.mjs":"sha256:e065dcde42efbba6e64d7f917099781c9fa95add9316387066c1327e3a905f0d","scripts/tracked-edit.mjs":"sha256:dd0abf684167e81287c044e0cb77dade928b8598c7d5d911e6fc460a4b0a53f2","scripts/lib/setup-engine.mjs":"sha256:02742aa7a90b18b8252b090f2de473ead1e5ef1ab562e1cedf987c22a5e7a612","scripts/lib/setup-targets.mjs":"sha256:8beca8cef61812e1bc475176d620ded59481aa42eea10071084493840389f855"}
source_digest: sha256:7b6fea79ec66e13b37ef0b3d7491703ad5c1763d35a96a2f3db7233e2b7a1740
---

# Mapas e manutenção documental — mapa de área

## Entradas

- `hooks/codex-hooks.json` registra SessionStart, Pre/PostToolUse, UserPromptSubmit e Stop.
  Codex global usa o adaptador e scripts do plugin; standalone é uma instalação explícita.
- `scripts/codex-hook.mjs` normaliza cwd, host, session_id e turn_id. Preflight e Stop de
  documentação executam no mesmo processo. Outros contratos CLI continuam em subprocesso.
- `scripts/context-docs.mjs --stop-report` usa o mesmo review-engine no Codex. Claude preserva
  seu relatório legado e baseline. O núcleo nunca inventa fatos documentais.
- `scripts/context-maps.mjs` lê covers/frontmatter; relatório global e SessionStart verificam
  hashes, com Git/mtime para mapas legados. Stop Codex não infere autoria desses sinais.

## Atribuição e ciclo de revisão

- `lib/session-write-journal.mjs`: ledger compartilhado por projeto, último autor confirmado,
  sequência, época de abertura e turno. Pre captura os alvos; Post confirma resultado e bytes.
  Eventos duplicados são idempotentes. Ferramentas sobrepostas ou sem Pre não certificam autoria.
- SessionStart inicia outra época. Stop compara somente o turno e as versões ainda atribuídas à
  sessão. Reverts não recuperam autoria de chats antigos. Fontes com ferramenta em andamento
  não são selecionadas. Consumo por sequência encerra o escopo do turno sem apagar o histórico.
- `tracked-edit.mjs` permite Bash declarativo: manifest --file=PATH produz um token, usado pelo
  wrapper antes de executar o comando sem shell intermediário. Todos os alvos devem ser declarados.
  Bash comum e edições externas continuam fora da atribuição automática; consulte saúde/auditoria.
- `safeEditTarget` aceita raiz e extraRepos configurados, revalida symlinks e arquivos removidos.
  Limites: 64 MiB por fonte, 128 MiB por evento, 256 MiB por verificação Stop, 30.000 autores,
  4.000 eventos e retenção de 90 dias. Limites/estado inválido ficam visíveis no diagnóstico.
- `lib/review-engine.mjs` sai antes de carregar referências quando não há fontes atribuídas nem
  continuação própria pendente. Filtra coletores por interseção antes de hashing e compartilha
  createFingerprintCache. Nunca seleciona backlog global para iniciar trabalho em outro chat.
- `lib/review-findings.mjs` identifica documento/área e versão das referências atuais. Lotes,
  texto do prompt e ordem não definem a identidade. Cobertura sem documento é uma fonte por item.
- `lib/auto-review-state.mjs` mantém ready/claimed/deferred/complete, com claim exclusivo por
  revisão. A tentativa guarda suas próprias chaves de fonte; acréscimos de outra sessão não
  ampliam a confirmação automática. Novas versões reabrem trabalho; relatório vazio não conclui.
- Uma continuação por turno. Itens não confirmados ficam deferred. Lease de 30 minutos só
  registra abandono; não agenda LLM nem prompt. Fila limitada a 300 itens; overflow é diagnóstico.
  Claims opacos antigos são migrados sem presumir conclusão. Estado contém caminhos/hashes locais,
  nunca conteúdo-fonte ou texto de prompt.
- `review.mjs status|show|ack|defer|retry`: ack exige id, revisão exata e --reviewed depois de
  inspeção; --source permite confirmação parcial. Retry manual atualiza o manifesto do documento.
  Deferred não repete prompt; evidência explícita atual pode concluir uma revisão de outro chat.

## Documentos e escrita mecânica

- `lib/documentation.mjs` identifica documentos live/historical/manual. Decisões são históricas
  por padrão; demais documentos operacionais são live. Mera menção a fonte num incidente passado
  não aciona revisão automática. review_sources declara as referências atuais explicitamente.
- `lib/document-dependencies.mjs` aceita review_dependencies com rótulos exatos do outline;
  todas as referências devem ser representadas. dependency_fingerprints registram esses spans
  após inspeção. Escopos inválidos, ambíguos ou sem parser voltam ao arquivo inteiro e geram issue.
  Isso é um contrato do autor, não análise completa de dependências semânticas.
- `lib/review-metadata.mjs` usa documento e referências atuais, valida o manifesto, atualiza
  apenas chaves conferidas e revalida fontes/documento antes de rename atômico. Preserva encoding,
  BOM, quebras de linha, texto factual e fingerprints de fontes não conferidas. Exemplos cercados
  de código não viram metadados. Campos duplicados/encoding não preservável recusam gravação.
- source_digest só muda com fingerprints completos de todas as referências atuais. Digest
  divergente com fingerprints já completos é sincronizado offline, sem LLM nem data nova.
  Revisão parcial preserva verified_at e digest agregados quando as fontes restantes são stale.
- `lib/state-store.mjs` serializa read/modify/write com lock exclusivo, token, PID e arquivo
  temporário único. Não toma lock de processo vivo; erro de JSON/limite/lock não vira sucesso.
  Telemetria, candidatos, fingerprints, journal e fila usam essa transação compartilhada.
- Hash confirma igualdade de bytes, não correção semântica. Datas ou salvar o Markdown não
  certificam fontes Codex. Conteúdo factual precisa ser investigado pelo agente.

## Instalação, preflight e outros hosts

- `install-codex.mjs --mode=global` inicializa config/ignore/marker e remove apenas hooks locais
  reconhecidos do context-tools. Não copia skill/scripts; preserva hooks de outros caminhos.
  Setup Codex usa esse modo. Status distingue standalone/global e não confunde enabled com trust.
- `skills/context-tools/SKILL.md` usa os scripts globais diretamente e não recria standalone.
  Uma skill local antiga pode ocultar a global; o diagnóstico pede conferência antes da remoção.
- SessionStart Codex mostra um índice neutro de frescor, sem instruir revisão do backlog.
  Avisos do snapshot legado não representam integridade do journal Codex.
- `contextMapsPromptAudit` verifica offline arquivos explicitamente citados, sem guardar prompt
  nem chamar rede/modelo. Uma fonte fresca não é acusada pela mudança de irmão do mesmo mapa.
- `health.mjs` mostra o backlog global e erros de verificação, independente do escopo automático.
  `explain.mjs` expõe atribuição e pendências locais para um arquivo, sem certificar semântica.
- `roots.mjs` preserva os modos plugin/standalone/avulso, estado separado por host, projetos
  sem Git e extraRepos curados. Claude mantém baseline/git/mtime anteriores; Codex usa o journal.
- `md-hint.mjs` compartilha codecs UTF-8, BOM, Windows-1252 e UTF-16 e hints idempotentes.
  Handoff continua priorizando fingerprint individual; Git/digest são compatibilidade legada.

## Verificação

`tests/review-lifecycle.test.mjs` cobre 20 sessões, versões, reverts, sobreposição, manifesto Bash,
extraRepos, revisão parcial, confirmação atrasada, fila concorrente, encoding e caminho sem hashing.
Fixtures antigas de Stop Codex agora registram eventos reais Pre/Post; o snapshot não é atalho de autoria.
A matriz CI existente usa Linux/macOS/Windows e Node 18/22; execução local Windows não prova todos eles.
