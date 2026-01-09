/**
 * Miami Beach Resort - Unified Backend API v4.0
 *
 * MIXED STRATEGY:
 * - API: Primary data source for bookings, rooms, creating/updating
 * - Webhook: Backup for real-time updates, syncs to Firestore cache
 * - Firestore: Persistent cache, serves as fallback when API fails
 *
 * Based on Beds24 API V2 spec: https://beds24.com/api/v2/apiV2.yaml
 */

const express = require('express');
const cors = require('cors');
const { Firestore } = require('@google-cloud/firestore');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 8080;

// ============================================================
// CONFIGURATION
// ============================================================

const BEDS24_API_URL = 'https://api.beds24.com/v2';
const BEDS24_TOKEN = process.env.BEDS24_TOKEN || process.env.BEDS24_REFRESH_TOKEN;
const PROPERTY_ID = 279646;

// Email Configuration
const emailUser = process.env.EMAIL_USER || 'me.shovon@gmail.com';
const emailPass = process.env.EMAIL_PASS || 'cayqfuwnmenowljd';

// Initialize Firestore
const db = new Firestore({
    projectId: 'beds24-483408',
    databaseId: 'hk-miami'
});

// Collections
const bookingCacheCollection = db.collection('booking_cache');
const notificationsCollection = db.collection('booking_notifications');
const hkDataCollection = db.collection('housekeeping_data');
const hkUsersCollection = db.collection('hk_users');
const otpCollection = db.collection('otp_codes');
const dashboardDataCollection = db.collection('dashboard_data');
const roomsCacheCollection = db.collection('rooms_cache');

// In-memory cache for faster responses
let memoryCache = {
    bookings: { data: null, timestamp: 0, ttl: 60000 }, // 1 min TTL
    rooms: { data: null, timestamp: 0, ttl: 3600000 }   // 1 hour TTL
};

// Rate limit tracking
let rateLimitInfo = {
    remaining: 1000,
    resetsIn: 0,
    lastUpdated: 0
};

// Email transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: emailUser, pass: emailPass }
});

// CORS & Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// BEDS24 API HELPER - With Rate Limit Awareness
// ============================================================

async function fetchBeds24(endpoint, params = {}, method = 'GET', body = null) {
    const url = new URL(`${BEDS24_API_URL}/${endpoint}`);

    // Add query params for GET requests
    if (method === 'GET') {
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.append(key, value);
            }
        });
    }

    console.log(`📡 Beds24 ${method}: ${url.toString()}`);

    const options = {
        method,
        headers: {
            'token': BEDS24_TOKEN,
            'Content-Type': 'application/json'
        }
    };

    if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), options);

    // Track rate limits from response headers
    const remaining = response.headers.get('X-FiveMinCreditLimit-Remaining');
    const resetsIn = response.headers.get('X-FiveMinCreditLimit-ResetsIn');
    const requestCost = response.headers.get('X-RequestCost');

    if (remaining) {
        rateLimitInfo = {
            remaining: parseInt(remaining),
            resetsIn: parseInt(resetsIn || 0),
            requestCost: parseInt(requestCost || 1),
            lastUpdated: Date.now()
        };
        console.log(`⚡ Rate limit: ${remaining} credits remaining`);
    }

    const data = await response.json();

    // Handle API errors
    if (data.success === false || data.error) {
        throw new Error(data.error || 'API request failed');
    }

    return { data, status: response.status, headers: response.headers };
}

// ============================================================
// HEALTH CHECK & STATUS
// ============================================================

app.get('/', (req, res) => {
    res.json({
        status: 'Miami Beach Resort API v4.0',
        strategy: 'API primary + Webhook backup + Firestore cache',
        propertyId: PROPERTY_ID,
        timestamp: new Date().toISOString(),
        rateLimit: rateLimitInfo,
        cache: {
            bookings: memoryCache.bookings.data ? `${memoryCache.bookings.data.length} items` : 'empty',
            rooms: memoryCache.rooms.data ? `${memoryCache.rooms.data.length} rooms` : 'empty'
        },
        endpoints: {
            // Booking endpoints
            getBookings: 'GET /getBookings - All bookings with filters',
            createBooking: 'POST /bookings - Create/update bookings',

            // Room endpoints
            getRooms: 'GET /getRooms - All rooms and units',

            // Dashboard optimized
            dashboard: 'GET /dashboard/data - Optimized dashboard data',

            // Webhook
            webhook: 'POST /webhook/booking - Beds24 webhook receiver',

            // Cache management
            refreshCache: 'POST /cache/refresh - Force refresh all caches'
        }
    });
});

// ============================================================
// BOOKINGS API - Full parameter support per API V2 spec
// ============================================================

// All supported booking query parameters from API V2 spec
const BOOKING_PARAMS = [
    // Filters
    'filter',           // arrivals | departures | new | current
    'status',           // confirmed | request | new | cancelled | black | inquiry
    'channel',          // airbnb, booking.com, etc

    // IDs (support multiple values)
    'propertyId', 'roomId', 'id', 'masterId', 'apiReference',

    // Date filters
    'arrival', 'arrivalFrom', 'arrivalTo',
    'departure', 'departureFrom', 'departureTo',
    'bookingTimeFrom', 'bookingTimeTo',
    'modifiedFrom', 'modifiedTo',

    // Search
    'searchString',     // matches guest name, email, apiref, bookingId

    // Include additional data
    'includeInvoiceItems', 'includeInfoItems', 'includeGuests', 'includeBookingGroup',

    // Pagination
    'page'
];

// GET /getBookings - Primary booking endpoint
app.get('/getBookings', async (req, res) => {
    try {
        const startTime = Date.now();

        // Build params from query
        const params = { propertyId: PROPERTY_ID };
        BOOKING_PARAMS.forEach(param => {
            if (req.query[param] !== undefined) {
                params[param] = req.query[param];
            }
        });

        // Try API first
        let bookings = [];
        let source = 'api';
        let pages = null;

        try {
            const result = await fetchBeds24('bookings', params);
            bookings = result.data.data || result.data || [];
            pages = result.data.pages || null;

            // Update memory cache if this is a full fetch (no specific filters)
            if (!req.query.filter && !req.query.id && !req.query.searchString) {
                memoryCache.bookings = { data: bookings, timestamp: Date.now(), ttl: 60000 };

                // Also update Firestore cache asynchronously
                updateFirestoreBookingCache(bookings).catch(err => console.error('Cache update error:', err));
            }
        } catch (apiError) {
            console.error('API error, trying cache:', apiError.message);
            source = 'cache';

            // Fallback to memory cache
            if (memoryCache.bookings.data) {
                bookings = memoryCache.bookings.data;
                console.log('📦 Using memory cache');
            } else {
                // Fallback to Firestore cache
                const cached = await getFirestoreBookingCache();
                if (cached) {
                    bookings = cached;
                    console.log('📦 Using Firestore cache');
                }
            }
        }

        const loadTime = Date.now() - startTime;

        res.json({
            success: true,
            source,
            count: bookings.length,
            pages,
            loadTime,
            data: bookings
        });

    } catch (error) {
        console.error('GetBookings error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /bookings - Create or update bookings (batch support)
app.post('/bookings', async (req, res) => {
    try {
        const bookingData = req.body;

        // Ensure it's an array for batch processing
        const bookings = Array.isArray(bookingData) ? bookingData : [bookingData];

        // Add propertyId if not specified
        bookings.forEach(b => {
            if (!b.propertyId) b.propertyId = PROPERTY_ID;
        });

        console.log(`📝 Creating/updating ${bookings.length} booking(s)`);

        const result = await fetchBeds24('bookings', {}, 'POST', bookings);

        // Invalidate cache after modification
        memoryCache.bookings.timestamp = 0;

        res.json({
            success: true,
            data: result.data
        });

    } catch (error) {
        console.error('Create booking error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ROOMS API - Using /properties endpoint with room details
// ============================================================

app.get('/getRooms', async (req, res) => {
    try {
        const startTime = Date.now();
        let rooms = [];
        let source = 'api';

        // Check memory cache first
        const now = Date.now();
        if (memoryCache.rooms.data && (now - memoryCache.rooms.timestamp) < memoryCache.rooms.ttl) {
            console.log('📦 Using cached rooms');
            return res.json({
                success: true,
                source: 'cache',
                count: memoryCache.rooms.data.length,
                data: memoryCache.rooms.data
            });
        }

        try {
            // Fetch properties with all room details
            const result = await fetchBeds24('properties', {
                id: PROPERTY_ID,
                includeAllRooms: true,
                includeUnitDetails: true
            });

            // Extract rooms from property data
            const propertyData = result.data.data || result.data || [];
            const property = Array.isArray(propertyData) ? propertyData[0] : propertyData;

            if (property && property.roomTypes) {
                rooms = property.roomTypes.map(room => ({
                    id: room.id,
                    name: room.name,
                    maxPeople: room.maxPeople,
                    qty: room.qty,
                    units: room.units || [],
                    priceRules: room.priceRules || []
                }));
            }

            // Update cache
            memoryCache.rooms = { data: rooms, timestamp: now, ttl: 3600000 };

            // Store in Firestore for persistence
            await roomsCacheCollection.doc('current').set({
                data: rooms,
                updatedAt: Firestore.FieldValue.serverTimestamp()
            });

        } catch (apiError) {
            console.error('Rooms API error, trying cache:', apiError.message);
            source = 'cache';

            // Try Firestore cache
            const cached = await roomsCacheCollection.doc('current').get();
            if (cached.exists) {
                rooms = cached.data().data;
            }
        }

        const loadTime = Date.now() - startTime;

        res.json({
            success: true,
            source,
            count: rooms.length,
            loadTime,
            data: rooms
        });

    } catch (error) {
        console.error('GetRooms error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// DASHBOARD OPTIMIZED ENDPOINT - Mixed Strategy
// ============================================================

app.get('/dashboard/data', async (req, res) => {
    try {
        const startTime = Date.now();
        const today = new Date().toISOString().slice(0, 10);

        // Parallel fetch multiple data sets
        const [currentResult, arrivalsResult, departuresResult] = await Promise.allSettled([
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'current' }),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'arrivals' }),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'departures' })
        ]);

        // Extract data with fallbacks
        const current = currentResult.status === 'fulfilled' ? (currentResult.value.data.data || []) : [];
        const arrivals = arrivalsResult.status === 'fulfilled' ? (arrivalsResult.value.data.data || []) : [];
        const departures = departuresResult.status === 'fulfilled' ? (departuresResult.value.data.data || []) : [];

        // Combine and deduplicate
        const allBookings = [...current, ...arrivals, ...departures];
        const seen = new Set();
        const uniqueBookings = allBookings.filter(b => {
            if (seen.has(b.id)) return false;
            seen.add(b.id);
            return true;
        });

        // Calculate stats
        const stats = {
            occupied: current.filter(b => b.status !== 'cancelled').length,
            checkInsToday: arrivals.filter(b => b.arrival === today && b.status !== 'cancelled').length,
            checkOutsToday: departures.filter(b => b.departure === today).length,
            totalActive: uniqueBookings.filter(b => b.status !== 'cancelled').length
        };

        // Update cache with combined data
        memoryCache.bookings = {
            data: uniqueBookings.filter(b => b.status !== 'cancelled'),
            timestamp: Date.now(),
            ttl: 60000
        };

        const loadTime = Date.now() - startTime;

        res.json({
            success: true,
            loadTime,
            stats,
            data: uniqueBookings.filter(b => b.status !== 'cancelled')
        });

    } catch (error) {
        console.error('Dashboard data error:', error);

        // Fallback to cache
        if (memoryCache.bookings.data) {
            res.json({
                success: true,
                source: 'cache',
                data: memoryCache.bookings.data
            });
        } else {
            res.status(500).json({ success: false, error: error.message });
        }
    }
});

// ============================================================
// WEBHOOK ENDPOINT - Backup data source, syncs to Firestore
// ============================================================

app.post('/webhook/booking', async (req, res) => {
    try {
        const startTime = Date.now();
        console.log('=== WEBHOOK RECEIVED ===');

        const webhookData = req.body;

        // Parse booking data - Beds24 webhook format
        let booking = null;
        let action = 'unknown';

        // Handle different webhook formats
        if (webhookData.booking) {
            // Format: { booking: {...}, invoiceItems: [...], ... }
            booking = webhookData.booking;
            action = booking.cancelTime ? 'cancelled' :
                     (booking.bookingTime === booking.modifiedTime ? 'new_booking' : 'modified');
        } else if (webhookData.id && webhookData.roomId) {
            // Direct booking object
            booking = webhookData;
            action = webhookData.cancelTime ? 'cancelled' :
                     webhookData.action || 'modified';
        } else if (webhookData.action) {
            // Action-based webhook (SYNC_ROOM, etc)
            action = webhookData.action;
        }

        // Create notification record
        const notification = {
            type: 'booking_update',
            action,
            bookingId: booking?.id || webhookData.bookingId || null,
            propertyId: booking?.propertyId || webhookData.propId || PROPERTY_ID,
            guestName: booking ? `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Unknown' : 'Unknown',
            roomId: booking?.roomId || webhookData.roomId || null,
            unitId: booking?.unitId || null,
            arrival: booking?.arrival || null,
            departure: booking?.departure || null,
            status: booking?.status || null,
            price: booking?.price || null,
            deposit: booking?.deposit || null,
            receivedAt: Firestore.FieldValue.serverTimestamp(),
            processedAt: null,
            rawData: webhookData
        };

        // Store notification
        const docRef = await notificationsCollection.add(notification);
        console.log(`✅ Webhook stored: ${docRef.id} (${action})`);

        // If this is a booking update, update our cache
        if (booking && booking.id) {
            await updateSingleBookingInCache(booking);
        }

        // Invalidate memory cache to force fresh fetch
        memoryCache.bookings.timestamp = 0;

        // Respond immediately (Beds24 expects quick response)
        res.status(200).json({
            success: true,
            notificationId: docRef.id,
            action,
            processTime: Date.now() - startTime
        });

        // Cleanup old notifications (async, don't wait)
        cleanupOldNotifications().catch(err => console.error('Cleanup error:', err));

    } catch (error) {
        console.error('Webhook error:', error);
        // Still return 200 to prevent Beds24 retries
        res.status(200).json({ success: false, error: error.message });
    }
});

// Update single booking in Firestore cache
async function updateSingleBookingInCache(booking) {
    try {
        const cacheDoc = await bookingCacheCollection.doc('current').get();
        if (cacheDoc.exists) {
            let bookings = cacheDoc.data().data || [];

            // Find and update or add
            const idx = bookings.findIndex(b => b.id === booking.id);
            if (idx >= 0) {
                if (booking.status === 'cancelled') {
                    bookings.splice(idx, 1); // Remove cancelled
                } else {
                    bookings[idx] = booking; // Update
                }
            } else if (booking.status !== 'cancelled') {
                bookings.push(booking); // Add new
            }

            await bookingCacheCollection.doc('current').set({
                data: bookings,
                updatedAt: Firestore.FieldValue.serverTimestamp(),
                lastWebhook: booking.id
            });

            console.log(`📦 Cache updated via webhook: booking ${booking.id}`);
        }
    } catch (error) {
        console.error('Cache update error:', error);
    }
}

// ============================================================
// FIRESTORE CACHE HELPERS
// ============================================================

async function updateFirestoreBookingCache(bookings) {
    try {
        await bookingCacheCollection.doc('current').set({
            data: bookings,
            count: bookings.length,
            updatedAt: Firestore.FieldValue.serverTimestamp()
        });
        console.log(`📦 Firestore cache updated: ${bookings.length} bookings`);
    } catch (error) {
        console.error('Firestore cache update error:', error);
    }
}

async function getFirestoreBookingCache() {
    try {
        const doc = await bookingCacheCollection.doc('current').get();
        if (doc.exists) {
            return doc.data().data;
        }
    } catch (error) {
        console.error('Firestore cache read error:', error);
    }
    return null;
}

async function cleanupOldNotifications() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days
    const oldDocs = await notificationsCollection
        .where('receivedAt', '<', cutoff)
        .limit(100)
        .get();

    if (oldDocs.size > 0) {
        const batch = db.batch();
        oldDocs.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log(`🧹 Cleaned ${oldDocs.size} old notifications`);
    }
}

// ============================================================
// CACHE MANAGEMENT
// ============================================================

app.post('/cache/refresh', async (req, res) => {
    try {
        console.log('🔄 Force refreshing all caches...');

        // Clear memory cache
        memoryCache.bookings.timestamp = 0;
        memoryCache.rooms.timestamp = 0;

        // Fetch fresh data
        const [bookingsResult, roomsResult] = await Promise.allSettled([
            fetchBeds24('bookings', { propertyId: PROPERTY_ID }),
            fetchBeds24('properties', { id: PROPERTY_ID, includeAllRooms: true })
        ]);

        let bookingsCount = 0, roomsCount = 0;

        if (bookingsResult.status === 'fulfilled') {
            const bookings = bookingsResult.value.data.data || [];
            memoryCache.bookings = { data: bookings, timestamp: Date.now(), ttl: 60000 };
            await updateFirestoreBookingCache(bookings);
            bookingsCount = bookings.length;
        }

        if (roomsResult.status === 'fulfilled') {
            const property = roomsResult.value.data.data?.[0] || roomsResult.value.data;
            const rooms = property?.roomTypes || [];
            memoryCache.rooms = { data: rooms, timestamp: Date.now(), ttl: 3600000 };
            roomsCount = rooms.length;
        }

        res.json({
            success: true,
            refreshed: { bookings: bookingsCount, rooms: roomsCount }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// NOTIFICATIONS API
// ============================================================

app.get('/notifications', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const since = req.query.since; // ISO date string

        let query = notificationsCollection.orderBy('receivedAt', 'desc').limit(limit);

        if (since) {
            query = query.where('receivedAt', '>', new Date(since));
        }

        const snapshot = await query.get();

        const notifications = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            receivedAt: doc.data().receivedAt?.toDate?.()?.toISOString() || null
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

// ============================================================
// GENERIC BEDS24 PROXY - For any endpoint
// ============================================================

app.get('/beds24/:endpoint(*)', async (req, res) => {
    try {
        const result = await fetchBeds24(req.params.endpoint, req.query);
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/beds24/:endpoint(*)', async (req, res) => {
    try {
        const result = await fetchBeds24(req.params.endpoint, {}, 'POST', req.body);
        res.json(result.data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// DASHBOARD DATA PERSISTENCE
// ============================================================

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

app.get('/dashboard/load/:type', async (req, res) => {
    try {
        const doc = await dashboardDataCollection.doc(req.params.type).get();
        res.json({
            success: true,
            data: doc.exists ? doc.data().data : null
        });
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
        res.json({
            data: doc.exists ? doc.data().data : null,
            timestamp: doc.exists ? doc.data().timestamp : null
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// USER MANAGEMENT & AUTH
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

// OTP Authentication
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
    console.log(`🚀 Miami Beach Resort API v4.0 running on port ${PORT}`);
    console.log(`   Strategy: API primary + Webhook backup + Firestore cache`);
    console.log(`   Property ID: ${PROPERTY_ID}`);
    console.log(`   Endpoints:`);
    console.log(`   - GET  /getBookings     - Bookings with all Beds24 filters`);
    console.log(`   - POST /bookings        - Create/update bookings`);
    console.log(`   - GET  /getRooms        - Rooms and units`);
    console.log(`   - GET  /dashboard/data  - Optimized dashboard data`);
    console.log(`   - POST /webhook/booking - Webhook receiver (backup)`);
    console.log(`   - POST /cache/refresh   - Force cache refresh`);
});
