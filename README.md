# Snake Evolution - Multiplayer

Online multiplayer version of the classic Snake game. Up to **10 simultaneous players** per room competing in **last-man-standing** mode, with support for bots, spectators, and private rooms.

---

## Features

### Gameplay
- **Up to 10 snakes** in the same match
- **Last-man-standing mode**: the match ends when only 1 snake remains alive
- **3 lives** per player - when you die, your body turns into food (dead food) that can be consumed by others
- **Progressive levels**: every 200 collective points, extra obstacles appear and the speed increases slightly (capped at 15 ticks/s)
- **Active food + dead food**: eating either one increases your size and score by 10 points

### Room System
- **Room browser**: lists all active rooms in real time (waiting / playing / finished)
- **Create rooms**: any player can create a named room
- **Private rooms**: with optional password (padlock icon in the browser)
- **Multiple simultaneous rooms**: several matches running in parallel

### Bots
- Bots with AI using **A\* pathfinding** (reused from the original game)
- They prioritize nearby dead food when available
- Anti-stuck system to avoid loops

### Spectators
- Join an ongoing room to **watch in real time**
- "SPECTATING" banner indicates the mode
- Spectators can request to **join as a player** when the match ends and a slot is available
- Spectator count is shown in the browser and the lobby

### Permissions (Owner)
- Only the room creator (marked with a star) can:
  - Add/remove bots
  - Start the match
  - Restart after game over

### Interface
- **Desktop**: side panel with scoreboard on the left, top bar with level and high score
- **Mobile/Tablet**: responsive vertical layout, compact horizontal scoreboard, canvas scales to full screen
- `100dvh` support to handle the browser bar on mobile devices
- Snake head with white border for highlighting

---

## Controls

| Platform | Control |
|-----------|----------|
| Desktop | Arrow keys or WASD |
| Mobile/Tablet | Swipe anywhere on the screen |

---

## How to Run

### Requirements
- Node.js (v16+)
- npm

### Installation

```bash
cd snake-multiplayer
npm install
```

### Start the server

```bash
npm start
```

The server runs on `0.0.0.0:30000`. Open it in your browser:
- Local: `http://localhost:30000`
- Network: `http://<machine-ip>:30000`

---

## Project Structure

```
snake-multiplayer/
├── server.js           # Node.js server (game loop + Socket.IO)
├── package.json
└── public/
    └── index.html      # Client (HTML + CSS + JS in a single file)
```

### Architecture

- **Server-authoritative**: the entire game state (collisions, food, obstacles, positions) is computed on the server and sent to clients on every tick
- **Clients** only do 2 things:
  1. Send the direction chosen by the player
  2. Render the state received from the server
- **Socket.IO** handles the transport layer (fallback to long polling if WebSocket fails)

### Socket Events

**Client -> Server:**
- `getRooms` - request the room list
- `createRoom {playerName, roomName, password}` - create a new room
- `joinRoom {roomId, playerName, password}` - join as a player
- `spectateRoom {roomId, playerName, password}` - join as a spectator
- `joinFromSpectator` - spectator becomes a player (if a slot is available)
- `addBot` / `removeBot` - manage bots (owner only)
- `startGame` - start the match (owner only)
- `direction UP|DOWN|LEFT|RIGHT` - change direction
- `requestRestart` - restart after game over (owner only)
- `leaveRoom` - leave the room

**Server -> Client:**
- `roomList [rooms]` - updated room list
- `joined {roomId, playerId, color, name, isSpectator, isOwner, gameInProgress}` - join confirmation
- `lobby {players, spectatorCount, ownerId, ...}` - lobby state
- `gameStarted` - match has started
- `gameState {players, obstacles, activeFood, deadFood, level, highScore, ...}` - game state (tick)
- `levelUp <level>` - new level
- `gameOver {winner, winnerColor, highScore, highScorePlayer}` - end of game
- `restarted` - match restarted
- `leftRoom` - left the room
- `joinError <msg>` - error joining

---

## Game Constants

| Constant | Value | Description |
|-----------|-------|-----------|
| `WIDTH x HEIGHT` | 800 x 600 | Logical resolution |
| `BLOCK_SIZE` | 10 | Size of each cell |
| `BASE_SPEED` | 8 | Initial ticks/second |
| `SPEED_INCREASE` | 0.5 | Increment per level |
| `MAX_TICK_RATE` | 15 | Speed cap |
| `LEVEL_THRESHOLD` | 200 | Points per level |
| `MAX_PLAYERS` | 10 | Players per room |
| `MIN_LENGTH` | 3 | Minimum snake size |

All editable at the top of `server.js`.
