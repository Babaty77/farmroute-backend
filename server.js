const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware configuration
app.use(cors());
app.use(express.json());

// PostgreSQL database connection pool using Neon DB
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Root health-check route
app.get('/', (req, res) => {
    res.send('FarmRoute Backend is live and running!');
});

// Get all agricultural listings
app.get('/api/listings', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM listings ORDER BY created_at DESC');
        res.json({
            status: "success",
            count: result.rows.length,
            listings: result.rows
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Database Error: ' + err.message);
    }
});

// Create a new agricultural listing
app.post('/api/listings', async (req, res) => {
    try {
        const { title, price, quantity, unit, category, image_url } = req.body;
        
        const newListing = await pool.query(
            'INSERT INTO listings (title, price, quantity, unit, category, image_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [title, price, quantity, unit, category, image_url]
        );

        res.status(201).json({
            status: "success",
            message: "Listing created successfully!",
            listing: newListing.rows[0]
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error: ' + err.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});