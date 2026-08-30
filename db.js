const { Pool } = require('pg');
require('dotenv').config();

// Connect to PostgreSQL using the DATABASE_URL from .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = pool;