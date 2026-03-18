// ================== IMPORTS ==================
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const crypto = require('crypto');

// ================== APP INIT ==================
const app = express();
const server = http.createServer(app);

// ================== MIDDLEWARE ==================
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

// ================== LOGGER ==================
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

// ================== DATABASE POOL ==================
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 20,
    enableKeepAlive: true
});

// Test database connection
(async () => {
    try {
        const conn = await pool.getConnection();
        logger.info('✅ Database connected');
        conn.release();
    } catch (err) {
        logger.error('❌ Database connection failed:', err);
    }
})();

// ================== SOCKET.IO ==================
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

io.use((socket, next) => {
    try {
        const token = socket.handshake.auth.token;
        if (!token) throw new Error('No token');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.id;
        socket.orgId = decoded.org_id;
        next();
    } catch (err) {
        next(new Error('Authentication failed'));
    }
});

io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);
    socket.join(`org_${socket.orgId}`);
});

// ================== UTILITY FUNCTIONS ==================
const query = async (sql, params) => {
    const [results] = await pool.execute(sql, params);
    return results;
};

const generateToken = (payload) => {
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE });
};

// ================== AUTH MIDDLEWARE ==================
const auth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Authentication required' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const users = await query('SELECT id, email, org_id, role FROM users WHERE id = ?', [decoded.id]);
        
        if (users.length === 0) return res.status(401).json({ error: 'User not found' });
        
        req.user = users[0];
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// ================== API ROUTES ==================

// Register
app.post('/api/register', [
    body('email').isEmail(),
    body('password').isLength({ min: 6 }),
    body('orgName').notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password, orgName } = req.body;

        // Check if user exists
        const existing = await query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // Start transaction
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            // Create organization
            const [orgResult] = await connection.execute(
                'INSERT INTO organizations (name) VALUES (?)',
                [orgName]
            );
            const orgId = orgResult.insertId;

            // Create user
            const verificationToken = crypto.randomBytes(32).toString('hex');
            await connection.execute(
                `INSERT INTO users (email, password, org_id, role, verified, verification_token) 
                 VALUES (?, ?, ?, 'owner', false, ?)`,
                [email, hashedPassword, orgId, verificationToken]
            );

            await connection.commit();
            connection.release();

            logger.info(`New user registered: ${email}`);
            res.json({ success: true, message: 'Registration successful. Please check email for verification.' });

        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (err) {
        logger.error('Registration error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login
app.post('/api/login', [
    body('email').isEmail(),
    body('password').notEmpty()
], async (req, res) => {
    try {
        const { email, password } = req.body;

        const users = await query(
            'SELECT id, email, password, org_id, role, verified FROM users WHERE email = ?',
            [email]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = users[0];

        if (!user.verified) {
            return res.status(401).json({ error: 'Please verify your email first' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = generateToken({ id: user.id, org_id: user.org_id, role: user.role });

        await query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                org_id: user.org_id,
                role: user.role
            }
        });

    } catch (err) {
        logger.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get contacts
app.get('/api/contacts', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const offset = (page - 1) * limit;

        const contacts = await query(
            `SELECT * FROM contacts 
             WHERE org_id = ? 
             ORDER BY created_at DESC 
             LIMIT ? OFFSET ?`,
            [req.user.org_id, limit, offset]
        );

        const [countResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM contacts WHERE org_id = ?',
            [req.user.org_id]
        );

        res.json({
            contacts,
            total: countResult[0].total,
            page,
            pages: Math.ceil(countResult[0].total / limit)
        });

    } catch (err) {
        logger.error('Get contacts error:', err);
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});

// Create contact (public)
app.post('/api/contacts', [
    body('name').notEmpty(),
    body('email').isEmail(),
    body('message').notEmpty()
], async (req, res) => {
    try {
        const { name, email, phone, message } = req.body;

        // For public form, use org_id 1 (default)
        const result = await query(
            `INSERT INTO contacts (name, email, phone, message, org_id, status) 
             VALUES (?, ?, ?, ?, 1, 'new')`,
            [name, email, phone || null, message]
        );

        // Emit real-time notification
        io.to('org_1').emit('new-lead', {
            id: result.insertId,
            name,
            email,
            message,
            created_at: new Date()
        });

        logger.info(`New contact: ${name}`);
        res.json({ success: true, message: 'Thank you! We\'ll contact you soon.' });

    } catch (err) {
        logger.error('Create contact error:', err);
        res.status(500).json({ error: 'Failed to save contact' });
    }
});

// Update contact status
app.put('/api/contacts/:id', auth, async (req, res) => {
    try {
        const { status } = req.body;
        await query(
            'UPDATE contacts SET status = ? WHERE id = ? AND org_id = ?',
            [status, req.params.id, req.user.org_id]
        );
        res.json({ success: true });
    } catch (err) {
        logger.error('Update contact error:', err);
        res.status(500).json({ error: 'Update failed' });
    }
});

// Delete contact
app.delete('/api/contacts/:id', auth, async (req, res) => {
    try {
        await query(
            'DELETE FROM contacts WHERE id = ? AND org_id = ?',
            [req.params.id, req.user.org_id]
        );
        res.json({ success: true });
    } catch (err) {
        logger.error('Delete contact error:', err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Get analytics
app.get('/api/analytics', auth, async (req, res) => {
    try {
        // Total contacts
        const [total] = await pool.execute(
            'SELECT COUNT(*) as total FROM contacts WHERE org_id = ?',
            [req.user.org_id]
        );

        // Today's contacts
        const [today] = await pool.execute(
            `SELECT COUNT(*) as total FROM contacts 
             WHERE org_id = ? AND DATE(created_at) = CURDATE()`,
            [req.user.org_id]
        );

        // Monthly chart data
        const monthly = await query(
            `SELECT DATE(created_at) as date, COUNT(*) as count
             FROM contacts
             WHERE org_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             GROUP BY DATE(created_at)
             ORDER BY date`,
            [req.user.org_id]
        );

        res.json({
            total: total[0].total,
            today: today[0].total,
            monthly
        });

    } catch (err) {
        logger.error('Analytics error:', err);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Verify email
app.get('/api/verify-email', async (req, res) => {
    try {
        const { token } = req.query;
        await query(
            'UPDATE users SET verified = true, verification_token = NULL WHERE verification_token = ?',
            [token]
        );
        res.redirect('/login.html?verified=true');
    } catch (err) {
        res.redirect('/login.html?verified=false');
    }
});

// ================== FRONTEND ROUTES ==================
// All frontend routes handled by static files
// index.html, login.html, dashboard.html served from /public

// Catch-all for SPA - send to index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    logger.info(`🚀 Server running on http://localhost:${PORT}`);
    logger.info(`📊 Frontend: http://localhost:${PORT}`);
    logger.info(`🔌 API: http://localhost:${PORT}/api`);
});