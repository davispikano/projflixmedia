# Mediaflix

App de desktop estilo Netflix para gerenciar e assistir filmes e séries que você já tem no PC. Reproduz no **VLC** e salva onde você parou de forma confiável.

## Funcionalidades (v0.1)

- **Adicionar séries por pasta**: cada subpasta com vídeos vira uma série; vídeos soltos viram filmes.
- **Banner**: a primeira imagem da pasta (`banner.jpg`, `fanart.png`, `poster.webp`, etc.) é usada como capa e hero.
- **Interface estilo Netflix**: hero assimétrico, linhas horizontais (Continuar assistindo, Séries, Filmes), tela de detalhes com lista de episódios.
- **Reprodução no VLC**: abre o arquivo direto no VLC.
- **Salvar progresso**: o app conversa com a interface HTTP do VLC para salvar a posição a cada 4s e retomar exatamente de onde você parou (mais confiável que o "save position" nativo).

## Pré-requisitos

- **Windows**
- **Node.js 18+** (para rodar em modo dev)
- **VLC media player** instalado (auto-detectado em `Program Files\VideoLAN\VLC\vlc.exe`). Caminho customizável em **Pastas → Definir caminho do VLC**.

## Instalação

```powershell
cd C:\Users\Dave\Desktop\mediaflix
npm install
npm start
```

## Build (instalador Windows)

```powershell
npm run build
```

Gera um instalador NSIS em `dist/`.

## Como organizar suas pastas

Aponte a app para uma pasta-mãe, por exemplo `D:\Midia`:

```
D:\Midia\
  Breaking Bad\
    banner.jpg              <- capa (opcional)
    S01E01.mkv
    S01E02.mkv
    ...
  Interestelar.mp4          <- vira "filme"
  Duna\
    poster.webp
    Duna.mkv                <- pasta com 1 vídeo também vira filme
```

## Como o progresso é salvo

Ao reproduzir, o Mediaflix lança o VLC com a interface HTTP ativada (`--extraintf=http`, porta `9090`, senha `mediaflix`). A cada 4 segundos consulta `time` e `length` e salva em `progress.json` no diretório de dados do app (`%APPDATA%\mediaflix\`). Se você fechar o VLC abruptamente, o último ponto salvo é usado para retomar.

## Atalhos

- `Esc` fecha a tela de detalhes da série.
- Clique em qualquer episódio para tocar direto.

## Limitações conhecidas

- Apenas Windows nesta primeira versão (caminhos e detecção do VLC).
- Sem download automático de metadados/banners — coloque uma imagem dentro da pasta da série.
- Cada arquivo de mídia tem sua posição salva individualmente; o "próximo episódio" considera o último episódio assistido.
