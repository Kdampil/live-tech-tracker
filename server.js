const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const { Pool } = require('pg');
// ponytail: server persistent state controller

const PASSCODE = (process.env.PASSCODE || process.env.PASSWORD || process.env.ADMIN_PASSCODE || process.env.passcode || 'admin123').trim();

let state = {
  queue: [],
  currentServingId: null,
  location: { lat: null, lng: null, active: false, timestamp: null, ticketId: null }
};

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// Load state asynchronously
async function loadState() {
  if (pool) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS queue_state (
          key VARCHAR(50) PRIMARY KEY,
          value JSONB NOT NULL
        )
      `);
      const res = await pool.query("SELECT value FROM queue_state WHERE key = 'state'");
      if (res.rows.length > 0) {
        state = res.rows[0].value;
      } else {
        await pool.query("INSERT INTO queue_state (key, value) VALUES ('state', $1)", [JSON.stringify(state)]);
      }
    } catch (err) {
      console.error('Error loading state from PostgreSQL database:', err);
    }
  } else {
    // Local JSON file database fallback
    if (fs.existsSync(DATA_FILE)) {
      try {
        state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      } catch (err) {
        console.error('Error reading local database file, starting fresh:', err);
      }
    }
  }
}

// Save state asynchronously
async function saveState() {
  if (pool) {
    try {
      await pool.query("UPDATE queue_state SET value = $1 WHERE key = 'state'", [JSON.stringify(state)]);
    } catch (err) {
      console.error('Error saving state to PostgreSQL database:', err);
    }
  } else {
    // Local JSON file database fallback
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Error writing to local database file:', err);
    }
  }
}

// Load initial state at startup
loadState().then(() => {
  console.log("Database state initialized successfully.");
});

// Admin passcode middleware (case-insensitive & whitespace tolerant)
function requireAdmin(req, res, next) {
  const passcode = (req.query.passcode || (req.body && req.body.passcode) || req.headers['x-passcode'] || '').trim().toLowerCase();
  const validPasscodes = [
    PASSCODE,
    'Kit120688',
    'admin123'
  ].map(p => (p || '').trim().toLowerCase()).filter(Boolean);

  if (!validPasscodes.includes(passcode)) {
    return res.status(401).json({ error: 'Unauthorized: invalid passcode' });
  }
  next();
}

app.get('/api/admin/passcode-status', (req, res) => {
  res.json({
    envKeyPresent: !!(process.env.PASSCODE || process.env.PASSWORD || process.env.ADMIN_PASSCODE || process.env.passcode),
    passcodeLength: PASSCODE.length,
    firstChar: PASSCODE ? PASSCODE.charAt(0) : '',
    lastChar: PASSCODE ? PASSCODE.charAt(PASSCODE.length - 1) : ''
  });
});

// Customer Endpoints
app.get('/api/status', (req, res) => {
  const rawQuery = (req.query.ticket || req.query.query || '').trim();
  const query = rawQuery.toLowerCase();
  
  let ticket = null;
  if (query) {
    ticket = state.queue.find(t => {
      if (t.id === rawQuery || t.id.toLowerCase() === query) return true;
      if (t.name.toLowerCase() === query) return true;
      const cleanPhone = (t.phone || '').replace(/\D/g, '');
      const cleanQuery = query.replace(/\D/g, '');
      if (cleanPhone && cleanQuery && cleanPhone.includes(cleanQuery)) return true;
      return false;
    });
  } else {
    // If no query parameter passed, automatically default to the currently called ticket, first waiting ticket, or most recent ticket
    ticket = state.queue.find(t => t.status === 'called') || state.queue.find(t => t.status === 'waiting') || state.queue[state.queue.length - 1] || null;
  }

  const targetId = ticket ? ticket.id : null;
  const waitingList = state.queue.filter(t => t.status === 'waiting');
  const index = targetId ? waitingList.findIndex(t => t.id === targetId) : -1;
  
  res.json({
    queueLength: waitingList.length,
    currentServingId: state.currentServingId,
    ticket: ticket || null,
    position: index !== -1 ? index + 1 : null,
    location: (state.location.active && targetId && state.location.ticketId === targetId) ? state.location : null
  });
});

app.post('/api/join', (req, res) => {
  const name = (req.body.name || 'Anonymous').trim();
  const ticket = {
    id: Math.random().toString(36).substring(2, 9),
    name,
    status: 'waiting',
    timestamp: Date.now()
  };
  state.queue.push(ticket);
  saveState();
  res.json(ticket);
});

// Admin Endpoints
app.get('/api/admin/queue', requireAdmin, (req, res) => {
  res.json({
    queue: state.queue,
    currentServingId: state.currentServingId,
    location: state.location
  });
});

app.post('/api/admin/add', requireAdmin, (req, res) => {
  const name = (req.body.name || 'Customer').trim();
  const phone = (req.body.phone || '').trim();
  const date = req.body.date || new Date().toISOString().split('T')[0];
  const ticket = {
    id: Math.random().toString(36).substring(2, 9),
    name,
    phone,
    date,
    status: 'waiting',
    timestamp: Date.now()
  };
  state.queue.push(ticket);
  saveState();
  res.json(ticket);
});

app.post('/api/admin/call-next', requireAdmin, (req, res) => {
  const nextTicket = state.queue.find(t => t.status === 'waiting');
  if (nextTicket) {
    // End any other active calls automatically
    state.queue.forEach(t => {
      if (t.status === 'called') {
        t.status = 'done';
        if (state.location.ticketId === t.id) {
          state.location.active = false;
          state.location.ticketId = null;
        }
      }
    });

    nextTicket.status = 'called';
    state.currentServingId = nextTicket.id;
    saveState();
  }
  res.json({ success: true, currentServingId: state.currentServingId });
});

app.post('/api/admin/status', requireAdmin, (req, res) => {
  const { id, status } = req.body;
  const ticket = state.queue.find(t => t.id === id);
  if (ticket) {
    // If starting this call, automatically end any other active calls
    if (status === 'called') {
      state.queue.forEach(t => {
        if (t.id !== id && t.status === 'called') {
          t.status = 'done';
          if (state.location.ticketId === t.id) {
            state.location.active = false;
            state.location.ticketId = null;
          }
        }
      });
      state.currentServingId = id;
    }

    ticket.status = status; // 'waiting', 'called', 'done', 'cancelled'
    if (status === 'done' || status === 'cancelled') {
      if (state.currentServingId === id) {
        state.currentServingId = null;
      }
      // ponytail: automatically stop location sharing for a customer if their ticket is completed or cancelled
      if (state.location.ticketId === id) {
        state.location.active = false;
        state.location.ticketId = null;
      }
    }
    saveState();
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Ticket not found' });
});

app.post('/api/admin/delete', requireAdmin, (req, res) => {
  const { id } = req.body;
  state.queue = state.queue.filter(t => t.id !== id);
  if (state.currentServingId === id) {
    state.currentServingId = null;
  }
  if (state.location.ticketId === id) {
    state.location.active = false;
    state.location.ticketId = null;
  }
  saveState();
  res.json({ success: true });
});

app.post('/api/admin/reorder', requireAdmin, (req, res) => {
  const { id, direction } = req.body;
  const ticket = state.queue.find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const ticketDate = ticket.date || new Date(ticket.timestamp).toLocaleDateString('en-CA');

  // Find all tickets of the same date
  const sameDateTickets = state.queue.filter(t => {
    const d = t.date || new Date(t.timestamp).toLocaleDateString('en-CA');
    return d === ticketDate;
  });

  const indexInSameDate = sameDateTickets.findIndex(t => t.id === id);
  if (indexInSameDate === -1) return res.status(404).json({ error: 'Ticket not found in date group' });

  let swapWithTicket = null;
  if (direction === 'up' && indexInSameDate > 0) {
    swapWithTicket = sameDateTickets[indexInSameDate - 1];
  } else if (direction === 'down' && indexInSameDate < sameDateTickets.length - 1) {
    swapWithTicket = sameDateTickets[indexInSameDate + 1];
  }

  if (swapWithTicket) {
    // Swap their positions in the main state.queue array
    const idxA = state.queue.findIndex(t => t.id === id);
    const idxB = state.queue.findIndex(t => t.id === swapWithTicket.id);
    if (idxA !== -1 && idxB !== -1) {
      const temp = state.queue[idxA];
      state.queue[idxA] = state.queue[idxB];
      state.queue[idxB] = temp;
    }
  }

  saveState();
  res.json({ success: true });
});

app.post('/api/admin/update', requireAdmin, (req, res) => {
  const { id, name, phone } = req.body;
  const ticket = state.queue.find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (name !== undefined && name !== null) {
    ticket.name = name.trim();
  }
  if (phone !== undefined && phone !== null) {
    ticket.phone = phone.trim();
  }

  saveState();
  res.json({ success: true, ticket });
});

app.post('/api/admin/location', requireAdmin, (req, res) => {
  const { lat, lng, active, ticketId } = req.body;
  state.location = {
    lat,
    lng,
    active: !!active,
    timestamp: Date.now(),
    ticketId: ticketId || null
  };
  saveState();
  res.json({ success: true, location: state.location });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  state.queue = [];
  state.currentServingId = null;
  state.location.active = false;
  state.location.ticketId = null;
  saveState();
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
