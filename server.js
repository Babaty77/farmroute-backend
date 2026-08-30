const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// AUTO-INITIALIZE AND SYNC SCHEMA
const initDb = async () => {
  try {
    // 1. Ensure all base tables exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(50) DEFAULT 'Grains',
        price DECIMAL(12, 2) NOT NULL,
        quantity INT NOT NULL,
        unit VARCHAR(50) DEFAULT 'kg',
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        item_id INT REFERENCES items(id) ON DELETE CASCADE,
        buyer_id INT REFERENCES users(id) ON DELETE CASCADE,
        quantity INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bids (
        id SERIAL PRIMARY KEY,
        item_id INT REFERENCES items(id) ON DELETE CASCADE,
        bidder_id INT REFERENCES users(id) ON DELETE CASCADE,
        bid_amount DECIMAL(12, 2) NOT NULL,
        quantity INT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Sync missing columns if table already existed
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE items ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'Grains';
    `);

    console.log("✅ Database schema synchronized with password_hash!");
  } catch (err) {
    console.error("❌ Error initializing database tables:", err.message);
  }
};

initDb();

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

// WEBSOCKET CONNECTION
io.on('connection', (socket) => {
  console.log('⚡ Client connected:', socket.id);
});

// AUTH MIDDLEWARE
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. Token missing.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token.' });
    req.user = user;
    next();
  });
};

// MARKET BENCHMARKS
const MARKET_BENCHMARKS = [
  { crop: "Yellow Maize", price: 42000, unit: "bag (100kg)", change: "+2.4%" },
  { crop: "Paddy Rice", price: 68000, unit: "bag (100kg)", change: "+1.8%" },
  { crop: "Soybeans", price: 58000, unit: "bag (100kg)", change: "-0.5%" },
  { crop: "Cocoa Beans", price: 11500000, unit: "ton", change: "+4.1%" },
  { crop: "Fresh Yam", price: 2500, unit: "tuber", change: "+0.0%" },
  { crop: "Cassava", price: 95000, unit: "ton", change: "-1.2%" }
];

app.get('/api/market-benchmarks', (req, res) => res.json(MARKET_BENCHMARKS));

// AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash) 
       VALUES ($1, $2, $3) 
       RETURNING id, name, email`,
      [name, email, hashedPassword]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("DETAILED REGISTER ERROR:", err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email is already registered.' });
    }
    res.status(400).json({ error: `Registration failed: ${err.message}` });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'User not found.' });

    const user = result.rows[0];
    const userPassword = user.password_hash || user.password;
    if (!userPassword) {
      return res.status(400).json({ error: 'Invalid user record. Please re-register.' });
    }

    const valid = await bcrypt.compare(password, userPassword);
    if (!valid) return res.status(400).json({ error: 'Invalid password.' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("DETAILED LOGIN ERROR:", err);
    res.status(500).json({ error: `Login failed: ${err.message}` });
  }
});

// ITEMS ENDPOINTS
app.get('/api/items', async (req, res) => {
  const { category, search } = req.query;
  try {
    let query = 'SELECT items.*, users.name as seller_name FROM items LEFT JOIN users ON items.user_id = users.id WHERE 1=1';
    const params = [];

    if (category && category !== 'All') {
      params.push(category);
      query += ` AND items.category = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND items.title ILIKE $${params.length}`;
    }

    query += ' ORDER BY items.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Fetch Items Error:", err.message);
    res.status(500).json({ error: 'Failed to fetch items.' });
  }
});

app.post('/api/items', authenticateToken, async (req, res) => {
  const { title, price, quantity, unit, category } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO items (title, price, quantity, unit, category, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [title, price, quantity, unit || 'kg', category || 'Grains', req.user.id]
    );
    io.emit('item_updated');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Create Item Error:", err.message);
    res.status(500).json({ error: 'Failed to create produce listing.' });
  }
});

app.delete('/api/items/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM items WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    io.emit('item_updated');
    res.json({ message: 'Item deleted.' });
  } catch (err) {
    console.error("Delete Item Error:", err.message);
    res.status(500).json({ error: 'Delete failed.' });
  }
});

// ORDERS ENDPOINTS
app.get('/api/orders/my-orders', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT orders.*, items.title, items.unit, users.name as seller_name 
      FROM orders 
      JOIN items ON orders.item_id = items.id 
      LEFT JOIN users ON items.user_id = users.id 
      WHERE orders.buyer_id = $1 
      ORDER BY orders.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Fetch Orders Error:", err.message);
    res.status(500).json({ error: 'Failed to fetch order history.' });
  }
});

app.post('/api/orders', authenticateToken, async (req, res) => {
  const { item_id, quantity } = req.body;
  try {
    const itemRes = await pool.query('SELECT * FROM items WHERE id = $1', [item_id]);
    if (itemRes.rows.length === 0) return res.status(404).json({ error: 'Item not found.' });
    if (itemRes.rows[0].quantity < quantity) return res.status(400).json({ error: 'Insufficient stock.' });

    await pool.query('UPDATE items SET quantity = quantity - $1 WHERE id = $2', [quantity, item_id]);
    const orderRes = await pool.query(
      'INSERT INTO orders (item_id, buyer_id, quantity) VALUES ($1, $2, $3) RETURNING *',
      [item_id, req.user.id, quantity]
    );

    io.emit('item_updated');
    res.status(201).json(orderRes.rows[0]);
  } catch (err) {
    console.error("Create Order Error:", err.message);
    res.status(500).json({ error: 'Order placement failed.' });
  }
});

// BIDS ENDPOINTS
app.post('/api/bids', authenticateToken, async (req, res) => {
  const { item_id, bid_amount, quantity } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO bids (item_id, bidder_id, bid_amount, quantity) VALUES ($1, $2, $3, $4) RETURNING *',
      [item_id, req.user.id, bid_amount, quantity]
    );
    io.emit('bid_placed', { item_id });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Create Bid Error:", err.message);
    res.status(500).json({ error: 'Bid submission failed.' });
  }
});

app.get('/api/bids/my-bids', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT bids.*, items.title, items.unit 
      FROM bids 
      JOIN items ON bids.item_id = items.id 
      WHERE bids.bidder_id = $1 
      ORDER BY bids.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Fetch Bids Error:", err.message);
    res.status(500).json({ error: 'Failed to fetch bid history.' });
  }
});

// FALLBACK ROUTE TO SERVE FRONTEND
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));