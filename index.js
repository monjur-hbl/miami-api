/**
 * Miami Beach Resort - Unified Backend API v3.0
 * Fixed: Proper parameter passing to Beds24 API V2
 *
 * Endpoints:
 * - GET /                     - Health check
 * - GET /getBookings          - Proxy to Beds24 API (ALL params supported)
 * - GET /getRooms             - Get rooms and units
 * - POST /webhook/booking     - Receives Beds24 webhooks
 * - GET /notifications        - Get recent booking notifications
 * - HK endpoints              - All housekeeping functionality
 */

const express = require('express');
const cors = require('cors');
const { Firestore } = require('@google-cloud/firestore');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 8080;

// Initialize Firestore
const db = new Firestore({
    projectId: 'beds24-483408',
    databaseId: 'hk-miami'
});

// Collections
const notificationsCollection = db.collection('booking_notifications');
const hkDataCollection = db.collection('housekeeping_data');
const hkUsersCollection = db.collection('hk_users');
const otpCollection = db.collection('otp_codes');
const bookingCacheCollection = db.collection('booking_cache');
const dashboardDataCollection = db.collection('dashboard_data');

// Beds24 API Configuration
const BEDS24_API_URL = 'https://api.beds24.com/v2';
const BEDS24_TOKEN = process.env.BEDS24_TOKEN || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJBdXRoZW50aWNhdGlvblNlcnZlciIsInN1YiI6IjE2MjA5OSIsImF1ZCI6IkJlZHMyNEFQSVYyIiwiaWF0IjoxNzM0NDQxOTQwLCJuYmYiOjE3MzQ0NDE5NDAsImV4cCI6MTg5MjIwODM0MCwidG9rZW5JZCI6NzkyMzcsInJlZnJlc2giOmZhbHNlLCJhcGlBY2Nlc3MiOnRydWUsImludml0ZSI6ZmFsc2UsImNsaWVudCI6InRva2VuIiwic2NvcGVzIjpbImJvb2tpbmdzIiwiaW52b2ljZXMiXX0.H6HfJMgPaLlW9hREAy1x1JjAqh-MlPbr_gNRwwdh2uyK1nY-m2f-8Npc9Ygxf-H9Gqv_WMsJNkPjWGmLVrP9rH3n-M5GnQOxrfYgqCJlJxMzLMPjhLk3N5Yk7QQZ2Cxw';
const PROPERTY_ID = 279646;

// Email Configuration
const emailUser = process.env.EMAIL_USER || 'me.shovon@gmail.com';
const emailPass = process.env.EMAIL_PASS || 'cayqfuwnmenowljd';

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: emailUser, pass: emailPass }
});

// CORS Configuration
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// HELPER: Fetch from Beds24 API with proper headers
// ============================================================
async function fetchBeds24(endpoint, params = {}) {
    const url = new URL(`${BEDS24_API_URL}/${endpoint}`);

    // Add all params to URL
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.append(key, value);
        }
    });

    console.log(`📡 Beds24 API: ${url.toString()}`);

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'token': BEDS24_TOKEN,
            'Content-Type': 'application/json'
        }
    });

    return response.json();
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
    res.json({
        status: 'Miami Beach Resort API v3.0',
        services: ['beds24-proxy', 'housekeeping', 'webhooks', 'notifications'],
        propertyId: PROPERTY_ID,
        timestamp: new Date().toISOString(),
        endpoints: {
            bookings: '/getBookings?filter=current|arrivals|departures',
            rooms: '/getRooms',
            webhook: 'POST /webhook/booking',
            notifications: '/notifications'
        }
    });
});

// ============================================================
// BEDS24 PROXY - FIXED: Passes ALL query parameters
// ============================================================

// Supported Beds24 booking parameters (from API V2 spec)
const BOOKING_PARAMS = [
    'filter',           // arrivals, departures, new, current
    'propertyId',
    'roomId',
    'id',
    'masterId',
    'apiReference',
    'channel',
    'arrival',
    'arrivalFrom',
    'arrivalTo',
    'departure',
    'departureFrom',
    'departureTo',
    'bookingTimeFrom',
    'bookingTimeTo',
    'modifiedFrom',
    'modifiedTo',
    'searchString',
    'includeInvoiceItems',
    'includeInfoItems',
    'includeGuests',
    'includeBookingGroup',
    'status',
    'page'
];

app.get('/getBookings', async (req, res) => {
    try {
        // Build params object from query - pass through ALL supported params
        const params = { propertyId: PROPERTY_ID };

        BOOKING_PARAMS.forEach(param => {
            if (req.query[param] !== undefined) {
                params[param] = req.query[param];
            }
        });

        const data = await fetchBeds24('bookings', params);

        // Standardize response format
        if (data.success === false) {
            return res.status(400).json(data);
        }

        res.json({
            success: true,
            type: 'booking',
            count: data.data?.length || 0,
            pages: data.pages || null,
            data: data.data || []
        });

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get rooms and units
app.get('/getRooms', async (req, res) => {
    try {
        const data = await fetchBeds24(`properties/${PROPERTY_ID}/rooms`);
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generic proxy for any Beds24 endpoint
app.get('/beds24/:endpoint(*)', async (req, res) => {
    try {
        const data = await fetchBeds24(req.params.endpoint, req.query);
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST to Beds24 (for creating/updating bookings)
app.post('/beds24/:endpoint(*)', async (req, res) => {
    try {
        const url = `${BEDS24_API_URL}/${req.params.endpoint}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'token': BEDS24_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// OPTIMIZED: Get all bookings for dashboard (parallel fetch)
// ============================================================
app.get('/dashboard/bookings', async (req, res) => {
    try {
        const startTime = Date.now();

        // Parallel fetch: current occupancy + future bookings
        const [currentData, futureData] = await Promise.all([
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'current' }),
            fetchBeds24('bookings', {
                propertyId: PROPERTY_ID,
                arrivalFrom: new Date().toISOString().slice(0, 10),
                arrivalTo: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
            })
        ]);

        // Combine and deduplicate
        const allBookings = [...(currentData.data || []), ...(futureData.data || [])];
        const seen = new Set();
        const uniqueBookings = allBookings.filter(b => {
            if (seen.has(b.id)) return false;
            seen.add(b.id);
            return true;
        });

        // Filter out cancelled
        const activeBookings = uniqueBookings.filter(b => b.status !== 'cancelled');

        const loadTime = Date.now() - startTime;
        console.log(`✅ Dashboard bookings: ${activeBookings.length} in ${loadTime}ms`);

        res.json({
            success: true,
            count: activeBookings.length,
            loadTime,
            data: activeBookings
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// WEBHOOK ENDPOINT - Receives Beds24 booking notifications
// ============================================================

app.post('/webhook/booking', async (req, res) => {
    try {
        console.log('=== WEBHOOK RECEIVED ===');
        console.log('Body:', JSON.stringify(req.body, null, 2));

        const webhookData = req.body;

        // Create notification document
        const notification = {
            type: 'booking_update',
            bookingId: webhookData.id || webhookData.bookingId || null,
            propertyId: webhookData.propertyId || PROPERTY_ID,
            action: determineAction(webhookData),
            guestName: webhookData.firstName ?
                `${webhookData.firstName} ${webhookData.lastName || ''}`.trim() :
                'Unknown Guest',
            roomId: webhookData.roomId || null,
            unitId: webhookData.unitId || null,
            arrival: webhookData.arrival || null,
            departure: webhookData.departure || null,
            status: webhookData.status || null,
            receivedAt: Firestore.FieldValue.serverTimestamp(),
            processed: false,
            rawData: webhookData
        };

        const docRef = await notificationsCollection.add(notification);
        console.log(`Notification saved: ${docRef.id}`);

        // Respond to Beds24 immediately
        res.status(200).json({
            success: true,
            notificationId: docRef.id,
            message: 'Webhook received'
        });

        // Auto-cleanup old notifications
        cleanupOldNotifications();

    } catch (error) {
        console.error('Webhook error:', error);
        res.status(200).json({ success: false, error: error.message });
    }
});

function determineAction(data) {
    if (data.cancelTime) return 'cancelled';
    if (data.status === 'request') return 'new_request';
    if (data.bookingTime && data.modifiedTime && data.bookingTime === data.modifiedTime) {
        return 'new_booking';
    }
    return 'modified';
}

async function cleanupOldNotifications() {
    try {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const oldDocs = await notificationsCollection
            .where('receivedAt', '<', cutoff)
            .get();

        if (oldDocs.size > 0) {
            const batch = db.batch();
            oldDocs.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            console.log(`Cleaned up ${oldDocs.size} old notifications`);
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

// ============================================================
// NOTIFICATIONS API
// ============================================================

app.get('/notifications', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;

        const snapshot = await notificationsCollection
            .orderBy('receivedAt', 'desc')
            .limit(limit)
            .get();

        const notifications = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            receivedAt: doc.data().receivedAt?.toDate?.() || null
        }));

        res.json({ success: true, count: notifications.length, notifications });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/notifications/:id', async (req, res) => {
    try {
        await notificationsCollection.doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/notifications', async (req, res) => {
    try {
        const snapshot = await notificationsCollection.get();
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        res.json({ success: true, deleted: snapshot.size });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// DASHBOARD DATA PERSISTENCE (Firestore backup)
// ============================================================

// Save dashboard state
app.post('/dashboard/save', async (req, res) => {
    try {
        const { type, data } = req.body;
        if (!type) return res.status(400).json({ error: 'Missing type' });

        await dashboardDataCollection.doc(type).set({
            data,
            updatedAt: Firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, type });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Load dashboard state
app.get('/dashboard/load/:type', async (req, res) => {
    try {
        const doc = await dashboardDataCollection.doc(req.params.type).get();
        if (doc.exists) {
            res.json({ success: true, data: doc.data().data });
        } else {
            res.json({ success: true, data: null });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// HOUSEKEEPING API
// ============================================================

app.post('/save', async (req, res) => {
    try {
        const { type, data, timestamp } = req.body;
        if (!type) return res.status(400).json({ error: 'Missing type' });

        await hkDataCollection.doc(type).set({
            data,
            timestamp: timestamp || new Date().toISOString(),
            updatedAt: Firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, type });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/load', async (req, res) => {
    try {
        const { type } = req.query;
        if (!type) return res.status(400).json({ error: 'Missing type' });

        const doc = await hkDataCollection.doc(type).get();
        if (!doc.exists) return res.json({ data: null });

        res.json({ data: doc.data().data, timestamp: doc.data().timestamp });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// USER MANAGEMENT
// ============================================================

app.get('/users', async (req, res) => {
    try {
        const snapshot = await hkUsersCollection.get();
        const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/users', async (req, res) => {
    try {
        const user = { ...req.body, createdAt: Firestore.FieldValue.serverTimestamp() };
        const docRef = await hkUsersCollection.add(user);
        res.json({ success: true, id: docRef.id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/users/:id', async (req, res) => {
    try {
        await hkUsersCollection.doc(req.params.id).update(req.body);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/users/:id', async (req, res) => {
    try {
        await hkUsersCollection.doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// AUTHENTICATION (OTP)
// ============================================================

app.post('/auth/send-otp', async (req, res) => {
    try {
        const { email } = req.body;

        const usersSnapshot = await hkUsersCollection.where('email', '==', email).get();
        if (usersSnapshot.empty) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const user = { id: usersSnapshot.docs[0].id, ...usersSnapshot.docs[0].data() };
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await otpCollection.doc(email).set({ otp, expiresAt, attempts: 0, userId: user.id });

        await transporter.sendMail({
            from: `"Miami Beach Resort" <${emailUser}>`,
            to: email,
            subject: 'Your Login Code - Miami Beach Resort',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #2D6A6A;">Miami Beach Resort</h2>
                    <p>Your login code is:</p>
                    <div style="font-size: 32px; font-weight: bold; color: #2D6A6A; letter-spacing: 5px; padding: 20px; background: #f0f9f9; border-radius: 8px; text-align: center;">
                        ${otp}
                    </div>
                    <p style="color: #666; margin-top: 20px;">This code expires in 10 minutes.</p>
                </div>
            `
        });

        res.json({ success: true, message: 'OTP sent' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/auth/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;

        const otpDoc = await otpCollection.doc(email).get();
        if (!otpDoc.exists) {
            return res.status(400).json({ success: false, error: 'No OTP found' });
        }

        const otpData = otpDoc.data();

        if (new Date() > otpData.expiresAt.toDate()) {
            await otpCollection.doc(email).delete();
            return res.status(400).json({ success: false, error: 'OTP expired' });
        }

        if (otpData.otp !== otp) {
            const attempts = (otpData.attempts || 0) + 1;
            if (attempts >= 3) {
                await otpCollection.doc(email).delete();
                return res.status(400).json({ success: false, error: 'Too many attempts' });
            }
            await otpCollection.doc(email).update({ attempts });
            return res.status(400).json({ success: false, error: 'Invalid OTP' });
        }

        const userDoc = await hkUsersCollection.doc(otpData.userId).get();
        await otpCollection.doc(email).delete();

        res.json({ success: true, user: { id: userDoc.id, ...userDoc.data() } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
    console.log(`🚀 Miami Beach Resort API v3.0 running on port ${PORT}`);
    console.log(`   Property ID: ${PROPERTY_ID}`);
    console.log(`   Endpoints: /getBookings, /getRooms, /webhook/booking, /notifications`);
    console.log(`   Dashboard: /dashboard/bookings (optimized parallel fetch)`);
});
