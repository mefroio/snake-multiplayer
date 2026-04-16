const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const session = require("express-session");
const { randomUUID } = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const sessionMiddleware = session({
  name: "snake.sid",
  secret: process.env.SESSION_SECRET || "snake-multiplayer-dev-secret",
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));
io.engine.use(sessionMiddleware);

// === Game Constants ===
const WIDTH = 800;
const HEIGHT = 600;
const BLOCK_SIZE = 10;
const BASE_SPEED = 8;
const SPEED_INCREASE = 0.5;
const LEVEL_THRESHOLD = 200;
const MIN_LENGTH = 3;
const MAX_PLAYERS = 10;
const TICK_RATE = BASE_SPEED; // ticks per second
const RECONNECT_GRACE_MS = 5000;
const ABUSE_TRACK_WINDOW_MS = 60 * 1000;
const ABUSE_BLOCK_MS = 30 * 1000;
const ABUSE_THRESHOLD = 8;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_CHAT_HISTORY = 40;
const MAX_CHAT_MESSAGE_LENGTH = 180;

const RATE_LIMIT_RULES = Object.freeze({
  getRooms: { windowMs: 5000, max: 8, message: "Room list refreshed too quickly." },
  createRoom: { windowMs: 60 * 1000, max: 2, message: "Room creation is temporarily rate-limited." },
  joinRoom: { windowMs: 15 * 1000, max: 6, message: "Too many room join attempts." },
  spectateRoom: { windowMs: 15 * 1000, max: 8, message: "Too many spectate attempts." },
  joinFromSpectator: { windowMs: 10 * 1000, max: 4, message: "Too many join attempts from spectator mode." },
  addBot: { windowMs: 10 * 1000, max: 6, message: "Bot changes are temporarily rate-limited." },
  removeBot: { windowMs: 10 * 1000, max: 6, message: "Bot changes are temporarily rate-limited." },
  startGame: { windowMs: 15 * 1000, max: 3, message: "Start requests are temporarily rate-limited." },
  requestRestart: { windowMs: 15 * 1000, max: 3, message: "Restart requests are temporarily rate-limited." },
  sendRoomChat: {
    windowMs: 10 * 1000,
    max: 5,
    message: "Chat is temporarily rate-limited.",
    responseEvent: "roomChatError"
  },
  direction: { windowMs: 1000, max: 30, silent: true, trackAbuse: false }
});

const PLAYER_COLORS = [
  "#00ff00", "#ffff00", "#ff69b4", "#00ffff", "#ffa500",
  "#ff4444", "#aa55ff", "#55ff55", "#ff55aa", "#55aaff"
];
const PLAYER_NAMES = [
  "Green", "Yellow", "Pink", "Cyan", "Orange",
  "Red", "Purple", "Lime", "Rose", "Sky"
];
const BOT_NAMES = [
  "Bot Alpha", "Bot Beta", "Bot Gamma", "Bot Delta", "Bot Epsilon",
  "Bot Zeta", "Bot Eta", "Bot Theta", "Bot Iota", "Bot Kappa"
];

// === Utility ===
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

function snapToGrid(value) {
  return Math.floor(value / BLOCK_SIZE) * BLOCK_SIZE;
}

function toCellKey({ x, y }) {
  return `${x},${y}`;
}

function isInsideArena({ x, y }) {
  return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
}

function buildBlockedCells(obstacles = [], allBodies = []) {
  const blocked = new Set();

  for (const obstacle of obstacles) {
    blocked.add(toCellKey(obstacle));
  }

  for (const body of allBodies) {
    for (const segment of body) {
      blocked.add(toCellKey(segment));
    }
  }

  return blocked;
}

function buildSpawnBody(base) {
  const x = snapToGrid(base.x);
  const y = snapToGrid(base.y);
  return [
    { x, y },
    { x: x - BLOCK_SIZE, y },
    { x: x - 2 * BLOCK_SIZE, y }
  ];
}

function canPlaceBody(body, blockedCells) {
  const seen = new Set();

  for (const segment of body) {
    const key = toCellKey(segment);
    if (!isInsideArena(segment) || blockedCells.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
  }

  return true;
}

// === Obstacle Generation (reused from original) ===
function generateObstacles(level, allBodies = []) {
  const INITIAL_OBSTACLES = 0;
  let obstacles = [];
  let numObstacles = INITIAL_OBSTACLES + level;
  let maxSize = 10;
  const blockedCells = buildBlockedCells([], allBodies);

  function pushObstacleCell(x, y) {
    const cell = { x, y };
    if (!isInsideArena(cell)) return;
    if (blockedCells.has(toCellKey(cell))) return;
    obstacles.push(cell);
  }

  for (let i = 0; i < numObstacles; i++) {
    let x = snapToGrid(getRandomInt(0, WIDTH - BLOCK_SIZE));
    let y = snapToGrid(getRandomInt(0, HEIGHT - BLOCK_SIZE));
    let shapes = ["single", "cross", "block", "wall"];
    let shape = shapes[Math.floor(Math.random() * shapes.length)];
    if (shape === "single") {
      pushObstacleCell(x, y);
    } else if (shape === "cross") {
      for (let j = -1; j <= 1; j++) {
        pushObstacleCell(x + j * BLOCK_SIZE, y);
        pushObstacleCell(x, y + j * BLOCK_SIZE);
      }
    } else if (shape === "block") {
      let size = getRandomInt(2, maxSize + 1);
      for (let dx = 0; dx < size; dx++) {
        for (let dy = 0; dy < size; dy++) {
          pushObstacleCell(x + dx * BLOCK_SIZE, y + dy * BLOCK_SIZE);
        }
      }
    } else if (shape === "wall") {
      let length = getRandomInt(3, 7) * BLOCK_SIZE;
      if (Math.random() < 0.5) {
        x = snapToGrid(getRandomInt(0, WIDTH - length));
        y = snapToGrid(getRandomInt(0, HEIGHT));
        for (let dx = 0; dx < length; dx += BLOCK_SIZE) {
          pushObstacleCell(x + dx, y);
        }
      } else {
        x = snapToGrid(getRandomInt(0, WIDTH));
        y = snapToGrid(getRandomInt(0, HEIGHT - length));
        for (let dy = 0; dy < length; dy += BLOCK_SIZE) {
          pushObstacleCell(x, y + dy);
        }
      }
    }
  }
  let uniq = {};
  obstacles.forEach(o => { uniq[o.x + "," + o.y] = o; });
  return Object.values(uniq);
}

// === Food Generation ===
function getRandomFood(obstacles, allBodies, deadFood) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let x = snapToGrid(getRandomInt(0, WIDTH - BLOCK_SIZE));
    let y = snapToGrid(getRandomInt(0, HEIGHT - BLOCK_SIZE));
    let blocked = obstacles.some(o => o.x === x && o.y === y);
    if (!blocked) {
      for (const body of allBodies) {
        if (body.some(p => p.x === x && p.y === y)) { blocked = true; break; }
      }
    }
    if (!blocked && deadFood.some(f => f.x === x && f.y === y)) blocked = true;
    if (!blocked) return { x, y };
  }
  return { x: snapToGrid(WIDTH / 2), y: snapToGrid(HEIGHT / 2) };
}

// === Spawn Position ===
function getSpawnPosition(index, obstacles = [], allBodies = []) {
  const spawns = [
    { x: 200, y: 300 }, { x: 600, y: 300 },
    { x: 400, y: 150 }, { x: 400, y: 450 },
    { x: 300, y: 200 }, { x: 500, y: 200 },
    { x: 150, y: 150 }, { x: 650, y: 150 },
    { x: 150, y: 450 }, { x: 650, y: 450 }
  ];
  const blockedCells = buildBlockedCells(obstacles, allBodies);
  const startIndex = index % spawns.length;

  for (let offset = 0; offset < spawns.length; offset++) {
    const body = buildSpawnBody(spawns[(startIndex + offset) % spawns.length]);
    if (canPlaceBody(body, blockedCells)) {
      return body;
    }
  }

  for (let y = 0; y < HEIGHT; y += BLOCK_SIZE) {
    for (let x = 2 * BLOCK_SIZE; x < WIDTH; x += BLOCK_SIZE) {
      const body = buildSpawnBody({ x, y });
      if (canPlaceBody(body, blockedCells)) {
        return body;
      }
    }
  }

  return buildSpawnBody(spawns[startIndex]);
}

// === Bot AI (reused A* from original ComputerSnake) ===
class BotAI {
  constructor() {
    this.path = [];
    this.aiCounter = 0;
    this.stuckCounter = 0;
    this.pathHistory = [];
  }

  heuristic(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  isSafePosition(pos, obstacles, otherBodies, selfBody) {
    if (pos.x < 0 || pos.x >= WIDTH || pos.y < 0 || pos.y >= HEIGHT) return false;
    if (obstacles.some(o => o.x === pos.x && o.y === pos.y)) return false;
    for (const body of otherBodies) {
      if (body.some(p => p.x === pos.x && p.y === pos.y)) return false;
    }
    if (selfBody.slice(1).some(p => p.x === pos.x && p.y === pos.y)) return false;
    return true;
  }

  getNeighbors(pos, obstacles, otherBodies, selfBody) {
    const dirs = [
      { dir: "RIGHT", dx: BLOCK_SIZE, dy: 0 },
      { dir: "LEFT", dx: -BLOCK_SIZE, dy: 0 },
      { dir: "DOWN", dx: 0, dy: BLOCK_SIZE },
      { dir: "UP", dx: 0, dy: -BLOCK_SIZE }
    ];
    return dirs
      .filter(d => this.isSafePosition({ x: pos.x + d.dx, y: pos.y + d.dy }, obstacles, otherBodies, selfBody))
      .map(d => ({ pos: { x: pos.x + d.dx, y: pos.y + d.dy }, dir: d.dir }));
  }

  aStarPathfind(start, goal, obstacles, otherBodies, selfBody) {
    const openSet = new Map();
    const closedSet = new Set();
    const cameFrom = new Map();
    const gScore = new Map();
    const fScore = new Map();
    const startKey = `${start.x},${start.y}`;
    openSet.set(startKey, start);
    gScore.set(startKey, 0);
    fScore.set(startKey, this.heuristic(start, goal));
    let iterations = 0;

    while (openSet.size > 0 && iterations < 500) {
      iterations++;
      let current = null, lowestF = Infinity;
      for (const [key, node] of openSet) {
        const f = fScore.get(key);
        if (f < lowestF) { lowestF = f; current = node; }
      }
      const currentKey = `${current.x},${current.y}`;
      if (current.x === goal.x && current.y === goal.y) {
        const path = [current];
        let curr = current;
        while (cameFrom.has(`${curr.x},${curr.y}`)) {
          curr = cameFrom.get(`${curr.x},${curr.y}`);
          path.unshift(curr);
        }
        return path;
      }
      openSet.delete(currentKey);
      closedSet.add(currentKey);
      for (const neighbor of this.getNeighbors(current, obstacles, otherBodies, selfBody)) {
        const nKey = `${neighbor.pos.x},${neighbor.pos.y}`;
        if (closedSet.has(nKey)) continue;
        const tentativeG = gScore.get(currentKey) + 1;
        if (!openSet.has(nKey)) {
          openSet.set(nKey, neighbor.pos);
        } else if (tentativeG >= gScore.get(nKey)) {
          continue;
        }
        cameFrom.set(nKey, current);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + this.heuristic(neighbor.pos, goal));
      }
    }
    return null;
  }

  chooseDirection(playerState, obstacles, allPlayers, food, deadFood) {
    const head = playerState.body[0];
    const otherBodies = [];
    for (const p of allPlayers.values()) {
      if (p.id !== playerState.id && p.alive) otherBodies.push(p.body);
    }

    // Pick target: nearest dead food or active food
    let target = food;
    if (deadFood.length > 0) {
      let bestDead = null, bestDist = Infinity;
      for (const f of deadFood) {
        const d = this.heuristic(head, f);
        if (d < bestDist) { bestDist = d; bestDead = f; }
      }
      const distActive = food ? this.heuristic(head, food) : Infinity;
      if (bestDead && bestDist < distActive) target = bestDead;
    }

    // Recalc path periodically
    if (!this.path || this.path.length === 0 || this.aiCounter % 5 === 0) {
      this.path = target
        ? this.aStarPathfind(head, target, obstacles, otherBodies, playerState.body)
        : null;
    }
    this.aiCounter++;

    let nextDir = playerState.direction;
    if (this.path && this.path.length > 1) {
      const next = this.path[1];
      if (next.x > head.x) nextDir = "RIGHT";
      else if (next.x < head.x) nextDir = "LEFT";
      else if (next.y > head.y) nextDir = "DOWN";
      else if (next.y < head.y) nextDir = "UP";
      this.path = this.path.slice(1);
    } else {
      // Fallback: pick a safe direction
      const safeDirs = this.getSafeDirections(head, playerState.direction, obstacles, otherBodies, playerState.body);
      if (safeDirs.length > 0) nextDir = safeDirs[Math.floor(Math.random() * safeDirs.length)];
    }

    // Anti-stuck
    this.pathHistory.push({ x: head.x, y: head.y });
    if (this.pathHistory.length > 20) this.pathHistory.shift();
    if (this.pathHistory.length > 10) {
      const recent = this.pathHistory.slice(-10);
      const unique = new Set(recent.map(p => `${p.x},${p.y}`));
      if (unique.size < 3) { this.stuckCounter++; if (this.stuckCounter > 5) { this.path = null; this.stuckCounter = 0; } }
      else this.stuckCounter = 0;
    }

    return nextDir;
  }

  getSafeDirections(head, currentDir, obstacles, otherBodies, selfBody) {
    const opposites = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };
    return ["UP", "DOWN", "LEFT", "RIGHT"].filter(dir => {
      if (opposites[dir] === currentDir) return false;
      const pos = { x: head.x, y: head.y };
      switch (dir) {
        case "UP": pos.y -= BLOCK_SIZE; break;
        case "DOWN": pos.y += BLOCK_SIZE; break;
        case "LEFT": pos.x -= BLOCK_SIZE; break;
        case "RIGHT": pos.x += BLOCK_SIZE; break;
      }
      return this.isSafePosition(pos, obstacles, otherBodies, selfBody);
    });
  }
}

// === Game Room ===
class GameRoom {
  constructor(id, name, password) {
    this.id = id;
    this.name = name || "Room " + id.slice(-4);
    this.password = password || null; // null = public
    this.players = new Map(); // playerId -> player state
    this.spectators = new Map(); // userId -> spectator state
    this.level = 1;
    this.obstacles = generateObstacles(this.level);
    this.activeFood = null;
    this.deadFood = [];
    this.started = false;
    this.finished = false;
    this.gameInterval = null;
    this.tickRate = TICK_RATE;
    this.highScore = 0;
    this.highScorePlayer = "None";
    this.totalScoreForLevel = 0;
    this.lastLevelScore = 0;
    this.lastGameOverData = null;
    this.chatMessages = [];
    this.chatSequence = 0;
    this.botAIs = new Map(); // botId -> BotAI instance
    this.botCounter = 0;
    this.ownerId = null; // userId of creator
    this.createdAt = Date.now();
  }

  get humanCount() {
    let count = 0;
    for (const p of this.players.values()) { if (!p.isBot) count++; }
    return count;
  }

  getInfo() {
    return {
      id: this.id,
      name: this.name,
      hasPassword: !!this.password,
      playerCount: this.players.size,
      humanCount: this.humanCount,
      spectatorCount: this.spectators.size,
      maxPlayers: MAX_PLAYERS,
      started: this.started,
      finished: this.finished,
      level: this.level
    };
  }

  getAllBodies() {
    const bodies = [];
    for (const p of this.players.values()) {
      if (p.alive) bodies.push(p.body);
    }
    return bodies;
  }

  addPlayer(playerId, socketId, name, isBot = false) {
    if (this.players.size >= MAX_PLAYERS) return false;
    const index = this.players.size;
    const body = getSpawnPosition(index, this.obstacles, this.getAllBodies());
    this.players.set(playerId, {
      id: playerId,
      socketId,
      name: name || PLAYER_NAMES[index],
      color: PLAYER_COLORS[index],
      colorIndex: index,
      body: body,
      direction: "RIGHT",
      nextDir: "RIGHT",
      score: 0,
      alive: true,
      lives: 3,
      spawnIndex: index,
      isBot: isBot
    });
    if (!isBot && !this.ownerId) {
      this.ownerId = playerId;
    }
    if (isBot) {
      this.botAIs.set(playerId, new BotAI());
    }
    return true;
  }

  rebindPlayerSocket(playerId, socketId) {
    const player = this.players.get(playerId);
    if (!player || player.isBot) return null;
    player.socketId = socketId;
    return player;
  }

  reassignOwner() {
    if (this.ownerId && this.players.has(this.ownerId)) {
      const currentOwner = this.players.get(this.ownerId);
      if (currentOwner && !currentOwner.isBot) {
        return this.ownerId;
      }
    }

    let nextOwner = null;
    for (const [id, player] of this.players) {
      if (!player.isBot) {
        nextOwner = id;
        break;
      }
    }

    this.ownerId = nextOwner;
    return this.ownerId;
  }

  addBot() {
    if (this.players.size >= MAX_PLAYERS) return null;
    const botId = "bot_" + (++this.botCounter) + "_" + Date.now();
    const name = BOT_NAMES[this.botCounter % BOT_NAMES.length];
    this.addPlayer(botId, null, name, true);
    return botId;
  }

  removeBot(botId) {
    const player = this.players.get(botId);
    if (player && player.isBot) {
      this.deadFood = this.deadFood.concat(player.body);
      this.players.delete(botId);
      this.botAIs.delete(botId);
    }
  }

  addSpectator(userId, socketId, name) {
    this.spectators.set(userId, { id: userId, socketId, name });
  }

  rebindSpectatorSocket(userId, socketId) {
    const spectator = this.spectators.get(userId);
    if (!spectator) return null;
    spectator.socketId = socketId;
    return spectator;
  }

  removeSpectator(userId) {
    this.spectators.delete(userId);
    this.reassignOwner();
  }

  // Spectator joins as player (if slot available and game not started)
  promoteSpectator(userId, socketId, name) {
    if (this.started || this.players.size >= MAX_PLAYERS) return false;
    this.spectators.delete(userId);
    return this.addPlayer(userId, socketId, name);
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      this.deadFood = this.deadFood.concat(player.body);
      this.players.delete(playerId);
      this.botAIs.delete(playerId);
    }
    this.spectators.delete(playerId);
    this.reassignOwner();
    // If only bots remain (no humans playing or spectating), stop
    const hasHumans = Array.from(this.players.values()).some(p => !p.isBot);
    if (!hasHumans && this.spectators.size === 0) {
      this.stop();
      for (const [id, p] of this.players) {
        if (p.isBot) this.players.delete(id);
      }
      this.botAIs.clear();
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.finished = false;
    this.lastGameOverData = null;
    this.clearChat();
    this.activeFood = getRandomFood(this.obstacles, this.getAllBodies(), this.deadFood);

    this.gameInterval = setInterval(() => {
      this.tick();
    }, 1000 / this.tickRate);
  }

  stop() {
    this.started = false;
    if (this.gameInterval) {
      clearInterval(this.gameInterval);
      this.gameInterval = null;
    }
  }

  respawnPlayer(player) {
    const body = getSpawnPosition(player.spawnIndex, this.obstacles, this.getAllBodies());
    player.body = body;
    player.direction = "RIGHT";
    player.nextDir = "RIGHT";
    player.alive = true;
  }

  tick() {
    // Check level up based on total score
    let totalScore = 0;
    for (const p of this.players.values()) {
      totalScore += p.score;
    }
    if (totalScore >= this.lastLevelScore + LEVEL_THRESHOLD) {
      this.lastLevelScore = totalScore;
      this.level++;
      this.tickRate = Math.min(BASE_SPEED + (this.level - 1) * SPEED_INCREASE, 15);
      this.obstacles = generateObstacles(this.level, this.getAllBodies());
      // Restart interval with new speed
      clearInterval(this.gameInterval);
      this.gameInterval = setInterval(() => this.tick(), 1000 / this.tickRate);
      // Check food not in obstacle
      if (this.activeFood && this.obstacles.some(o => o.x === this.activeFood.x && o.y === this.activeFood.y)) {
        this.activeFood = getRandomFood(this.obstacles, this.getAllBodies(), this.deadFood);
      }
      io.to(this.id).emit("levelUp", this.level);
    }

    // Run bot AI
    for (const [botId, ai] of this.botAIs) {
      const botPlayer = this.players.get(botId);
      if (!botPlayer || !botPlayer.alive) continue;
      const dir = ai.chooseDirection(botPlayer, this.obstacles, this.players, this.activeFood, this.deadFood);
      const opposites = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };
      if (opposites[dir] !== botPlayer.direction) {
        botPlayer.nextDir = dir;
      }
    }

    // Move each player
    for (const [sid, player] of this.players) {
      if (!player.alive) continue;

      player.direction = player.nextDir;
      const head = player.body[0];
      const newHead = { x: head.x, y: head.y };

      switch (player.direction) {
        case "UP": newHead.y -= BLOCK_SIZE; break;
        case "DOWN": newHead.y += BLOCK_SIZE; break;
        case "LEFT": newHead.x -= BLOCK_SIZE; break;
        case "RIGHT": newHead.x += BLOCK_SIZE; break;
      }

      // Check wall collision
      let collision = newHead.x < 0 || newHead.x >= WIDTH || newHead.y < 0 || newHead.y >= HEIGHT;

      // Check self collision
      if (!collision) {
        collision = player.body.slice(1).some(p => p.x === newHead.x && p.y === newHead.y);
      }

      // Check obstacle collision
      if (!collision) {
        collision = this.obstacles.some(o => o.x === newHead.x && o.y === newHead.y);
      }

      // Check collision with other snakes
      if (!collision) {
        for (const [otherId, other] of this.players) {
          if (otherId === sid) continue;
          if (!other.alive) continue;
          if (other.body.some(p => p.x === newHead.x && p.y === newHead.y)) {
            collision = true;
            break;
          }
        }
      }

      if (collision) {
        this.deadFood = this.deadFood.concat(player.body);
        player.lives--;
        if (player.lives <= 0) {
          player.alive = false;
          player.body = [];
          if (player.socketId) {
            io.to(player.socketId).emit("youDied", { score: player.score, reason: "You crashed!" });
            sendRoomChatHistoryToSocketId(this, player.socketId, player.id);
          }
        } else {
          this.respawnPlayer(player);
        }
      } else {
        player.body.unshift(newHead);

        let ate = false;
        // Check active food
        if (this.activeFood && newHead.x === this.activeFood.x && newHead.y === this.activeFood.y) {
          player.score += 10;
          ate = true;
          this.activeFood = getRandomFood(this.obstacles, this.getAllBodies(), this.deadFood);
        }

        // Check dead food
        if (!ate) {
          const deadIdx = this.deadFood.findIndex(f => f.x === newHead.x && f.y === newHead.y);
          if (deadIdx !== -1) {
            this.deadFood.splice(deadIdx, 1);
            player.score += 10;
            ate = true;
          }
        }

        if (!ate) {
          player.body.pop();
        }
      }

      // Track high score
      if (player.score > this.highScore) {
        this.highScore = player.score;
        this.highScorePlayer = player.name;
      }
    }

    // Count alive players
    let aliveCount = 0;
    let lastAlive = null;
    for (const p of this.players.values()) {
      if (p.alive) { aliveCount++; lastAlive = p; }
    }

    // Build and send game state to players and spectators
    const state = this.getState();
    io.to(this.id).emit("gameState", state);

    // Last man standing: game ends when 0 or 1 alive (and there were 2+ players)
    const gameOverData = {
      winner: lastAlive ? lastAlive.name : null,
      winnerColor: lastAlive ? lastAlive.color : null,
      highScore: this.highScore,
      highScorePlayer: this.highScorePlayer
    };
    if (this.players.size >= 2 && aliveCount <= 1) {
      this.stop();
      this.finished = true;
      this.lastGameOverData = gameOverData;
      io.to(this.id).emit("gameOver", this.lastGameOverData);
      broadcastRoomList();
    } else if (this.players.size === 1 && aliveCount === 0) {
      this.stop();
      this.finished = true;
      this.lastGameOverData = { ...gameOverData, winner: null };
      io.to(this.id).emit("gameOver", this.lastGameOverData);
      broadcastRoomList();
    }
  }

  getState() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        color: p.color,
        body: p.body,
        score: p.score,
        alive: p.alive,
        lives: p.lives,
        isBot: p.isBot || false
      });
    }
    return {
      players,
      obstacles: this.obstacles,
      activeFood: this.activeFood,
      deadFood: this.deadFood,
      level: this.level,
      highScore: this.highScore,
      highScorePlayer: this.highScorePlayer
    };
  }

  reset() {
    this.stop();
    this.finished = false;
    this.level = 1;
    this.tickRate = TICK_RATE;
    this.obstacles = generateObstacles(this.level);
    this.activeFood = null;
    this.deadFood = [];
    this.highScore = 0;
    this.highScorePlayer = "None";
    this.lastLevelScore = 0;
    this.lastGameOverData = null;
    this.clearChat();

    // Remove all bots on reset
    for (const [id, p] of this.players) {
      if (p.isBot) {
        this.players.delete(id);
        this.botAIs.delete(id);
      }
    }

    let index = 0;
    const assignedBodies = [];
    for (const player of this.players.values()) {
      player.spawnIndex = index;
      player.color = PLAYER_COLORS[index];
      player.colorIndex = index;
      const body = getSpawnPosition(index, this.obstacles, assignedBodies);
      player.body = body;
      assignedBodies.push(body);
      player.direction = "RIGHT";
      player.nextDir = "RIGHT";
      player.score = 0;
      player.alive = true;
      player.lives = 3;
      index++;
    }
  }

  clearChat() {
    this.chatMessages = [];
    this.chatSequence = 0;
  }

  addChatMessage(senderId, senderName, senderColor, text, role) {
    const message = {
      id: `${this.id}_chat_${++this.chatSequence}`,
      senderId,
      senderName,
      senderColor,
      text,
      role,
      createdAt: Date.now()
    };

    this.chatMessages.push(message);
    if (this.chatMessages.length > MAX_CHAT_HISTORY) {
      this.chatMessages.shift();
    }

    return message;
  }
}

// === Room Management ===
const rooms = new Map();
const activeConnections = new Map(); // userId -> socket.id
const pendingDisconnects = new Map(); // userId -> timeout
const rateLimitBuckets = new Map(); // scope:event -> timestamps
const abuseBuckets = new Map(); // scope -> state
let lastRateLimitCleanupAt = 0;

function generateRoomId() {
  return "room_" + Date.now().toString(36) + "_" + Math.random().toString(36).substr(2, 4);
}

function getRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    list.push(room.getInfo());
  }
  return list.sort((a, b) => {
    // Active games first, then waiting, then finished
    const order = (r) => r.started && !r.finished ? 0 : !r.started ? 1 : 2;
    return order(a) - order(b) || b.playerCount - a.playerCount;
  });
}

function broadcastRoomList() {
  io.emit("roomList", getRoomList());
}

function emitLobbyUpdate(room) {
  io.to(room.id).emit("lobby", {
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, color: p.color, isBot: p.isBot || false
    })),
    spectatorCount: room.spectators.size,
    roomId: room.id,
    roomName: room.name,
    hasPassword: !!room.password,
    ownerId: room.ownerId
  });
}

function cleanupRoom(room) {
  if (room.players.size === 0 && room.spectators.size === 0) {
    room.stop();
    rooms.delete(room.id);
    broadcastRoomList();
    console.log(`Room ${room.id} deleted (empty)`);
  }
}

function findUserPresence(userId) {
  for (const room of rooms.values()) {
    const player = room.players.get(userId);
    if (player && !player.isBot) {
      return { room, isSpectator: false, state: player };
    }

    const spectator = room.spectators.get(userId);
    if (spectator) {
      return { room, isSpectator: true, state: spectator };
    }
  }

  return null;
}

function getSocketIp(socket) {
  const cfIp = socket.handshake.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.trim()) {
    return cfIp.trim();
  }

  const forwardedFor = socket.handshake.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return socket.handshake.address || socket.conn.remoteAddress || "unknown";
}

function trimOldTimestamps(timestamps, cutoff) {
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift();
  }
}

function cleanupRateLimiterState(now) {
  if (now - lastRateLimitCleanupAt < RATE_LIMIT_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastRateLimitCleanupAt = now;

  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.lastSeenAt > ABUSE_TRACK_WINDOW_MS) {
      rateLimitBuckets.delete(key);
    }
  }

  for (const [key, state] of abuseBuckets) {
    trimOldTimestamps(state.timestamps, now - ABUSE_TRACK_WINDOW_MS);
    if (state.blockedUntil <= now && state.timestamps.length === 0) {
      abuseBuckets.delete(key);
    }
  }
}

function recordAbuseViolation(scopeKey, now) {
  const state = abuseBuckets.get(scopeKey) || {
    timestamps: [],
    blockedUntil: 0
  };

  trimOldTimestamps(state.timestamps, now - ABUSE_TRACK_WINDOW_MS);
  state.timestamps.push(now);

  if (state.timestamps.length >= ABUSE_THRESHOLD) {
    state.blockedUntil = now + ABUSE_BLOCK_MS;
    state.timestamps = [];
    console.warn(`Temporarily blocked abusive socket scope ${scopeKey}`);
  }

  abuseBuckets.set(scopeKey, state);
}

function consumeRateLimit(scopeKey, eventName, rule) {
  const now = Date.now();
  cleanupRateLimiterState(now);

  const abuseState = abuseBuckets.get(scopeKey);
  if (abuseState && abuseState.blockedUntil > now) {
    return {
      allowed: false,
      blocked: true,
      retryAfterMs: abuseState.blockedUntil - now
    };
  }

  const bucketKey = `${scopeKey}:${eventName}`;
  const bucket = rateLimitBuckets.get(bucketKey) || {
    timestamps: [],
    lastSeenAt: now
  };

  trimOldTimestamps(bucket.timestamps, now - rule.windowMs);
  if (bucket.timestamps.length >= rule.max) {
    bucket.lastSeenAt = now;
    rateLimitBuckets.set(bucketKey, bucket);

    if (rule.trackAbuse !== false) {
      recordAbuseViolation(scopeKey, now);
    }

    const retryAfterMs = Math.max(250, rule.windowMs - (now - bucket.timestamps[0]));
    return {
      allowed: false,
      blocked: false,
      retryAfterMs
    };
  }

  bucket.timestamps.push(now);
  bucket.lastSeenAt = now;
  rateLimitBuckets.set(bucketKey, bucket);

  return {
    allowed: true,
    blocked: false,
    retryAfterMs: 0
  };
}

function emitRateLimitFeedback(socket, eventName, result, rule) {
  if (rule.silent) {
    return;
  }

  const waitSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  const message = result.blocked
    ? `Too many requests. Try again in ${waitSeconds}s.`
    : `${rule.message} Try again in ${waitSeconds}s.`;

  socket.emit(rule.responseEvent || "joinError", message);
  console.warn(`Rate limited event "${eventName}" for ${getSocketIp(socket)} (${waitSeconds}s)`);
}

function clearPendingDisconnect(userId) {
  const timeoutId = pendingDisconnects.get(userId);
  if (!timeoutId) return;

  clearTimeout(timeoutId);
  pendingDisconnects.delete(userId);
}

function scheduleDisconnectCleanup(userId, roomId) {
  clearPendingDisconnect(userId);

  const timeoutId = setTimeout(() => {
    pendingDisconnects.delete(userId);

    if (activeConnections.has(userId)) {
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    if (room.spectators.has(userId)) {
      room.removeSpectator(userId);
    } else if (room.players.has(userId)) {
      room.removePlayer(userId);
    } else {
      return;
    }

    emitLobbyUpdate(room);
    cleanupRoom(room);
    broadcastRoomList();
  }, RECONNECT_GRACE_MS);

  pendingDisconnects.set(userId, timeoutId);
}

function emitJoined(socket, room, userId, isSpectator, nameOverride = null) {
  const player = isSpectator ? null : room.players.get(userId);
  const spectator = isSpectator ? room.spectators.get(userId) : null;

  socket.emit("joined", {
    roomId: room.id,
    playerId: userId,
    color: player ? player.color : null,
    name: player ? player.name : (nameOverride || spectator?.name || "Spectator"),
    isSpectator,
    isOwner: room.ownerId === userId,
    gameInProgress: room.started && !room.finished
  });
}

function emitRestoreState(socket, room) {
  if (!room.started && !room.finished) return;

  socket.emit("gameState", room.getState());

  if (room.finished && room.lastGameOverData) {
    socket.emit("gameOver", room.lastGameOverData);
  }

  sendRoomChatHistoryToSocket(socket, room, socket.request.session?.userId);
}

function canUserUseRoomChat(room, userId) {
  if (!room || !userId || !room.started || room.finished) {
    return false;
  }

  if (room.spectators.has(userId)) {
    return true;
  }

  const player = room.players.get(userId);
  return !!(player && !player.isBot && !player.alive);
}

function getRoomChatRecipientSocketIds(room) {
  const socketIds = new Set();

  for (const spectator of room.spectators.values()) {
    if (spectator.socketId) {
      socketIds.add(spectator.socketId);
    }
  }

  for (const player of room.players.values()) {
    if (!player.isBot && !player.alive && player.socketId) {
      socketIds.add(player.socketId);
    }
  }

  return Array.from(socketIds);
}

function emitRoomChatToEligible(room, eventName, payload) {
  for (const socketId of getRoomChatRecipientSocketIds(room)) {
    io.to(socketId).emit(eventName, payload);
  }
}

function sendRoomChatHistoryToSocket(socket, room, userId) {
  if (!canUserUseRoomChat(room, userId)) {
    return;
  }

  socket.emit("roomChatHistory", room.chatMessages);
}

function sendRoomChatHistoryToSocketId(room, socketId, userId) {
  if (!canUserUseRoomChat(room, userId) || !socketId) {
    return;
  }

  io.to(socketId).emit("roomChatHistory", room.chatMessages);
}

function broadcastRoomChatHistory(room) {
  emitRoomChatToEligible(room, "roomChatHistory", room.chatMessages);
}

// === Socket.IO ===
io.use((socket, next) => {
  const sess = socket.request.session;
  if (!sess) {
    next(new Error("Session unavailable"));
    return;
  }

  if (!sess.userId) {
    sess.userId = randomUUID();
    sess.save(next);
    return;
  }

  next();
});

io.on("connection", (socket) => {
  const userId = socket.request.session.userId;
  const rateLimitScope = `${userId}:${getSocketIp(socket)}`;
  clearPendingDisconnect(userId);
  const previousSocketId = activeConnections.get(userId);
  const existingPresence = findUserPresence(userId);

  activeConnections.set(userId, socket.id);
  console.log(`Connected: ${socket.id} as ${userId}`);
  let currentRoom = null;
  let isSpectator = false;
  let playerName = "Player";

  if (existingPresence) {
    currentRoom = existingPresence.room;
    isSpectator = existingPresence.isSpectator;
    playerName = existingPresence.state.name || playerName;

    if (isSpectator) {
      currentRoom.rebindSpectatorSocket(userId, socket.id);
    } else {
      currentRoom.rebindPlayerSocket(userId, socket.id);
    }

    socket.join(currentRoom.id);
  }

  // Send room list on connect
  socket.emit("roomList", getRoomList());

  if (currentRoom) {
    emitJoined(socket, currentRoom, userId, isSpectator, playerName);
    emitRestoreState(socket, currentRoom);
    emitLobbyUpdate(currentRoom);
  }

  if (previousSocketId && previousSocketId !== socket.id) {
    const previousSocket = io.sockets.sockets.get(previousSocketId);
    if (previousSocket) {
      previousSocket.emit("sessionTakenOver");
      previousSocket.disconnect(true);
    }
  }

  const onEvent = (eventName, handler) => {
    socket.on(eventName, (payload) => {
      const rule = RATE_LIMIT_RULES[eventName];
      if (rule) {
        const limitResult = consumeRateLimit(rateLimitScope, eventName, rule);
        if (!limitResult.allowed) {
          emitRateLimitFeedback(socket, eventName, limitResult, rule);
          return;
        }
      }

      handler(payload);
    });
  };

  // --- Browse rooms ---
  onEvent("getRooms", () => {
    socket.emit("roomList", getRoomList());
  });

  // --- Create room ---
  onEvent("createRoom", (data = {}) => {
    if (currentRoom) return;
    const roomName = (data.roomName || "").substring(0, 20).trim() || "New Room";
    const password = (data.password || "").trim() || null;
    playerName = (data.playerName || "").substring(0, 15).trim() || "Player";

    const id = generateRoomId();
    const room = new GameRoom(id, roomName, password);
    rooms.set(id, room);

    room.addPlayer(userId, socket.id, playerName);
    currentRoom = room;
    isSpectator = false;
    socket.join(room.id);

    emitJoined(socket, room, userId, false);
    emitLobbyUpdate(room);
    broadcastRoomList();
    console.log(`${playerName} created room "${roomName}" (${room.id})`);
  });

  // --- Join room as player ---
  onEvent("joinRoom", (data = {}) => {
    if (currentRoom) return;
    const room = rooms.get(data.roomId);
    if (!room) { socket.emit("joinError", "Room not found"); return; }
    if (room.finished) { socket.emit("joinError", "Round finished. Spectate and wait for restart."); return; }
    if (room.started) { socket.emit("joinError", "Game already in progress. You can spectate."); return; }
    if (room.players.size >= MAX_PLAYERS) { socket.emit("joinError", "Room is full"); return; }
    if (room.password && data.password !== room.password) { socket.emit("joinError", "Wrong password"); return; }

    playerName = (data.playerName || "").substring(0, 15).trim() || "Player";
    room.addPlayer(userId, socket.id, playerName);
    currentRoom = room;
    isSpectator = false;
    socket.join(room.id);

    emitJoined(socket, room, userId, false);
    emitLobbyUpdate(room);
    broadcastRoomList();
    console.log(`${playerName} joined ${room.id} (${room.players.size} players)`);
  });

  // --- Spectate room ---
  onEvent("spectateRoom", (data = {}) => {
    if (currentRoom) return;
    const room = rooms.get(data.roomId);
    if (!room) { socket.emit("joinError", "Room not found"); return; }
    if (room.password && data.password !== room.password) { socket.emit("joinError", "Wrong password"); return; }

    playerName = (data.playerName || "").substring(0, 15).trim() || "Spectator";
    room.addSpectator(userId, socket.id, playerName);
    currentRoom = room;
    isSpectator = true;
    socket.join(room.id);

    emitJoined(socket, room, userId, true, playerName);
    emitRestoreState(socket, room);
    emitLobbyUpdate(room);
    broadcastRoomList();
    console.log(`${playerName} spectating ${room.id}`);
  });

  // --- Spectator wants to play ---
  onEvent("joinFromSpectator", () => {
    if (!currentRoom || !isSpectator) return;
    if (currentRoom.finished) { socket.emit("joinError", "Round finished. Wait for the owner to restart."); return; }
    if (currentRoom.started) { socket.emit("joinError", "Game in progress, wait for next round"); return; }
    if (currentRoom.players.size >= MAX_PLAYERS) { socket.emit("joinError", "Room is full"); return; }

    const promoted = currentRoom.promoteSpectator(userId, socket.id, playerName);
    if (!promoted) { socket.emit("joinError", "Could not join"); return; }

    isSpectator = false;
    const playerInfo = currentRoom.players.get(userId);
    socket.emit("promoted", {
      playerId: userId,
      color: playerInfo.color,
      name: playerInfo.name
    });
    emitLobbyUpdate(currentRoom);
    broadcastRoomList();
    console.log(`${playerName} promoted from spectator in ${currentRoom.id}`);
  });

  // --- Add/remove bots ---
  onEvent("addBot", () => {
    if (!currentRoom || currentRoom.started || currentRoom.ownerId !== userId) return;
    const botId = currentRoom.addBot();
    if (botId) {
      emitLobbyUpdate(currentRoom);
      broadcastRoomList();
    }
  });

  onEvent("removeBot", () => {
    if (!currentRoom || currentRoom.started || currentRoom.ownerId !== userId) return;
    let lastBotId = null;
    for (const [id, p] of currentRoom.players) {
      if (p.isBot) lastBotId = id;
    }
    if (lastBotId) {
      currentRoom.removeBot(lastBotId);
      emitLobbyUpdate(currentRoom);
      broadcastRoomList();
    }
  });

  // --- Start game ---
  onEvent("startGame", () => {
    if (!currentRoom || currentRoom.started || currentRoom.ownerId !== userId) return;
    currentRoom.start();
    io.to(currentRoom.id).emit("gameStarted");
    broadcastRoomChatHistory(currentRoom);
    broadcastRoomList();
    console.log(`Game started in ${currentRoom.id}`);
  });

  // --- Direction ---
  onEvent("direction", (dir) => {
    if (!currentRoom || isSpectator) return;
    const player = currentRoom.players.get(userId);
    if (!player || !player.alive) return;
    const opposites = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };
    if (opposites[dir] !== player.direction) {
      player.nextDir = dir;
    }
  });

  // --- Room chat for dead players and spectators ---
  onEvent("sendRoomChat", (data = {}) => {
    if (!currentRoom) return;
    if (!canUserUseRoomChat(currentRoom, userId)) {
      socket.emit("roomChatError", "Chat is only available to spectators and eliminated players.");
      return;
    }

    const rawText = typeof data.text === "string" ? data.text : "";
    const text = rawText.replace(/\s+/g, " ").trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
    if (!text) {
      socket.emit("roomChatError", "Type a message before sending.");
      return;
    }

    const spectator = currentRoom.spectators.get(userId);
    const player = currentRoom.players.get(userId);

    let senderName = playerName;
    let senderColor = "#88f";
    let role = "spectator";

    if (spectator) {
      senderName = spectator.name || playerName;
    } else if (player && !player.isBot && !player.alive) {
      senderName = player.name;
      senderColor = player.color;
      role = "dead";
    } else {
      socket.emit("roomChatError", "Chat is only available to spectators and eliminated players.");
      return;
    }

    const message = currentRoom.addChatMessage(userId, senderName, senderColor, text, role);
    emitRoomChatToEligible(currentRoom, "roomChatMessage", message);
  });

  // --- Restart ---
  onEvent("requestRestart", () => {
    if (!currentRoom || currentRoom.ownerId !== userId) return;
    currentRoom.reset();
    // Move spectators' promoted status back
    emitLobbyUpdate(currentRoom);
    io.to(currentRoom.id).emit("restarted");
    broadcastRoomList();
    console.log(`Game restarted in ${currentRoom.id}`);
  });

  // --- Leave room (go back to browser) ---
  onEvent("leaveRoom", () => {
    if (!currentRoom) return;
    clearPendingDisconnect(userId);
    socket.leave(currentRoom.id);
    if (isSpectator) {
      currentRoom.removeSpectator(userId);
    } else {
      currentRoom.removePlayer(userId);
    }
    emitLobbyUpdate(currentRoom);
    cleanupRoom(currentRoom);
    currentRoom = null;
    isSpectator = false;
    socket.emit("leftRoom");
    broadcastRoomList();
  });

  // --- Disconnect ---
  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id} as ${userId}`);
    if (activeConnections.get(userId) !== socket.id) {
      return;
    }

    activeConnections.delete(userId);
    if (currentRoom) {
      scheduleDisconnectCleanup(userId, currentRoom.id);
    }
  });
});

const portFromEnv = Number.parseInt(process.env.PORT || "", 10);
const PORT = Number.isInteger(portFromEnv) && portFromEnv > 0 ? portFromEnv : 30000;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Snake Multiplayer server running on http://${HOST}:${PORT}`);
});
