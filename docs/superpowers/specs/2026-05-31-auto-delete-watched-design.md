# Exclusão automática de episódios assistidos — Design

> Data: 2026-05-31 · Projeto: MediaFlix (web, `server.js` na porta 3088)
> Objetivo: economizar espaço no disco da VPS apagando automaticamente episódios
> já assistidos até o fim, **apenas quando o utilizador ativar a opção** (default OFF).

## Problema

A VPS tem pouco espaço. Hoje os ficheiros de vídeo ficam no disco para sempre,
mesmo depois de assistidos. Existe um botão manual "Apagar" por episódio, mas
nada automático. O Dave quer uma opção que, quando ligada, apague sozinha o
episódio assim que ele for assistido até o fim e o reprodutor avançar para o
próximo — libertando espaço sem ação manual.

Requisito explícito: **garantir que todo o processo de "assistir" está
realmente persistido num banco de dados antes de apagar**, para nunca apagar
algo cujo progresso não foi gravado.

## Princípios de segurança (porque a operação é irreversível)

1. **Default OFF.** A opção nasce desligada. Sem ativação, comportamento idêntico ao atual.
2. **Decisão no servidor, a partir do Mongo.** O cliente nunca decide apagar. O
   servidor relê `watch_progress` no MongoDB e só apaga se o registo confirmar
   que o episódio foi assistido. É a garantia de "salvou mesmo no banco".
3. **Só apaga ao avançar para o próximo.** O gatilho é exatamente o descrito
   pelo Dave: episódio termina → player passa para o próximo → o anterior é apagado.
   O ficheiro em reprodução nunca é apagado. O último episódio de uma série (sem
   "próximo") não é apagado automaticamente.
4. **Respeita outros perfis.** Apagar o ficheiro remove-o para todos os perfis.
   Por isso o servidor não apaga se **outro perfil estiver a meio** desse
   episódio (progresso entre 5% e 90%). Perfis que já terminaram ou que nunca
   abriram o episódio não bloqueiam.
5. **Reusa o caminho de exclusão existente** (`deleteMediaFile`), que já valida
   o path (dentro das pastas permitidas, é vídeo) e limpa `watch_progress` /
   `watch_history` de todos os perfis no Mongo.

## Definição de "assistido até o fim"

`ratio = time / length`. O servidor considera assistido quando `ratio >= 0.90`
para o perfil atual. (O auto-next já dispara nos últimos ~60s, então ao avançar
o progresso gravado fica acima de 0.90 para episódios > ~10min. Usar 0.90 em vez
de 0.95 dá margem para o último save antes da troca.)

## Arquitetura

### Config
- Nova flag `autoDeleteWatched` (boolean, default `false`).
- Persistida em `.mediaflix-data/config.json` via o endpoint `/api/config/toggle`
  existente (adicionar a chave à allow-list).
- Backfill: `if (config.autoDeleteWatched === undefined) config.autoDeleteWatched = false;`

### Endpoint novo (servidor)
`POST /api/auto-delete-check` — body `{ path, profileId }`.

Lógica:
1. Se `!config.autoDeleteWatched` → `{ deleted:false, reason:'disabled' }`.
2. Validar `path` (`safeExistingFile` + extensão de vídeo). Senão `{ deleted:false, reason:'invalid' }`.
3. Ler `watch_progress` de **todos os perfis** para esse `path` (Mongo; fallback JSON).
4. Confirmar `ratio` do perfil atual `>= 0.90`. Senão `{ deleted:false, reason:'not-finished' }`.
   → Esta é a verificação "está salvo no banco".
5. Se algum **outro** perfil tem `0.05 < ratio < 0.90` (a meio) → `{ deleted:false, reason:'in-use-by-other' }`.
6. Caso contrário, chamar `deleteMediaFile(path)` e devolver
   `{ deleted:true, deletedBytes, library }`.

Tudo server-side; nenhuma confiança no estado do cliente para decidir apagar.

### Cliente (`web-api.js`)
- Novo método `autoDeleteWatched(path)` → `POST /api/auto-delete-check`.

### Cliente (`renderer.js`)
Ao avançar para o próximo episódio (no `showAutoNextCard`, tanto no countdown
automático como no botão "Assistir agora"):
1. Guardar o path/episódio anterior (`cur.filePath`).
2. Forçar um save final de progresso do anterior marcando-o como concluído
   (`saveProgress(prevPath, length, length)`), para o Mongo ter `ratio = 1.0`.
3. Iniciar o próximo episódio (`playFile(next...)`).
4. Chamar `window.api.autoDeleteWatched(prevPath)` (best-effort, sem bloquear).
   Se devolver `deleted:true`, atualizar `state.library` e mostrar um toast
   discreto: "Episódio assistido apagado · X liberados".

### UI (`index.html`)
- Novo toggle em Definições: "Apagar automaticamente episódios já assistidos
  (libera espaço — irreversível)". Wire via `wireToggle('autoDeleteWatchedToggle', 'autoDeleteWatched')`.

## Fora de escopo (YAGNI)
- Apagar filmes (não há evento de "avançar"). Só episódios de série.
- Apagar o último episódio de uma temporada/série (sem "próximo").
- Lixeira / undo. A exclusão é direta, como o botão manual já existente.
- Apagar com base em tempo/idade do ficheiro.

## Testes / verificação
- `node --check` em `server.js`, `web-api.js`, `renderer.js`.
- Teste de unidade leve da função de decisão (`shouldAutoDelete`) com casos:
  disabled, not-finished, outro perfil a meio, ok.
- Smoke manual: subir o server, simular dois perfis via API de progresso e
  chamar `/api/auto-delete-check`.
