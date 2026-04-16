# Snake Evolution - Multiplayer

Versao multiplayer online do classico jogo Snake, baseado no [Snake Evolution](https://callbackapi.cc/snake/). Ate **10 jogadores** simultaneos por sala competindo no modo **last-man-standing**, com suporte a bots, espectadores e salas privadas.

---

## Features

### Gameplay
- **Ate 10 cobras** na mesma partida
- **Modo last-man-standing**: a partida termina quando sobra apenas 1 cobra viva
- **3 vidas** por jogador - ao morrer, o corpo vira comida (dead food) que pode ser consumida pelos outros
- **Niveis progressivos**: a cada 200 pontos coletivos, obstaculos extras aparecem e a velocidade aumenta ligeiramente (cap em 15 ticks/s)
- **Comida ativa + dead food**: comer qualquer um aumenta o tamanho e o score em 10 pontos

### Sistema de Rooms
- **Room browser**: lista todas as salas ativas em tempo real (waiting / playing / finished)
- **Criar salas**: qualquer jogador pode criar uma sala nomeada
- **Salas privadas**: com senha opcional (cadeado no browser)
- **Multiplas salas simultaneas**: varias partidas rodando em paralelo

### Bots
- Bots com AI que usa **A\* pathfinding** (reaproveitado do jogo original)
- Priorizam dead food proximo quando disponivel
- Sistema anti-stuck para evitar loops

### Espectadores
- Entre numa sala em andamento para **assistir em tempo real**
- Banner "SPECTATING" indica o modo
- Espectadores podem pedir para **entrar como jogador** quando a partida terminar e houver vaga
- Quantidade de espectadores mostrada no browser e no lobby

### Permissoes (Owner)
- Somente o criador da sala (marcado com uma estrela) pode:
  - Adicionar/remover bots
  - Iniciar a partida
  - Reiniciar apos o game over

### Interface
- **Desktop**: side panel com placar a esquerda, barra superior com nivel e high score
- **Mobile/Tablet**: layout vertical responsivo, placar horizontal compacto, canvas escala para tela cheia
- Suporte a `100dvh` para lidar com a barra do navegador em dispositivos moveis
- Head da cobra com borda branca para destaque

---

## Controles

| Plataforma | Controle |
|-----------|----------|
| Desktop | Setas do teclado ou WASD |
| Mobile/Tablet | Swipe em qualquer lugar da tela |

---

## Como Rodar

### Requisitos
- Node.js (v16+)
- npm

### Instalacao

```bash
cd snake-multiplayer
npm install
```

### Iniciar o servidor

```bash
npm start
```

O servidor sobe em `0.0.0.0:30000`. Acesse no browser:
- Local: `http://localhost:30000`
- Rede: `http://<ip-da-maquina>:30000`

---

## Estrutura do Projeto

```
snake-multiplayer/
├── server.js           # Server Node.js (game loop + Socket.IO)
├── package.json
└── public/
    └── index.html      # Cliente (HTML + CSS + JS num arquivo so)
```

### Arquitetura

- **Server-authoritative**: todo o estado do jogo (colisoes, comida, obstaculos, posicoes) e calculado no servidor e enviado aos clientes a cada tick
- **Clientes** so fazem 2 coisas:
  1. Enviar a direcao escolhida pelo jogador
  2. Renderizar o estado recebido do servidor
- **Socket.IO** cuida da camada de transporte (fallback para long polling se WebSocket falhar)

### Eventos Socket

**Cliente -> Servidor:**
- `getRooms` - solicita lista de salas
- `createRoom {playerName, roomName, password}` - cria nova sala
- `joinRoom {roomId, playerName, password}` - entra como jogador
- `spectateRoom {roomId, playerName, password}` - entra como espectador
- `joinFromSpectator` - espectador vira jogador (se houver vaga)
- `addBot` / `removeBot` - gerenciar bots (owner only)
- `startGame` - iniciar partida (owner only)
- `direction UP|DOWN|LEFT|RIGHT` - mudar direcao
- `requestRestart` - reiniciar apos game over (owner only)
- `leaveRoom` - sair da sala

**Servidor -> Cliente:**
- `roomList [rooms]` - lista atualizada de salas
- `joined {roomId, playerId, color, name, isSpectator, isOwner, gameInProgress}` - confirmacao de entrada
- `lobby {players, spectatorCount, ownerId, ...}` - estado do lobby
- `gameStarted` - partida iniciou
- `gameState {players, obstacles, activeFood, deadFood, level, highScore, ...}` - estado do jogo (tick)
- `levelUp <level>` - novo nivel
- `gameOver {winner, winnerColor, highScore, highScorePlayer}` - fim de jogo
- `restarted` - partida reiniciou
- `leftRoom` - saiu da sala
- `joinError <msg>` - erro ao entrar

---

## Constantes de Jogo

| Constante | Valor | Descricao |
|-----------|-------|-----------|
| `WIDTH x HEIGHT` | 800 x 600 | Resolucao logica |
| `BLOCK_SIZE` | 10 | Tamanho de cada celula |
| `BASE_SPEED` | 8 | Ticks/segundo iniciais |
| `SPEED_INCREASE` | 0.5 | Incremento por nivel |
| `MAX_TICK_RATE` | 15 | Cap de velocidade |
| `LEVEL_THRESHOLD` | 200 | Pontos por nivel |
| `MAX_PLAYERS` | 10 | Jogadores por sala |
| `MIN_LENGTH` | 3 | Tamanho minimo da cobra |

Todas editaveis no topo do `server.js`.
