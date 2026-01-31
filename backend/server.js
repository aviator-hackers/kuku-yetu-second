const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
    origin: ['https://your-frontend.netlify.app', 'http://localhost:3000'],
    credentials: true
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error connecting to database:', err);
    } else {
        console.log('Connected to database successfully');
        release();
    }
});

// Create tables if they don't exist
const createTables = async () => {
    const queries = `
        CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            category VARCHAR(50),
            price DECIMAL(10,2) NOT NULL,
            stock INTEGER DEFAULT 0,
            in_stock BOOLEAN DEFAULT true,
            images TEXT[],
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            order_id VARCHAR(50) UNIQUE NOT NULL,
            customer_name VARCHAR(100) NOT NULL,
            customer_phone VARCHAR(20) NOT NULL,
            customer_email VARCHAR(100),
            delivery_address TEXT NOT NULL,
            latitude DECIMAL(10,6),
            longitude DECIMAL(10,6),
            total_amount DECIMAL(10,2) NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            payment_status VARCHAR(20) DEFAULT 'pending',
            payment_method VARCHAR(50),
            special_instructions TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS order_items (
            id SERIAL PRIMARY KEY,
            order_id INTEGER REFERENCES orders(id),
            product_id INTEGER REFERENCES products(id),
            product_title VARCHAR(255) NOT NULL,
            quantity INTEGER NOT NULL,
            price DECIMAL(10,2) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS admin_users (
            id SERIAL PRIMARY KEY,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
        CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock);
    `;

    try {
        await pool.query(queries);
        console.log('Tables created or already exist');
    } catch (error) {
        console.error('Error creating tables:', error);
    }
};

createTables();

// Authentication middleware
const authenticateAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
        // Verify token (you would use JWT in production)
        const admin = await pool.query(
            'SELECT * FROM admin_users WHERE id = $1',
            [token]
        );
        
        if (admin.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        
        req.admin = admin.rows[0];
        next();
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
};

// API Routes

// Products
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products WHERE in_stock = true ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products WHERE id = $1',
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({ error: 'Failed to fetch product' });
    }
});

app.post('/api/products', authenticateAdmin, async (req, res) => {
    try {
        const { title, description, category, price, stock, images } = req.body;
        
        const result = await pool.query(
            `INSERT INTO products (title, description, category, price, stock, images, in_stock)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [title, description, category, price, stock, images || [], stock > 0]
        );
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ error: 'Failed to create product' });
    }
});

app.put('/api/products/:id', authenticateAdmin, async (req, res) => {
    try {
        const { title, description, category, price, stock, images } = req.body;
        
        const result = await pool.query(
            `UPDATE products 
             SET title = $1, description = $2, category = $3, price = $4, 
                 stock = $5, images = $6, in_stock = $7, updated_at = CURRENT_TIMESTAMP
             WHERE id = $8
             RETURNING *`,
            [title, description, category, price, stock, images || [], stock > 0, req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({ error: 'Failed to update product' });
    }
});

app.delete('/api/products/:id', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM products WHERE id = $1 RETURNING *',
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        
        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ error: 'Failed to delete product' });
    }
});

// Orders
app.get('/api/orders', authenticateAdmin, async (req, res) => {
    try {
        const { status, startDate, endDate } = req.query;
        
        let query = `
            SELECT o.*, 
                   json_agg(
                       json_build_object(
                           'title', oi.product_title,
                           'quantity', oi.quantity,
                           'price', oi.price
                       )
                   ) as items
            FROM orders o
            LEFT JOIN order_items oi ON o.id = oi.order_id
        `;
        
        const params = [];
        const conditions = [];
        
        if (status && status !== 'all') {
            params.push(status);
            conditions.push(`o.status = $${params.length}`);
        }
        
        if (startDate) {
            params.push(startDate);
            conditions.push(`o.created_at >= $${params.length}`);
        }
        
        if (endDate) {
            params.push(endDate + ' 23:59:59');
            conditions.push(`o.created_at <= $${params.length}`);
        }
        
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        query += ' GROUP BY o.id ORDER BY o.created_at DESC';
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

app.post('/api/orders', async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const {
            customer,
            delivery,
            items,
            totalAmount,
            paymentMethod,
            specialInstructions
        } = req.body;
        
        // Generate order ID
        const orderId = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9).toUpperCase();
        
        // Create order
        const orderResult = await client.query(
            `INSERT INTO orders (
                order_id, customer_name, customer_phone, customer_email,
                delivery_address, latitude, longitude, total_amount,
                payment_method, special_instructions
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
                orderId,
                customer.name,
                customer.phone,
                customer.email,
                delivery.address,
                delivery.latitude,
                delivery.longitude,
                totalAmount,
                paymentMethod,
                specialInstructions || ''
            ]
        );
        
        // Create order items and update product stock
        for (const item of items) {
            // Add order item
            await client.query(
                `INSERT INTO order_items (order_id, product_id, product_title, quantity, price)
                 VALUES ($1, $2, $3, $4, $5)`,
                [orderResult.rows[0].id, item.productId, item.title, item.quantity, item.price]
            );
            
            // Update product stock
            await client.query(
                'UPDATE products SET stock = stock - $1, in_stock = (stock - $1) > 0 WHERE id = $2',
                [item.quantity, item.productId]
            );
        }
        
        await client.query('COMMIT');
        
        res.status(201).json({
            success: true,
            orderId,
            message: 'Order created successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating order:', error);
        res.status(500).json({ error: 'Failed to create order' });
    } finally {
        client.release();
    }
});

app.put('/api/orders/:id/status', authenticateAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [status, req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Failed to update order status' });
    }
});

// Lipia Online Payment Integration
const LIPIA_API_KEY = process.env.LIPIA_API_KEY || '47f4e6afa6c076cc4044ccf7747504525d6caf22';
const LIPIA_BASE_URL = 'https://api.lipiaonline.com/v1';

app.post('/api/payments/initiate', async (req, res) => {
    try {
        const { orderId, amount, customerPhone, customerEmail, customerName } = req.body;
        
        // In production, use actual Lipia Online API
        // const response = await axios.post(`${LIPIA_BASE_URL}/payments`, {
        //     api_key: LIPIA_API_KEY,
        //     amount: amount,
        //     currency: 'KES',
        //     phone_number: customerPhone,
        //     email: customerEmail,
        //     transaction_id: orderId,
        //     callback_url: `${process.env.BACKEND_URL}/api/payments/callback`
        // });
        
        // For demo, simulate payment initiation
        const transactionId = 'LIPIA-' + Date.now();
        
        // Store transaction in database
        await pool.query(
            `UPDATE orders 
             SET payment_status = 'processing',
                 transaction_id = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE order_id = $2`,
            [transactionId, orderId]
        );
        
        res.json({
            success: true,
            transactionId,
            checkoutUrl: `https://lipiaonline.com/checkout/${transactionId}`,
            message: 'Payment initiated successfully'
        });
    } catch (error) {
        console.error('Error initiating payment:', error);
        res.status(500).json({ error: 'Failed to initiate payment' });
    }
});

// Payment webhook callback
app.post('/api/payments/callback', async (req, res) => {
    try {
        const { transaction_id, status, amount } = req.body;
        
        // Verify the callback is from Lipia Online
        // In production, verify signature
        
        let paymentStatus = 'failed';
        let orderStatus = 'pending';
        
        if (status === 'success') {
            paymentStatus = 'completed';
            orderStatus = 'confirmed';
        }
        
        // Update order in database
        await pool.query(
            `UPDATE orders 
             SET payment_status = $1, 
                 status = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE transaction_id = $3`,
            [paymentStatus, orderStatus, transaction_id]
        );
        
        res.json({ success: true, message: 'Callback processed' });
    } catch (error) {
        console.error('Error processing payment callback:', error);
        res.status(500).json({ error: 'Failed to process callback' });
    }
});

// Admin authentication
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // In production, use bcrypt to verify password
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const admin = result.rows[0];
        
        // Simple password check (in production, use bcrypt.compare)
        if (password === process.env.ADMIN_PASSWORD) {
            // Generate token (in production, use JWT)
            const token = admin.id.toString();
            
            res.json({
                success: true,
                token,
                admin: {
                    id: admin.id,
                    email: admin.email
                }
            });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Dashboard statistics
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        const ordersResult = await pool.query(
            "SELECT COUNT(*) as total_orders, SUM(total_amount) as total_revenue FROM orders WHERE status != 'cancelled'"
        );
        
        const productsResult = await pool.query(
            'SELECT COUNT(*) as total_products FROM products'
        );
        
        const customersResult = await pool.query(
            'SELECT COUNT(DISTINCT customer_phone) as total_customers FROM orders'
        );
        
        const recentOrdersResult = await pool.query(
            `SELECT o.*, 
                    json_agg(
                        json_build_object(
                            'title', oi.product_title,
                            'quantity', oi.quantity,
                            'price', oi.price
                        )
                    ) as items
             FROM orders o
             LEFT JOIN order_items oi ON o.id = oi.order_id
             GROUP BY o.id
             ORDER BY o.created_at DESC
             LIMIT 5`
        );
        
        res.json({
            totalOrders: parseInt(ordersResult.rows[0]?.total_orders || 0),
            totalRevenue: parseFloat(ordersResult.rows[0]?.total_revenue || 0),
            totalProducts: parseInt(productsResult.rows[0]?.total_products || 0),
            totalCustomers: parseInt(customersResult.rows[0]?.total_customers || 0),
            recentOrders: recentOrdersResult.rows
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});