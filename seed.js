const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;

const sampleCustomers = [
  { id: 't01', name: 'Kath Miller', phone: '201-555-0101', status: 'called', date: new Date().toLocaleDateString('en-CA'), timestamp: Date.now() },
  { id: 't02', name: 'Joe Smith', phone: '201-555-0102', status: 'waiting', date: new Date().toLocaleDateString('en-CA'), timestamp: Date.now() + 1000 },
  { id: 't03', name: 'Sarah Davis', phone: '201-555-0103', status: 'waiting', date: new Date().toLocaleDateString('en-CA'), timestamp: Date.now() + 2000 },
  { id: 't04', name: 'Michael Brown', phone: '201-555-0104', status: 'waiting', date: new Date().toLocaleDateString('en-CA'), timestamp: Date.now() + 3000 },
  { id: 't05', name: 'Alex Johnson', phone: '201-555-0105', status: 'done', date: new Date().toLocaleDateString('en-CA'), timestamp: Date.now() + 4000 }
];

async function seed() {
  const state = {
    queue: sampleCustomers,
    currentServingId: 't01',
    location: { lat: null, lng: null, active: false, timestamp: null, ticketId: null }
  };

  if (DATABASE_URL) {
    console.log('Connecting to PostgreSQL database to seed test data...');
    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS queue_state (
          key VARCHAR(50) PRIMARY KEY,
          value JSONB NOT NULL
        )
      `);
      await pool.query(
        "INSERT INTO queue_state (key, value) VALUES ('state', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [JSON.stringify(state)]
      );
      console.log('Successfully pushed test customer data to PostgreSQL database!');
    } catch (err) {
      console.error('Error seeding PostgreSQL database:', err);
    } finally {
      await pool.end();
    }
  } else {
    console.log('No DATABASE_URL set. Writing test data to local data.json file...');
    fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(state, null, 2));
    console.log('Successfully created test customer data in local data.json file!');
  }
}

seed();
