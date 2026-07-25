const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');
const PASSCODE = process.env.PASSCODE || 'admin123';

// ponytail: local JSON file database for zero-dependency persistence
let state = {
  queue: [],
  currentServingId: null,
  location: { lat: null, lng: null, active: false, timestamp: null, ticketId: null }
};

if (fs.existsSync(DATA_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading database file, starting fresh:', err);
  }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// Admin passcode middleware
function requireAdmin(req, res, next) {
  const passcode = req.query.passcode || req.headers['x-passcode'];
  if (passcode !== PASSCODE) {
    return res.status(401).json({ error: 'Unauthorized: invalid passcode' });
  }
  next();
}

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
