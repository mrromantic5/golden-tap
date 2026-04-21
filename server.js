/**
 * ═══════════════════════════════════════════════════════════════
 *   GOLDEN TAP — Real-Time Server  [FIXED v2.1]
 *   Node.js + Socket.IO + Express
 *   Deploy: GitHub → Render.com
 *
 *   FIX #3: Removed MySQL dependency — Render CANNOT connect
 *           to cPanel localhost. All DB ops stay in PHP.
 *           Node is a pure real-time relay + in-memory state.
 *   FIX #11: Added /invite and /game-result HTTP endpoints
 *            so game.php can trigger socket events via HTTP.
 *   Architecture: PHP = source of truth | Node = real-time relay
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');

/* ── Config ── */
const PORT           = process.env.PORT || 3000;
const JWT_SECRET     = process.env.JWT_SECRET || 'gt_jwt_32char_secret_key_production_change!';
const CLIENT_ORIGIN  = process.env.CLIENT_ORIGIN || 'https://g.tap.t-lyfe.com.ng';
const INTERNAL_KEY   = process.env.INTERNAL_API_KEY || 'gt_internal_key_change_this_in_prod';
const PHP_API_BASE   = process.env.PHP_API_BASE || 'https://g.tap.t-lyfe.com.ng/backend';

/* ── App ── */
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: [CLIENT_ORIGIN, /localhost/],
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout:  60000,
  pingInterval: 25000,
  transports:   ['websocket', 'polling']
});

/* ── Middleware ── */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: [CLIENT_ORIGIN, /localhost/], credentials: true }));
app.use(express.json({ limit: '512kb' }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' }
}));

/* ════════════════════════════════════════════════════════════════
   IN-MEMORY STATE  (resets on server restart — DB is source of truth)
════════════════════════════════════════════════════════════════ */
const onlineUsers  = new Map();   // socket.id → { user_id, username, avatar, level, socket_id }
const activeGames  = new Map();   // session_id → { players[], current_player_id, stake, ... }
const gameTimers   = new Map();   // session_id → timeout handle
const typingTimers = new Map();   // socket.id  → timeout handle

/* ── Helper: get online list ── */
function getOnlineList() {
  return [...onlineUsers.values()];
}

/* ── Helper: broadcast online users ── */
function broadcastOnline() {
  const list  = getOnlineList();
  const count = list.length;
  io.to('global').emit('online:count', count);
  io.to('global').emit('online:users', list);
}

/* ── Helper: verify internal PHP call ── */
function verifyInternal(req, res) {
  const key = req.headers['x-internal-key'];
  if (key !== INTERNAL_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/* ════════════════════════════════════════════════════════════════
   HTTP ENDPOINTS
════════════════════════════════════════════════════════════════ */

/* Health */
app.get('/', (req, res) => {
  res.json({
    name:        '💎 Golden Tap Real-Time Server',
    version:     '2.1.0',
    status:      'OK',
    online:      onlineUsers.size,
    activeGames: activeGames.size,
    uptime:      Math.floor(process.uptime()) + 's',
    timestamp:   new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

/* ─── FIX #11: /invite — called by game.php after invite is created ─── */
app.post('/invite', (req, res) => {
  if (!verifyInternal(req, res)) return;

  const { session_id, from_id, from_name, to_id, stake, currency } = req.body;
  if (!session_id || !to_id) return res.status(400).json({ error: 'Missing fields' });

  // Find the target user's socket
  let targetSocket = null;
  for (const [sid, u] of onlineUsers.entries()) {
    if (String(u.user_id) === String(to_id)) { targetSocket = sid; break; }
  }

  if (targetSocket) {
    io.to(targetSocket).emit('invite:received', {
      session_id, from_id, from_name, stake, currency
    });
    res.json({ success: true, delivered: true });
  } else {
    res.json({ success: true, delivered: false, reason: 'User offline' });
  }
});

/* ─── /game-result — called by game.php after PHP resolves a game ─── */
app.post('/game-result', (req, res) => {
  if (!verifyInternal(req, res)) return;

  const { session_id, winner_id, win_amount, currency, reason } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  io.to(`game:${session_id}`).emit('game:result', {
    won:        false,
    winner_id, win_amount, currency, reason,
    game_over:  true
  });

  // Clean up
  clearTimeout(gameTimers.get(session_id));
  gameTimers.delete(session_id);
  activeGames.delete(session_id);

  // Broadcast win to global feed
  if (winner_id && win_amount) {
    const winner = [...onlineUsers.values()].find(u => String(u.user_id) === String(winner_id));
    if (winner) {
      io.to('global').emit('win:broadcast', {
        username: winner.username,
        amount:   win_amount,
        currency: currency || 'GH₵'
      });
    }
  }

  res.json({ success: true });
});

/* ─── /balance-update — notify specific user of balance change ─── */
app.post('/balance-update', (req, res) => {
  if (!verifyInternal(req, res)) return;
  const { user_id, balance, currency } = req.body;
  for (const [sid, u] of onlineUsers.entries()) {
    if (String(u.user_id) === String(user_id)) {
      io.to(sid).emit('balance:update', { balance, currency });
      break;
    }
  }
  res.json({ success: true });
});

/* ─── /broadcast — general broadcast endpoint ─── */
app.post('/broadcast', (req, res) => {
  if (!verifyInternal(req, res)) return;
  const { event, data, room } = req.body;
  if (!event) return res.status(400).json({ error: 'Event required' });
  if (room) { io.to(room).emit(event, data); }
  else { io.to('global').emit(event, data); }
  res.json({ success: true });
});

/* ════════════════════════════════════════════════════════════════
   SOCKET.IO AUTH MIDDLEWARE
════════════════════════════════════════════════════════════════ */
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user   = decoded;
    next();
  } catch (e) {
    next(new Error('Invalid or expired token'));
  }
});

/* ════════════════════════════════════════════════════════════════
   SOCKET.IO EVENTS
════════════════════════════════════════════════════════════════ */
io.on('connection', (socket) => {
  const u = socket.user;
  console.log(`🔌 Connected: ${u.username} (${socket.id})`);

  /* ── User Online ── */
  socket.on('user:online', () => {
    onlineUsers.set(socket.id, {
      socket_id: socket.id,
      user_id:   u.id,
      username:  u.username,
      avatar:    u.avatar || null,
      level:     u.level  || 1
    });
    socket.join('global');
    broadcastOnline();
  });

  /* ── Game Join ── */
  socket.on('game:join', ({ session_id }) => {
    if (!session_id) return;
    socket.join(`game:${session_id}`);

    // Initialize minimal in-memory game state if not exists
    if (!activeGames.has(session_id)) {
      activeGames.set(session_id, {
        session_id,
        players:           [],
        current_player_id: u.id,
        status:            'active',
        created_at:        Date.now()
      });
    }

    // Add player to game state
    const game = activeGames.get(session_id);
    if (!game.players.find(p => p.user_id === u.id)) {
      game.players.push({ user_id: u.id, username: u.username, avatar: u.avatar || null });
    }

    // Set game timeout (5 minutes)
    if (!gameTimers.has(session_id)) {
      const timer = setTimeout(() => endGameTimeout(session_id), 5 * 60 * 1000);
      gameTimers.set(session_id, timer);
    }
  });

  /* ── Card Revealed (relay to opponent) ── */
  socket.on('game:card_revealed', ({ session_id, card_index, result, next_player_id }) => {
    if (!session_id) return;
    socket.to(`game:${session_id}`).emit('game:card_revealed', { card_index, result, next_player_id });
    if (next_player_id) {
      io.to(`game:${session_id}`).emit('game:turn_change', { current_player_id: next_player_id });
      const game = activeGames.get(session_id);
      if (game) game.current_player_id = next_player_id;
    }
  });

  /* ── Game Win Broadcast ── */
  socket.on('game:win_broadcast', ({ amount, currency }) => {
    io.to('global').emit('win:broadcast', {
      username: u.username,
      amount,
      currency: currency || 'GH₵'
    });
  });

  /* ────────────────────────────────────────────────────────────
     CHAT EVENTS
  ──────────────────────────────────────────────────────────── */

  /* ── Chat Join ── */
  socket.on('chat:join', () => {
    socket.join('chat:global');
    io.to('chat:global').emit('chat:online', getOnlineList());

    // Load persisted history from PHP/DB and send to joining user only
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    fetch(PHP_API_BASE + '/chat.php?action=history', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Requested-With': 'XMLHttpRequest'
      }
    })
    .then(r => r.json())
    .then(data => {
      if (data?.success && Array.isArray(data.messages)) {
        socket.emit('chat:history', data.messages);
      }
    })
    .catch(err => console.error('Chat history fetch error:', err));
  });

  /* ── Chat Send ── */
  socket.on('chat:send', ({ message, type, reply_to, reply_to_name, reply_to_text, voice_url, voice_duration }) => {
    if (!message && !voice_url) return;

    const clean = (message || '').replace(/<[^>]*>/g, '').substring(0, 1000);

    const msgPayload = {
      id:             Date.now(),  // Temporary ID — PHP assigns real DB ID
      user_id:        u.id,
      username:       u.username,
      avatar:         u.avatar || null,
      message:        clean,
      type:           type || 'text',
      voice_url:      voice_url || null,
      voice_duration: voice_duration || null,
      reply_to:       reply_to || null,
      reply_to_name:  reply_to_name || null,
      reply_to_text:  reply_to_text || null,
      reactions:      {},
      created_at:     new Date().toISOString()
    };

    io.to('chat:global').emit('chat:message', msgPayload);

    // Persist to DB via PHP (fire-and-forget)
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    fetch(PHP_API_BASE + '/chat.php?action=send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({
        message:        clean,
        type:           type || 'text',
        reply_to:       reply_to || null,
        voice_url:      voice_url || null,
        voice_duration: voice_duration || null
      })
    }).catch(err => console.error('Chat save error:', err));
  });

  /* ── Typing ── */
  socket.on('chat:typing', () => {
    socket.to('chat:global').emit('chat:typing', { user_id: u.id, username: u.username });
    // Auto-stop typing after 3s
    clearTimeout(typingTimers.get(socket.id));
    typingTimers.set(socket.id, setTimeout(() => {
      socket.to('chat:global').emit('chat:stop_typing', { user_id: u.id });
    }, 3000));
  });

  socket.on('chat:stop_typing', () => {
    clearTimeout(typingTimers.get(socket.id));
    socket.to('chat:global').emit('chat:stop_typing', { user_id: u.id });
  });

  /* ── Delete ── */
  socket.on('chat:delete', ({ message_id }) => {
    if (!message_id) return;
    io.to('chat:global').emit('chat:delete', { message_id });
  });

  /* ── React ── */
  socket.on('chat:react', ({ message_id, emoji }) => {
    if (!message_id || !emoji) return;
    io.to('chat:global').emit('chat:reaction', { message_id, emoji, user_id: u.id });
  });

  /* ── Balance Request ── */
  socket.on('balance:request', () => {
    // Client requests fresh balance — PHP will respond via HTTP balance-update
    // For now just acknowledge
    socket.emit('balance:ack', { message: 'Request received' });
  });

  /* ────────────────────────────────────────────────────────────
     DISCONNECT
  ──────────────────────────────────────────────────────────── */
  socket.on('disconnect', (reason) => {
    console.log(`🔌 Disconnected: ${u.username} — ${reason}`);

    onlineUsers.delete(socket.id);
    clearTimeout(typingTimers.get(socket.id));
    typingTimers.delete(socket.id);

    broadcastOnline();

    // Handle game disconnect
    for (const [session_id, game] of activeGames.entries()) {
      const isPlayer = game.players.some(p => p.user_id === u.id);
      if (isPlayer && game.status === 'active' && game.players.length > 1) {
        io.to(`game:${session_id}`).emit('game:opponent_disconnected', { disconnected_user_id: u.id });

        // Auto-win for remaining player after 30s if they don't reconnect
        setTimeout(() => {
          const g = activeGames.get(session_id);
          if (!g || g.status !== 'active') return;
          const winner = g.players.find(p => p.user_id !== u.id);
          if (!winner) return;
          io.to(`game:${session_id}`).emit('game:result', {
            won:        true,
            winner_id:  winner.user_id,
            reason:     'opponent_disconnected',
            game_over:  true
          });
          activeGames.delete(session_id);
          clearTimeout(gameTimers.get(session_id));
          gameTimers.delete(session_id);
        }, 30000);
      }
    }
  });
});

/* ════════════════════════════════════════════════════════════════
   GAME TIMEOUT HANDLER
════════════════════════════════════════════════════════════════ */
function endGameTimeout(session_id) {
  const game = activeGames.get(session_id);
  if (!game) return;
  io.to(`game:${session_id}`).emit('game:result', { won: false, game_over: true, reason: 'timeout' });
  activeGames.delete(session_id);
  gameTimers.delete(session_id);
}

/* ════════════════════════════════════════════════════════════════
   PERIODIC BROADCASTS (every 30s)
════════════════════════════════════════════════════════════════ */
setInterval(() => {
  if (io.sockets.sockets.size === 0) return;
  broadcastOnline();
}, 30000);

/* ════════════════════════════════════════════════════════════════
   GRACEFUL SHUTDOWN
════════════════════════════════════════════════════════════════ */
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received — shutting down');
  server.close(() => process.exit(0));
});

/* ════════════════════════════════════════════════════════════════
   START
════════════════════════════════════════════════════════════════ */
server.listen(PORT, () => {
  console.log(`🚀 Golden Tap Real-Time Server v2.1 on port ${PORT}`);
  console.log(`📡 Accepting connections from: ${CLIENT_ORIGIN}`);
  console.log(`🔐 JWT secret configured: ${JWT_SECRET.length >= 32 ? '✅' : '⚠️ TOO SHORT'}`);
  console.log(`🔑 Internal key configured: ${INTERNAL_KEY !== 'gt_internal_key_change_this_in_prod' ? '✅' : '⚠️ USING DEFAULT'}`);
});
