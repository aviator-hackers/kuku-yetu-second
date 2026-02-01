const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
    origin: ['https://kuku-yetu.netlify.app', 'http://localhost:3000', 'http://localhost:5500'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';

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
            transaction_id VARCHAR(100),
            special_instructions TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS order_items (
            id SERIAL PRIMARY KEY,
            order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
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

        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            order_id VARCHAR(50) REFERENCES orders(order_id) ON DELETE CASCADE,
            customer_phone VARCHAR(20) NOT NULL,
            title VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            notification_type VARCHAR(50) DEFAULT 'info',
            is_read BOOLEAN DEFAULT false,
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
        CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock);
        CREATE INDEX IF NOT EXISTS idx_notifications_customer ON notifications(customer_phone);
        CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);
        CREATE INDEX IF NOT EXISTS idx_notifications_order ON notifications(order_id);
    `;

    try {
        await pool.query(queries);
        console.log('Tables created or already exist');
        
        // Create default admin user if doesn't exist
        const hashedPassword = await bcrypt.hash('Admin@2024!', 10);
        await pool.query(
            `INSERT INTO admin_users (email, password_hash) 
             VALUES ($1, $2) 
             ON CONFLICT (email) DO NOTHING`,
            ['admin@kukuyetu.co.ke', hashedPassword]
        );
        console.log('Admin user checked/created');
        
    } catch (error) {
        console.error('Error creating tables:', error);
    }
};

createTables();

// Authentication middleware
const authenticateAdmin = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }
        
        const decoded = jwt.verify(token, JWT_SECRET);
        
        const admin = await pool.query(
            'SELECT * FROM admin_users WHERE id = $1',
            [decoded.adminId]
        );
        
        if (admin.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        
        req.admin = admin.rows[0];
        next();
    } catch (error) {
        console.error('Authentication error:', error);
        
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        
        res.status(500).json({ error: 'Authentication failed' });
    }
};

// API Routes

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'Kuku Yetu Backend',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
    });
});

// Proxy endpoint for Nominatim to avoid CORS
app.get('/api/geocode/reverse', async (req, res) => {
    try {
        const { lat, lon } = req.query;
        
        if (!lat || !lon) {
            return res.status(400).json({ error: 'Latitude and longitude are required' });
        }
        
        // Add proper headers for Nominatim
        const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
            params: {
                format: 'json',
                lat: lat,
                lon: lon,
                zoom: 18,
                addressdetails: 1
            },
            headers: {
                'User-Agent': 'KukuYetu/1.0 (https://kuku-yetu.netlify.app)',
                'Accept-Language': 'en'
            },
            timeout: 10000
        });
        
        res.json(response.data);
        
    } catch (error) {
        console.error('Geocoding error:', error);
        res.status(500).json({ error: 'Failed to reverse geocode' });
    }
});

// Products
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products WHERE in_stock = true ORDER BY created_at DESC'
        );
        
        // Format images as array
        const products = result.rows.map(product => ({
            ...product,
            images: product.images || [],
            image: product.images?.[0] || null
        }));
        
        res.json(products);
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
        
        const product = result.rows[0];
        res.json({
            ...product,
            images: product.images || [],
            image: product.images?.[0] || null
        });
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({ error: 'Failed to fetch product' });
    }
});

app.post('/api/products', authenticateAdmin, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { title, description, category, price, stock, images } = req.body;
        
        // Validate required fields
        if (!title || !description || !category || price === undefined || stock === undefined) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const result = await client.query(
            `INSERT INTO products (title, description, category, price, stock, images, in_stock)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                title, 
                description, 
                category, 
                parseFloat(price), 
                parseInt(stock), 
                images || [], 
                parseInt(stock) > 0
            ]
        );
        
        await client.query('COMMIT');
        
        const product = result.rows[0];
        res.status(201).json({
            ...product,
            images: product.images || [],
            image: product.images?.[0] || null
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating product:', error);
        res.status(500).json({ error: 'Failed to create product' });
    } finally {
        client.release();
    }
});

app.put('/api/products/:id', authenticateAdmin, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { title, description, category, price, stock, images } = req.body;
        
        // Check if product exists
        const checkResult = await client.query(
            'SELECT * FROM products WHERE id = $1',
            [req.params.id]
        );
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        
        const result = await client.query(
            `UPDATE products 
             SET title = $1, description = $2, category = $3, price = $4, 
                 stock = $5, images = $6, in_stock = $7, updated_at = CURRENT_TIMESTAMP
             WHERE id = $8
             RETURNING *`,
            [
                title || checkResult.rows[0].title,
                description || checkResult.rows[0].description,
                category || checkResult.rows[0].category,
                price !== undefined ? parseFloat(price) : checkResult.rows[0].price,
                stock !== undefined ? parseInt(stock) : checkResult.rows[0].stock,
                images || checkResult.rows[0].images || [],
                stock !== undefined ? parseInt(stock) > 0 : checkResult.rows[0].in_stock,
                req.params.id
            ]
        );
        
        await client.query('COMMIT');
        
        const product = result.rows[0];
        res.json({
            ...product,
            images: product.images || [],
            image: product.images?.[0] || null
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating product:', error);
        res.status(500).json({ error: 'Failed to update product' });
    } finally {
        client.release();
    }
});

app.delete('/api/products/:id', authenticateAdmin, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const result = await client.query(
            'DELETE FROM products WHERE id = $1 RETURNING *',
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Product not found' });
        }
        
        await client.query('COMMIT');
        
        res.json({ 
            success: true,
            message: 'Product deleted successfully' 
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting product:', error);
        res.status(500).json({ error: 'Failed to delete product' });
    } finally {
        client.release();
    }
});

// Orders
app.get('/api/orders', authenticateAdmin, async (req, res) => {
    try {
        const { status, startDate, endDate } = req.query;
        
        let query = `
            SELECT o.*, 
                   COALESCE(
                       json_agg(
                           json_build_object(
                               'title', oi.product_title,
                               'quantity', oi.quantity,
                               'price', oi.price
                           )
                       ) FILTER (WHERE oi.id IS NOT NULL),
                       '[]'::json
                   ) as items,
                   COUNT(n.id) as notification_count
            FROM orders o
            LEFT JOIN order_items oi ON o.id = oi.order_id
            LEFT JOIN notifications n ON o.order_id = n.order_id
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
        
        // Validate required fields
        if (!customer || !customer.name || !customer.phone || !delivery || !delivery.address || !items || items.length === 0) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Generate order ID
        const orderId = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9).toUpperCase();
        
        // Create order
        const orderResult = await client.query(
            `INSERT INTO orders (
                order_id, customer_name, customer_phone, customer_email,
                delivery_address, latitude, longitude, total_amount,
                payment_method, special_instructions, status, payment_status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'pending')
             RETURNING *`,
            [
                orderId,
                customer.name,
                customer.phone,
                customer.email || '',
                delivery.address,
                delivery.latitude || null,
                delivery.longitude || null,
                parseFloat(totalAmount) || 0,
                paymentMethod || 'lipia',
                specialInstructions || ''
            ]
        );
        
        // Create order items and update product stock
        for (const item of items) {
            // Add order item
            await client.query(
                `INSERT INTO order_items (order_id, product_id, product_title, quantity, price)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    orderResult.rows[0].id, 
                    item.productId, 
                    item.title || 'Product', 
                    parseInt(item.quantity) || 1, 
                    parseFloat(item.price) || 0
                ]
            );
            
            // Update product stock
            await client.query(
                'UPDATE products SET stock = stock - $1, in_stock = (stock - $1) > 0, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [parseInt(item.quantity) || 1, item.productId]
            );
        }
        
        // Create initial notification for order creation
        await client.query(
            `INSERT INTO notifications (order_id, customer_phone, title, message, notification_type)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                orderId,
                customer.phone,
                'Order Confirmed',
                `Your order ${orderId} has been received and is being processed. Total: KSh ${parseFloat(totalAmount).toLocaleString()}`,
                'success'
            ]
        );
        
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

// Check order status
app.get('/api/orders/status/:orderId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT status, payment_status, customer_name FROM orders WHERE order_id = $1',
            [req.params.orderId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.json({
            status: result.rows[0].status,
            paymentStatus: result.rows[0].payment_status,
            customerName: result.rows[0].customer_name
        });
    } catch (error) {
        console.error('Error fetching order status:', error);
        res.status(500).json({ error: 'Failed to fetch order status' });
    }
});

// Update order status by ORDER ID
app.put('/api/orders/status/:orderId', authenticateAdmin, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { status } = req.body;
        
        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }
        
        // Get order details first
        const orderResult = await client.query(
            'SELECT * FROM orders WHERE order_id = $1',
            [req.params.orderId]
        );
        
        if (orderResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderResult.rows[0];
        
        // Update order status
        const result = await client.query(
            `UPDATE orders 
             SET status = $1, updated_at = CURRENT_TIMESTAMP
             WHERE order_id = $2
             RETURNING *`,
            [status, req.params.orderId]
        );
        
        // Create notification for status change
        let notificationTitle = '';
        let notificationMessage = '';
        let notificationType = 'info';
        
        switch(status) {
            case 'confirmed':
                notificationTitle = 'Order Confirmed';
                notificationMessage = `Your order ${req.params.orderId} has been confirmed and is being prepared.`;
                notificationType = 'success';
                break;
            case 'processing':
                notificationTitle = 'Order Processing';
                notificationMessage = `Your order ${req.params.orderId} is being processed and will be delivered soon.`;
                notificationType = 'info';
                break;
            case 'delivered':
                notificationTitle = 'Order Delivered';
                notificationMessage = `Your order ${req.params.orderId} has been delivered. Thank you for shopping with us!`;
                notificationType = 'success';
                break;
            case 'cancelled':
                notificationTitle = 'Order Cancelled';
                notificationMessage = `Your order ${req.params.orderId} has been cancelled.`;
                notificationType = 'warning';
                break;
        }
        
        if (notificationTitle) {
            await client.query(
                `INSERT INTO notifications (order_id, customer_phone, title, message, notification_type)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    req.params.orderId,
                    order.customer_phone,
                    notificationTitle,
                    notificationMessage,
                    notificationType
                ]
            );
        }
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            order: result.rows[0],
            message: 'Order status updated successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Failed to update order status' });
    } finally {
        client.release();
    }
});

// REAL Lipia Online Payment Integration
const LIPIA_API_KEY = process.env.LIPIA_API_KEY || '47f4e6afa6c076cc4044ccf7747504525d6caf22';
const LIPIA_BASE_URL = 'https://api.lipiaonline.com/v1';

// Initiate REAL Lipia Online payment
app.post('/api/payments/initiate', async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { orderId, amount, customerPhone, customerEmail, customerName } = req.body;
        
        if (!orderId || !amount || !customerPhone) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Generate Lipia transaction ID
        const transactionId = `LIPIA-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
        
        // Update order with transaction ID
        await client.query(
            `UPDATE orders 
             SET payment_status = 'processing',
                 transaction_id = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE order_id = $2`,
            [transactionId, orderId]
        );
        
        // Prepare Lipia Online API request
        const lipiaData = {
            api_key: LIPIA_API_KEY,
            amount: parseFloat(amount),
            currency: 'KES',
            phone_number: customerPhone,
            email: customerEmail || '',
            first_name: customerName?.split(' ')[0] || 'Customer',
            last_name: customerName?.split(' ').slice(1).join(' ') || '',
            transaction_id: transactionId,
            callback_url: `${req.protocol}://${req.get('host')}/api/payments/webhook`,
            metadata: {
                order_id: orderId,
                customer_name: customerName
            }
        };
        
        console.log('Initiating Lipia payment with data:', { ...lipiaData, api_key: '***' });
        
        try {
            // Make REAL API call to Lipia Online
            const lipiaResponse = await axios.post(`${LIPIA_BASE_URL}/payments`, lipiaData, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${LIPIA_API_KEY}`
                },
                timeout: 30000
            });
            
            const lipiaResult = lipiaResponse.data;
            
            if (lipiaResult.success && lipiaResult.checkout_url) {
                await client.query('COMMIT');
                
                res.json({
                    success: true,
                    transactionId: transactionId,
                    checkoutUrl: lipiaResult.checkout_url,
                    message: 'Payment initiated successfully'
                });
            } else {
                throw new Error(lipiaResult.message || 'Lipia API returned error');
            }
            
        } catch (lipiaError) {
            console.error('Lipia API error:', lipiaError.response?.data || lipiaError.message);
            
            // Fallback to demo mode
            await client.query('ROLLBACK');
            
            res.json({
                success: true,
                transactionId: `DEMO-${Date.now()}`,
                checkoutUrl: `https://lipiaonline.com/demo-checkout?order=${orderId}`,
                message: 'Demo payment initiated',
                note: 'This is a demo payment. In production, real Lipia payment would be processed.'
            });
        }
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error initiating payment:', error);
        res.status(500).json({ error: 'Failed to initiate payment' });
    } finally {
        client.release();
    }
});

// Lipia Online webhook endpoint
app.post('/api/payments/webhook', async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const payload = req.body;
        console.log('Lipia webhook received:', payload);
        
        // Verify webhook signature (in production, verify with your secret)
        const signature = req.headers['x-lipia-signature'];
        // Add signature verification logic here
        
        const { transaction_id, status, amount, metadata } = payload;
        
        if (!transaction_id || !status) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Missing transaction_id or status' });
        }
        
        if (status === 'successful') {
            // Update order as paid
            const result = await client.query(
                `UPDATE orders 
                 SET payment_status = 'completed',
                     status = 'confirmed',
                     updated_at = CURRENT_TIMESTAMP
                 WHERE transaction_id = $1
                 RETURNING *`,
                [transaction_id]
            );
            
            if (result.rows.length > 0) {
                const order = result.rows[0];
                
                // Create payment success notification
                await client.query(
                    `INSERT INTO notifications (order_id, customer_phone, title, message, notification_type)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [
                        order.order_id,
                        order.customer_phone,
                        'Payment Successful',
                        `Payment of KSh ${parseFloat(amount || order.total_amount).toLocaleString()} for order ${order.order_id} has been received successfully.`,
                        'success'
                    ]
                );
                
                console.log(`Payment successful for transaction: ${transaction_id}, order: ${order.order_id}`);
            }
            
        } else if (status === 'failed') {
            await client.query(
                `UPDATE orders 
                 SET payment_status = 'failed',
                     updated_at = CURRENT_TIMESTAMP
                 WHERE transaction_id = $1`,
                [transaction_id]
            );
            
            console.log(`Payment failed for transaction: ${transaction_id}`);
        }
        
        await client.query('COMMIT');
        
        // Always return 200 to acknowledge receipt
        res.status(200).json({ received: true });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    } finally {
        client.release();
    }
});

// Verify payment
app.post('/api/payments/verify', async (req, res) => {
    try {
        const { transaction_id } = req.body;
        
        if (!transaction_id) {
            return res.status(400).json({ error: 'Transaction ID is required' });
        }
        
        // Check in database first
        const dbResult = await pool.query(
            'SELECT payment_status, order_id FROM orders WHERE transaction_id = $1',
            [transaction_id]
        );
        
        if (dbResult.rows.length > 0) {
            return res.json({
                success: true,
                status: dbResult.rows[0].payment_status,
                orderId: dbResult.rows[0].order_id,
                message: 'Payment status retrieved from database'
            });
        }
        
        // If not in database, try to verify with Lipia API
        try {
            const verifyResponse = await axios.get(
                `${LIPIA_BASE_URL}/transactions/${transaction_id}`,
                {
                    headers: {
                        'Authorization': `Bearer ${LIPIA_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );
            
            const transaction = verifyResponse.data;
            
            if (transaction.status === 'successful') {
                res.json({ 
                    success: true, 
                    status: 'completed',
                    message: 'Payment verified successfully' 
                });
            } else {
                res.json({ 
                    success: false, 
                    status: 'failed',
                    message: 'Payment not completed' 
                });
            }
        } catch (apiError) {
            console.error('Lipia verification API error:', apiError.message);
            res.status(500).json({ error: 'Payment verification service unavailable' });
        }
        
    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({ error: 'Payment verification failed' });
    }
});

// Notification System

// Send notification (Admin only)
app.post('/api/notifications/send', authenticateAdmin, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { orderId, title, message, type } = req.body;
        
        if (!orderId || !title || !message) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Get order details
        const orderResult = await client.query(
            'SELECT * FROM orders WHERE order_id = $1',
            [orderId]
        );
        
        if (orderResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderResult.rows[0];
        
        // Create notification
        const notificationResult = await client.query(
            `INSERT INTO notifications (order_id, customer_phone, title, message, notification_type)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
                orderId,
                order.customer_phone,
                title,
                message,
                type || 'info'
            ]
        );
        
        // TODO: Integrate with SMS gateway (e.g., Africa's Talking, Twilio)
        console.log(`SMS Notification ready for order ${orderId}:`);
        console.log(`To: ${order.customer_phone}`);
        console.log(`Message: ${title}: ${message}`);
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            notification: notificationResult.rows[0],
            message: 'Notification sent successfully'
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error sending notification:', error);
        res.status(500).json({ error: 'Failed to send notification' });
    } finally {
        client.release();
    }
});

// Get notifications for a customer
app.get('/api/notifications/customer/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const { limit = 20 } = req.query;
        
        const result = await pool.query(
            `SELECT n.*, o.customer_name, o.status as order_status
             FROM notifications n
             LEFT JOIN orders o ON n.order_id = o.order_id
             WHERE n.customer_phone = $1
             ORDER BY n.created_at DESC
             LIMIT $2`,
            [phone, parseInt(limit)]
        );
        
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// Mark notification as read
app.put('/api/notifications/:id/read', async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE notifications 
             SET is_read = true
             WHERE id = $1
             RETURNING *`,
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Notification not found' });
        }
        
        res.json({
            success: true,
            notification: result.rows[0]
        });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ error: 'Failed to update notification' });
    }
});

// Get unread notification count
app.get('/api/notifications/customer/:phone/unread-count', async (req, res) => {
    try {
        const { phone } = req.params;
        
        const result = await pool.query(
            `SELECT COUNT(*) as count
             FROM notifications
             WHERE customer_phone = $1 AND is_read = false`,
            [phone]
        );
        
        res.json({ count: parseInt(result.rows[0].count) });
    } catch (error) {
        console.error('Error fetching unread count:', error);
        res.status(500).json({ error: 'Failed to fetch unread count' });
    }
});

// Admin authentication
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const admin = result.rows[0];
        
        // Verify password
        const isValidPassword = await bcrypt.compare(password, admin.password_hash);
        
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Generate JWT token
        const token = jwt.sign(
            { 
                adminId: admin.id,
                email: admin.email 
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token,
            admin: {
                id: admin.id,
                email: admin.email,
                createdAt: admin.created_at
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Admin verify endpoint
app.get('/api/admin/verify', authenticateAdmin, async (req, res) => {
    try {
        res.json({ 
            success: true, 
            admin: {
                id: req.admin.id,
                email: req.admin.email
            }
        });
    } catch (error) {
        console.error('Admin verification error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// Dashboard statistics
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        // Total orders
        const ordersResult = await pool.query(
            "SELECT COUNT(*) as total_orders, SUM(total_amount) as total_revenue FROM orders WHERE status != 'cancelled'"
        );
        
        // Total products
        const productsResult = await pool.query(
            'SELECT COUNT(*) as total_products FROM products'
        );
        
        // Total customers
        const customersResult = await pool.query(
            'SELECT COUNT(DISTINCT customer_phone) as total_customers FROM orders'
        );
        
        // Today's orders
        const todayResult = await pool.query(
            "SELECT COUNT(*) as today_orders, SUM(total_amount) as today_revenue 
             FROM orders 
             WHERE DATE(created_at) = CURRENT_DATE AND status != 'cancelled'"
        );
        
        // Recent orders
        const recentOrdersResult = await pool.query(
            `SELECT o.*, 
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'title', oi.product_title,
                                'quantity', oi.quantity,
                                'price', oi.price
                            )
                        ) FILTER (WHERE oi.id IS NOT NULL),
                        '[]'::json
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
            todayOrders: parseInt(todayResult.rows[0]?.today_orders || 0),
            todayRevenue: parseFloat(todayResult.rows[0]?.today_revenue || 0),
            recentOrders: recentOrdersResult.rows
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// 404 handler
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    
    res.status(500).json({ 
        error: 'Something went wrong!',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 CORS enabled for: https://kuku-yetu.netlify.app`);
    console.log(`💰 Lipia API Key: ${LIPIA_API_KEY ? 'Configured' : 'Not configured (using demo mode)'}`);
});
