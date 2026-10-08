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
verified_at: ce96046
verified_date: 2026-10-08
source_fingerprints: {"scripts/context-maps.mjs":"sha256:1091311ead045ba6670529e1acc24e1a12ee5215cd1753c8ffb81f8d3f1f0cd3","scripts/explain.mjs":"sha256:d03095b179c2a791280bd441f21a2713ad70a4f83a1fb1194db635566bdcc88d","scripts/context-docs.mjs":"sha256:e18cae22d25afdd37ab058f476d802b06fe6e7ef63d28cecbf9040a488ebc35f","scripts/lib/documentation.mjs":"sha256:e436eb9dc4f350d4ca55d719530959635a2a40aed268abb8f2a3c730ccf4831c","scripts/lib/source-fingerprints.mjs":"sha256:b274b3be934e68b20b02ddba3b58c8e22e2880c0d20fd5f8c9bf2c18ba749189","scripts/lib/auto-review-state.mjs":"sha256:6a831cf5c976ce2380e277bda08e9d6398c65b106ebe36731a0c88badb24a4d6","scripts/lib/auto-review-candidates.mjs":"sha256:fdaa3864fcf5e5e90e7d8ed9af0508ef6754b2008149184f5db51b31723ae425","scripts/lib/session-write-journal.mjs":"sha256:1f0a91563bf4562019affc01058071547b6b98c10f014e201e1416fee16f282a","scripts/lib/roots.mjs":"sha256:ad76743bf1bc41305c02a9b8eea22d9a73bc4dbe9aa445f6905589d95b87a140","scripts/lib/md-hint.mjs":"sha256:266614609b0ca3619ab6421e16846ead169dbb1b3c4c161afa8ebc2f69161d5f","scripts/handoff.mjs":"sha256:4158f232baa08315b185ed01f21401c5a705edc0aea72f35d11bbeaf6f41d871","scripts/codex-hook.mjs":"sha256:5ff736bffd03260406c4453e0a477c5cc195b355998cedb181d0453107567383","scripts/lib/i18n.mjs":"sha256:f6d9e2d94d9fe4191f528e67cb9d96988303ea503bf70b24b03f516974192e89","scripts/lib/markdown-sections.mjs":"sha256:b60eddd3861c7977c5ec59130d9774b4d901e0c44fe3bf361dfcc2c29d8b9b7b","install.mjs":"sha256:c94522ad237a53259f412b0fa9b38e003ee58f3e8fd891a4c04daa8f7473dfeb","install-codex.mjs":"sha256:a3905a544b3c63b17b735841c278ba32704020ba4b28f319978f3e9b3ff8820b",".claude/.gitignore":"sha256:e986f55f0c6e7e9d7ad39509d00aef235c20d1c234ec73b290c3f139b971a1c2","hooks/codex-hooks.json":"sha256:cd434b2c41b1c647f3587f6bd83f874653889cda5fc263c39a9714ab146720de","scripts/lib/state-store.mjs":"sha256:1a06a2da8e0ca415b4ae9d1524fad50a1f1a862cd141fd473121a3b8e090c67c","scripts/lib/review-findings.mjs":"sha256:33d4991846e0b3b123550788a3c6f894b6bace6345e0dfd0f4bd8fbb5b0a9aad","scripts/lib/review-engine.mjs":"sha256:c77e6ab09de828e89dbaab4750f78329698526812486b1ff5434d78a7e4c29ab","scripts/lib/review-metadata.mjs":"sha256:6d5e900dee4f3b75dc58ce168610b50546e74888d562f98177f794c86eaf71d7","scripts/lib/document-dependencies.mjs":"sha256:2c68296cca3ff6d877f9cfc091c597f08363bfa36544f78267595db479744069","scripts/review.mjs":"sha256:b5c9eaf65f407f9b0757637e60214696651d64268be12048c19c953e1565b7c6","scripts/tracked-edit.mjs":"sha256:568268ad9841d4849bae24acbbe022c4a43e476a87cdd16a3af7829b9ae9b72e","scripts/lib/setup-engine.mjs":"sha256:2436c2177023fbb53dde28d246a0e3c5bcc9cb12de616b71e00aa2d676afd0c6","scripts/lib/setup-targets.mjs":"sha256:128d41ff0d14a1d70612d8493021a8fa612ee81d0cf133f07253a16ce24ba84a"}
source_digest: sha256:479db2a648c8147ed423807e650121e2d6824058ac938298b918f1085c3b4dc2
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
- `.claude/.gitignore` é a fonte única da lista de estado que `install.mjs` replica no projeto de
  quem instala; `STATE_FILES_FALLBACK` (para pacote npx, que perde `.gitignore`) precisa bater com
  ela, e um teste E2E compara as duas. Inclui avisos de sessão, journal, `*.tmp` e `*.lock`.
- `setup-targets.mjs` fixa repositório (`fcoluiz/context-tools`) e marketplaces (`context-tools`
  no Claude, `context-tools-codex` no Codex). `legacyMarketplaceNames` lista os nomes anteriores à
  2.0.0; depois de configurar o marketplace, `setup-engine.mjs` só AVISA se um legado continua
  presente, com o comando de remoção — nunca remove configuração do usuário sozinho.
- Fingerprints são hash dos bytes em disco, sem normalizar fim de linha: com `autocrlf` no Windows
  o mesmo arquivo dá hash diferente do Linux/macOS, então um mapa revisado num SO pode aparecer
  defasado no outro.

## Verificação

`tests/review-lifecycle.test.mjs` cobre 20 sessões, versões, reverts, sobreposição, manifesto Bash,
extraRepos, revisão parcial, confirmação atrasada, fila concorrente, encoding e caminho sem hashing.
Fixtures antigas de Stop Codex agora registram eventos reais Pre/Post; o snapshot não é atalho de autoria.
A matriz CI existente usa Linux/macOS/Windows e Node 18/22; execução local Windows não prova todos eles.
