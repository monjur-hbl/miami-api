/**
 * Miami Beach Resort - Unified Backend API v6.5
 *
 * TIMEZONE: Asia/Dhaka (GMT+6) - All date operations use Bangladesh time
 *
 * REAL-TIME DATA STRATEGY:
 * - NO CACHING - Every request fetches fresh data from Beds24
 * - Live bookings for hotel operations (front desk + Beds24 agents)
 * - Parallel fetching for speed
 * - SSE for real-time push updates
 * - All date ranges supported on-demand
 *
 * API STRUCTURE:
 * - Lines 35-113: Configuration (timezone, tokens, Firestore, SSE)
 * - Lines 115-271: Beds24 API helpers (token, direct, proxy)
 * - Lines 273-350: Health check + Legacy POST handler
 * - Lines 352-537: Bookings API (getBookings, range, create)
 * - Lines 539-813: Specialized endpoints (overview, calendar, movements, etc.)
 * - Lines 815-866: SSE endpoints (stream, status)
 * - Lines 868-967: Rooms & Dashboard endpoints
 * - Lines 969-1085: Webhook & notifications
 * - Lines 1087-1145: Generic proxy & dashboard persistence
 * - Lines 1147-1181: Housekeeping API
 * - Lines 1183-1540: Authentication & Admin panel
 * - Lines 1542-1674: Legacy user endpoints & server start
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
const BEDS24_PROXY_FALLBACK = 'https://beds24-proxy-1006186358018.us-central1.run.app';
const PROPERTY_ID = 279646;

// Bangladesh Timezone (GMT+6) - All date operations use this
const TIMEZONE = 'Asia/Dhaka';

// TOKEN STRATEGY:
// - READ_TOKEN: Permanent access token for read operations (no refresh needed)
// - WRITE_REFRESH_TOKEN: Refresh token for write/delete operations (needs refresh)
const BEDS24_READ_TOKEN = process.env.BEDS24_READ_TOKEN || 'Bl4DR+RRtX2+7K5z4yKsxn+lXqAiBf6OAOpX7vKI6D+B+oVGDZqhCgJzITjbwG1GiLWQaYxPSDUPpTFT0kJj2D69S1IneOpdmoDkq0T3vYvKzBJdA0MVyN4DSdbPSii8E35dgUy6tvY+Lpg5Z71MHIuZAz836qMOFgAywZ9lkD8=';
const BEDS24_WRITE_REFRESH_TOKEN = process.env.BEDS24_WRITE_REFRESH_TOKEN || 'dhkoMR8hcpV1XIu0fsoIEey5X3zlazcbA0TPJv6FjAEf+tP0K4te1XTjnazpIbCJ09rqe1xPFAQqbFEwKZh5AZspvoqQoddlAkyMbvTHMqER7v4SON+M2cM3ha/daNcqdGpa6gEAszF3Xt0z2bu0Thb53lRtEJUvoB8Ghfzjdvs=';

// Get today's date in Bangladesh timezone (YYYY-MM-DD format)
function getTodayBD() {
    return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// Get current datetime in Bangladesh timezone
function getNowBD() {
    return new Date().toLocaleString('en-US', { timeZone: TIMEZONE });
}

// Write token cache for refresh token flow
let writeTokenCache = { token: null, expiresAt: 0 };

// Direct API is always available with permanent READ token
let useDirectApi = true;

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
// Rate limit tracking (no caching - all data is live)
let rateLimitInfo = {
    remaining: 1000,
    resetsIn: 0,
    lastUpdated: 0
};

// SSE (Server-Sent Events) - Connected clients for real-time updates
const sseClients = new Set();

// Broadcast to all connected SSE clients
function broadcastToClients(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(client => {
        try {
            client.write(message);
        } catch (err) {
            console.error('SSE broadcast error:', err);
            sseClients.delete(client);
        }
    });
    console.log(`📡 SSE: Broadcast "${event}" to ${sseClients.size} clients`);
}

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
// BEDS24 TOKEN MANAGEMENT - Dual Token Strategy
// ============================================================

// Get READ token (permanent, no refresh needed)
function getReadToken() {
    return BEDS24_READ_TOKEN;
}

// Get WRITE token (refresh if needed)
async function getWriteToken() {
    const now = Date.now();

    // Return cached token if still valid (with 5 min buffer)
    if (writeTokenCache.token && writeTokenCache.expiresAt > now + 300000) {
        return writeTokenCache.token;
    }

    console.log('🔑 Refreshing Beds24 WRITE token...');

    const res = await fetch(`${BEDS24_API_URL}/authentication/token`, {
        headers: { 'refreshToken': BEDS24_WRITE_REFRESH_TOKEN }
    });

    const data = await res.json();

    if (!data.token) {
        console.error('❌ WRITE token refresh failed:', data);
        return null;
    }

    // Cache write token
    writeTokenCache = {
        token: data.token,
        expiresAt: now + (data.expiresIn * 1000) - 60000 // Subtract 1 min buffer
    };

    console.log('✅ WRITE token refreshed successfully');
    return writeTokenCache.token;
}

// Legacy getToken for backward compatibility (uses READ token)
async function getToken() {
    return getReadToken();
}

// ============================================================
// BEDS24 API HELPER - With Proxy Fallback
// ============================================================

async function fetchBeds24(endpoint, params = {}, method = 'GET', body = null) {
    // Try direct API first if configured
    if (useDirectApi) {
        try {
            const token = await getToken();
            if (token) {
                return await fetchBeds24Direct(endpoint, params, method, body, token);
            }
        } catch (error) {
            console.error('Direct API failed, falling back to proxy:', error.message);
            useDirectApi = false;
        }
    }

    // Fallback to existing proxy
    return await fetchBeds24ViaProxy(endpoint, params, method, body);
}

async function fetchBeds24Direct(endpoint, params, method, body, token) {
    const url = new URL(`${BEDS24_API_URL}/${endpoint}`);

    // Add query params for GET requests
    if (method === 'GET') {
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.append(key, value);
            }
        });
    }

    console.log(`📡 Beds24 Direct ${method}: ${url.toString()}`);

    const options = {
        method,
        headers: {
            'token': token,
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

    if (data.success === false || data.error) {
        throw new Error(data.error || 'API request failed');
    }

    return { data, status: response.status, headers: response.headers };
}

async function fetchBeds24ViaProxy(endpoint, params, method, body) {
    // Map endpoint to proxy URLs
    let proxyUrl;

    if (endpoint === 'bookings') {
        proxyUrl = `${BEDS24_PROXY_FALLBACK}/getBookings`;
    } else if (endpoint.includes('rooms')) {
        proxyUrl = `${BEDS24_PROXY_FALLBACK}/getRooms`;
    } else {
        // Generic proxy endpoint
        proxyUrl = `${BEDS24_PROXY_FALLBACK}/?endpoint=${endpoint}`;
    }

    const url = new URL(proxyUrl);

    // Add query params
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '' && key !== 'propertyId') {
            url.searchParams.append(key, value);
        }
    });

    console.log(`📡 Beds24 Proxy ${method}: ${url.toString()}`);

    const options = { method };
    if (body && method !== 'GET') {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), options);
    const data = await response.json();

    // Normalize response format
    if (data.data) {
        return { data, status: response.status };
    } else if (Array.isArray(data)) {
        return { data: { data }, status: response.status };
    }

    return { data: { data: data }, status: response.status };
}

// ============================================================
// HEALTH CHECK & STATUS
// ============================================================

app.get('/', (req, res) => {
    res.json({
        status: 'Miami Beach Resort API v7.0',
        strategy: 'REAL-TIME + SSE with Dual-Token Auth',
        mode: 'direct-api',
        readToken: '✅ Permanent',
        writeToken: '✅ Auto-refresh',
        propertyId: PROPERTY_ID,
        timezone: TIMEZONE,
        todayBD: getTodayBD(),
        timestampBD: getNowBD(),
        timestampUTC: new Date().toISOString(),
        rateLimit: rateLimitInfo,
        sseClients: sseClients.size,
        realTimeStream: {
            connect: 'GET /api/stream - SSE connection for real-time booking updates',
            status: 'GET /api/stream/status - Check connected clients'
        },
        specializedEndpoints: {
            overview: 'GET /api/overview?date= - Today overview',
            calendar: 'GET /api/calendar?start=&days= - Calendar view',
            movements: 'GET /api/movements?date= - Check-ins & check-outs',
            housekeeping: 'GET /api/housekeeping?date= - HK room status',
            revenue: 'GET /api/revenue?from=&to= - Revenue/accounting',
            search: 'GET /api/search?q= - Search bookings',
            booking: 'GET /api/booking/:id - Single booking'
        },
        genericEndpoints: {
            getBookings: 'GET /getBookings - All bookings with filters',
            getBookingsRange: 'GET /getBookings/range?from=&to=&type= - Date range',
            createBooking: 'POST /bookings - Create/update bookings',
            createBookingLegacy: 'POST /?endpoint=bookings - Legacy format',
            getRooms: 'GET /getRooms - All rooms and units'
        }
    });
});

// Legacy POST handler for ?endpoint=bookings format (backward compatibility with dashboard)
app.post('/', async (req, res) => {
    try {
        const { endpoint } = req.query;

        if (!endpoint) {
            return res.status(400).json({ success: false, error: 'Missing endpoint parameter' });
        }

        console.log(`📡 Legacy POST /?endpoint=${endpoint}`);

        // Handle bookings endpoint
        if (endpoint === 'bookings') {
            const bookingData = req.body;
            const bookings = Array.isArray(bookingData) ? bookingData : [bookingData];

            bookings.forEach(b => {
                if (!b.propertyId) b.propertyId = PROPERTY_ID;
            });

            console.log(`📝 Legacy: Creating/updating ${bookings.length} booking(s)`);

            const result = await fetchBeds24('bookings', {}, 'POST', bookings);
            return res.json(result.data);
        }

        // Generic proxy for other endpoints
        const result = await fetchBeds24(endpoint, {}, 'POST', req.body);
        res.json(result.data);

    } catch (error) {
        console.error('Legacy POST error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// BOOKINGS API - Full parameter support per API V2 spec
// ============================================================

// All supported booking query parameters from API V2 spec
const BOOKING_PARAMS = [
    'filter', 'status', 'channel',
    'propertyId', 'roomId', 'id', 'masterId', 'apiReference',
    'arrival', 'arrivalFrom', 'arrivalTo',
    'departure', 'departureFrom', 'departureTo',
    'bookingTimeFrom', 'bookingTimeTo',
    'modifiedFrom', 'modifiedTo',
    'searchString',
    'includeInvoiceItems', 'includeInfoItems', 'includeGuests', 'includeBookingGroup',
    'page'
];

// Helper to fetch all pages - ALWAYS LIVE DATA
async function fetchAllBookingPages(params, maxPages = 50) {
    let allBookings = [];
    let currentPage = 1;
    let hasMorePages = true;
    let totalPages = 1;

    while (hasMorePages && currentPage <= maxPages) {
        const pageParams = { ...params, page: currentPage };
        console.log(`📄 LIVE: Fetching page ${currentPage}...`);

        const result = await fetchBeds24('bookings', pageParams);
        const pageBookings = result.data.data || result.data || [];

        allBookings = allBookings.concat(pageBookings);

        const pages = result.data.pages || {};
        hasMorePages = pages.nextPageExists === true;

        if (hasMorePages) {
            currentPage++;
            totalPages = currentPage;
            await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
        }
    }

    return { bookings: allBookings, totalPages };
}

// GET /getBookings - REAL-TIME booking data (no caching)
app.get('/getBookings', async (req, res) => {
    try {
        const startTime = Date.now();

        // Build params from query
        const params = { propertyId: PROPERTY_ID };
        BOOKING_PARAMS.forEach(param => {
            if (req.query[param] !== undefined && param !== 'page') {
                params[param] = req.query[param];
            }
        });

        // Check what date range is needed
        const hasDateFilters = req.query.arrivalFrom || req.query.arrivalTo ||
                              req.query.departureFrom || req.query.departureTo;
        const hasFilter = req.query.filter; // current, arrivals, departures, new

        let allBookings = [];
        let totalPages = 1;

        if (hasDateFilters || hasFilter) {
            // Direct filtered query - single fetch
            const result = await fetchAllBookingPages(params);
            allBookings = result.bookings;
            totalPages = result.totalPages;
        } else {
            // Default: Fetch current + future bookings (what dashboard needs)
            // For past data, dashboard should pass specific date filters
            const todayStr = getTodayBD();
            const todayDate = new Date(todayStr + 'T00:00:00+06:00'); // Parse in BD timezone
            const oneMonthAgo = new Date(todayDate);
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            const oneMonthAgoStr = oneMonthAgo.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

            // Parallel fetch for speed
            const [pastResult, futureResult] = await Promise.all([
                // Recent past (for checkout history, accounting)
                fetchAllBookingPages({
                    ...params,
                    departureFrom: oneMonthAgoStr,
                    departureTo: todayStr
                }, 10),
                // Current + Future (default API behavior)
                fetchAllBookingPages(params, 20)
            ]);

            // Combine and deduplicate
            const bookingMap = new Map();
            [...pastResult.bookings, ...futureResult.bookings].forEach(b => {
                bookingMap.set(b.id, b);
            });
            allBookings = Array.from(bookingMap.values());
            totalPages = pastResult.totalPages + futureResult.totalPages;
        }

        const loadTime = Date.now() - startTime;
        console.log(`✅ LIVE: ${allBookings.length} bookings in ${loadTime}ms`);

        res.json({
            success: true,
            source: 'live',
            count: allBookings.length,
            totalPages,
            loadTime,
            data: allBookings
        });

    } catch (error) {
        console.error('GetBookings error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /getBookings/range - Fetch specific date range (for calendar, accounting)
app.get('/getBookings/range', async (req, res) => {
    try {
        const startTime = Date.now();
        const { from, to, type } = req.query;

        if (!from || !to) {
            return res.status(400).json({
                success: false,
                error: 'Required: from and to dates (YYYY-MM-DD format)'
            });
        }

        const params = { propertyId: PROPERTY_ID };

        // type: 'arrival' or 'departure' (default: departure for accounting)
        if (type === 'arrival') {
            params.arrivalFrom = from;
            params.arrivalTo = to;
        } else {
            params.departureFrom = from;
            params.departureTo = to;
        }

        console.log(`📅 LIVE range: ${from} to ${to} (${type || 'departure'})`);

        const result = await fetchAllBookingPages(params, 30);

        res.json({
            success: true,
            source: 'live',
            dateRange: { from, to, type: type || 'departure' },
            count: result.bookings.length,
            totalPages: result.totalPages,
            loadTime: Date.now() - startTime,
            data: result.bookings
        });

    } catch (error) {
        console.error('Historical fetch error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /bookings - Create or update bookings (batch support)
app.post('/bookings', async (req, res) => {
    try {
        const bookingData = req.body;
        const bookings = Array.isArray(bookingData) ? bookingData : [bookingData];

        bookings.forEach(b => {
            if (!b.propertyId) b.propertyId = PROPERTY_ID;
        });

        console.log(`📝 Creating/updating ${bookings.length} booking(s)`);

        const result = await fetchBeds24('bookings', {}, 'POST', bookings);

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
// SPECIALIZED ENDPOINTS - Optimized for each dashboard section
// ============================================================

// 1. TODAY OVERVIEW - Current occupancy + arrivals/departures for a specific date
app.get('/api/overview', async (req, res) => {
    try {
        const startTime = Date.now();
        const date = req.query.date || getTodayBD();
        console.log(`📡 LIVE: Overview for ${date}`);

        // Parallel fetch: current guests + today's movements
        const [currentResult, arrivalsResult, departuresResult] = await Promise.all([
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'current' }),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, arrival: date }),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, departure: date })
        ]);

        const current = currentResult.data.data || [];
        const arrivals = arrivalsResult.data.data || [];
        const departures = departuresResult.data.data || [];

        // Calculate occupancy for the specific date
        const activeBookings = current.filter(b => b.status !== 'cancelled');
        const todayArrivals = arrivals.filter(b => b.status !== 'cancelled');
        const todayDepartures = departures.filter(b => b.status !== 'cancelled');

        res.json({
            success: true,
            source: 'live',
            date,
            loadTime: Date.now() - startTime,
            stats: {
                occupied: activeBookings.length,
                checkIns: todayArrivals.length,
                checkOuts: todayDepartures.length
            },
            current: activeBookings,
            arrivals: todayArrivals,
            departures: todayDepartures
        });
    } catch (error) {
        console.error('Overview error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. CALENDAR VIEW - Bookings for a date range (3/7/15/30 days or custom)
app.get('/api/calendar', async (req, res) => {
    try {
        const startTime = Date.now();
        const start = req.query.start || getTodayBD();
        const days = parseInt(req.query.days) || 7;

        // Calculate end date in Bangladesh timezone
        const startDate = new Date(start + 'T00:00:00+06:00'); // Parse in BD timezone
        startDate.setDate(startDate.getDate() + days);
        const end = startDate.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

        console.log(`📡 LIVE: Calendar ${start} to ${end} (${days} days)`);

        // Fetch bookings that overlap with this range
        // Get arrivals in range OR departures in range OR currently in-house
        const [arrivalsResult, departuresResult, currentResult] = await Promise.all([
            fetchAllBookingPages({ propertyId: PROPERTY_ID, arrivalFrom: start, arrivalTo: end }, 10),
            fetchAllBookingPages({ propertyId: PROPERTY_ID, departureFrom: start, departureTo: end }, 10),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'current' })
        ]);

        // Combine and deduplicate
        const bookingMap = new Map();
        [...arrivalsResult.bookings, ...departuresResult.bookings, ...(currentResult.data.data || [])]
            .filter(b => b.status !== 'cancelled')
            .forEach(b => bookingMap.set(b.id, b));

        const bookings = Array.from(bookingMap.values());

        res.json({
            success: true,
            source: 'live',
            dateRange: { start, end, days },
            loadTime: Date.now() - startTime,
            count: bookings.length,
            data: bookings
        });
    } catch (error) {
        console.error('Calendar error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. MOVEMENTS - Today's check-ins and check-outs only
app.get('/api/movements', async (req, res) => {
    try {
        const startTime = Date.now();
        const date = req.query.date || getTodayBD();
        console.log(`📡 LIVE: Movements for ${date}`);

        const [arrivalsResult, departuresResult] = await Promise.all([
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, arrival: date }),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, departure: date })
        ]);

        const arrivals = (arrivalsResult.data.data || []).filter(b => b.status !== 'cancelled');
        const departures = (departuresResult.data.data || []).filter(b => b.status !== 'cancelled');

        res.json({
            success: true,
            source: 'live',
            date,
            loadTime: Date.now() - startTime,
            checkIns: { count: arrivals.length, data: arrivals },
            checkOuts: { count: departures.length, data: departures }
        });
    } catch (error) {
        console.error('Movements error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. HOUSEKEEPING - Room status for today/tomorrow
app.get('/api/housekeeping', async (req, res) => {
    try {
        const startTime = Date.now();
        const date = req.query.date || getTodayBD();
        console.log(`📡 LIVE: Housekeeping for ${date}`);

        // Get current guests and departures for the date
        const [currentResult, departuresResult, arrivalsResult] = await Promise.all([
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'current' }),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, departure: date }),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, arrival: date })
        ]);

        const current = (currentResult.data.data || []).filter(b => b.status !== 'cancelled');
        const departures = (departuresResult.data.data || []).filter(b => b.status !== 'cancelled');
        const arrivals = (arrivalsResult.data.data || []).filter(b => b.status !== 'cancelled');

        // Room status: stayover (no checkout), checkout, arrival
        res.json({
            success: true,
            source: 'live',
            date,
            loadTime: Date.now() - startTime,
            summary: {
                occupied: current.length,
                departing: departures.length,
                arriving: arrivals.length,
                stayovers: current.length - departures.length
            },
            departures,
            arrivals,
            stayovers: current.filter(c => c.departure !== date)
        });
    } catch (error) {
        console.error('Housekeeping error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. REVENUE/ACCOUNTING - Departures with payment data for date range
app.get('/api/revenue', async (req, res) => {
    try {
        const startTime = Date.now();
        const from = req.query.from;
        const to = req.query.to;

        if (!from || !to) {
            return res.status(400).json({
                success: false,
                error: 'Required: from and to dates (YYYY-MM-DD)'
            });
        }

        console.log(`📡 LIVE: Revenue ${from} to ${to}`);

        // Revenue is based on checkout dates (when payment is finalized)
        const result = await fetchAllBookingPages({
            propertyId: PROPERTY_ID,
            departureFrom: from,
            departureTo: to,
            includeInvoiceItems: true
        }, 30);

        const bookings = result.bookings.filter(b => b.status !== 'cancelled');

        // Calculate totals
        const totals = bookings.reduce((acc, b) => {
            acc.totalPrice += parseFloat(b.price) || 0;
            acc.totalDeposit += parseFloat(b.deposit) || 0;
            acc.bookingCount++;
            return acc;
        }, { totalPrice: 0, totalDeposit: 0, bookingCount: 0 });

        totals.outstanding = totals.totalPrice - totals.totalDeposit;

        res.json({
            success: true,
            source: 'live',
            dateRange: { from, to },
            loadTime: Date.now() - startTime,
            totals,
            bookings
        });
    } catch (error) {
        console.error('Revenue error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. SEARCH - Find booking by guest name, ID, or reference
app.get('/api/search', async (req, res) => {
    try {
        const startTime = Date.now();
        const { q, checkIn, checkOut } = req.query;

        if (!q && !checkIn) {
            return res.status(400).json({
                success: false,
                error: 'Required: q (search term) or checkIn date'
            });
        }

        console.log(`📡 LIVE: Search "${q || ''}" ${checkIn ? `from ${checkIn}` : ''}`);

        const params = { propertyId: PROPERTY_ID };

        if (q) params.searchString = q;
        if (checkIn) params.arrivalFrom = checkIn;
        if (checkOut) params.arrivalTo = checkOut;

        const result = await fetchAllBookingPages(params, 10);

        res.json({
            success: true,
            source: 'live',
            query: { q, checkIn, checkOut },
            loadTime: Date.now() - startTime,
            count: result.bookings.length,
            data: result.bookings
        });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 7. SINGLE BOOKING - Get one booking by ID (for detail views)
app.get('/api/booking/:id', async (req, res) => {
    try {
        const startTime = Date.now();
        const bookingId = req.params.id;

        console.log(`📡 LIVE: Booking ${bookingId}`);

        const result = await fetchBeds24('bookings', {
            propertyId: PROPERTY_ID,
            id: bookingId,
            includeInvoiceItems: true,
            includeInfoItems: true
        });

        const bookings = result.data.data || [];
        const booking = bookings[0] || null;

        res.json({
            success: true,
            source: 'live',
            loadTime: Date.now() - startTime,
            data: booking
        });
    } catch (error) {
        console.error('Booking detail error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// SSE (SERVER-SENT EVENTS) - Real-time updates to dashboard
// ============================================================

// SSE connection endpoint - dashboard connects here to receive live updates
app.get('/api/stream', (req, res) => {
    console.log('📡 SSE: New client connecting...');

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Send initial connection message
    res.write(`event: connected\ndata: ${JSON.stringify({
        message: 'Connected to Miami Beach Resort real-time stream',
        timestamp: new Date().toISOString(),
        clientCount: sseClients.size + 1
    })}\n\n`);

    // Add this client to the set
    sseClients.add(res);
    console.log(`📡 SSE: Client connected. Total clients: ${sseClients.size}`);

    // Send heartbeat every 30 seconds to keep connection alive
    const heartbeat = setInterval(() => {
        try {
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
        } catch (err) {
            clearInterval(heartbeat);
            sseClients.delete(res);
        }
    }, 30000);

    // Handle client disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
        console.log(`📡 SSE: Client disconnected. Total clients: ${sseClients.size}`);
    });
});

// Get SSE status
app.get('/api/stream/status', (req, res) => {
    res.json({
        success: true,
        connectedClients: sseClients.size,
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// ROOMS API - Using /properties endpoint with room details
// ============================================================

app.get('/getRooms', async (req, res) => {
    try {
        const startTime = Date.now();
        console.log('📡 LIVE: Fetching rooms...');

        // Always fetch fresh room data
        const result = await fetchBeds24('properties', {
            id: PROPERTY_ID,
            includeAllRooms: true,
            includeUnitDetails: true
        });

        // Extract rooms from property data
        const propertyData = result.data.data || result.data || [];
        const property = Array.isArray(propertyData) ? propertyData[0] : propertyData;

        let rooms = [];
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

        const loadTime = Date.now() - startTime;
        console.log(`✅ LIVE: ${rooms.length} rooms in ${loadTime}ms`);

        res.json({
            success: true,
            source: 'live',
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
// DASHBOARD ENDPOINT - REAL-TIME DATA
// ============================================================

app.get('/dashboard/data', async (req, res) => {
    try {
        const startTime = Date.now();
        const today = getTodayBD();

        console.log('📡 LIVE: Fetching dashboard data...');

        // Parallel fetch for speed - all LIVE
        const [currentResult, arrivalsResult, departuresResult] = await Promise.allSettled([
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'current' }),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'arrivals' }),
            fetchBeds24('bookings', { propertyId: PROPERTY_ID, filter: 'departures' })
        ]);

        const current = currentResult.status === 'fulfilled' ? (currentResult.value.data.data || []) : [];
        const arrivals = arrivalsResult.status === 'fulfilled' ? (arrivalsResult.value.data.data || []) : [];
        const departures = departuresResult.status === 'fulfilled' ? (departuresResult.value.data.data || []) : [];

        // Combine and deduplicate
        const bookingMap = new Map();
        [...current, ...arrivals, ...departures].forEach(b => bookingMap.set(b.id, b));
        const uniqueBookings = Array.from(bookingMap.values()).filter(b => b.status !== 'cancelled');

        // Calculate stats
        const stats = {
            occupied: current.filter(b => b.status !== 'cancelled').length,
            checkInsToday: arrivals.filter(b => b.arrival === today && b.status !== 'cancelled').length,
            checkOutsToday: departures.filter(b => b.departure === today).length,
            totalActive: uniqueBookings.length
        };

        const loadTime = Date.now() - startTime;
        console.log(`✅ LIVE: Dashboard data in ${loadTime}ms`);

        res.json({
            success: true,
            source: 'live',
            loadTime,
            stats,
            data: uniqueBookings
        });

    } catch (error) {
        console.error('Dashboard data error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// WEBHOOK ENDPOINT - For notifications only (no caching)
// ============================================================

app.post('/webhook/booking', async (req, res) => {
    try {
        const startTime = Date.now();
        console.log('=== WEBHOOK RECEIVED ===');

        const webhookData = req.body;
        let booking = null;
        let action = 'unknown';

        if (webhookData.booking) {
            booking = webhookData.booking;
            action = booking.cancelTime ? 'cancelled' :
                     (booking.bookingTime === booking.modifiedTime ? 'new_booking' : 'modified');
        } else if (webhookData.id && webhookData.roomId) {
            booking = webhookData;
            action = webhookData.cancelTime ? 'cancelled' : webhookData.action || 'modified';
        } else if (webhookData.action) {
            action = webhookData.action;
        }

        // Store notification for audit trail
        const notification = {
            type: 'booking_update',
            action,
            bookingId: booking?.id || webhookData.bookingId || null,
            propertyId: booking?.propertyId || webhookData.propId || PROPERTY_ID,
            guestName: booking ? `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Unknown' : 'Unknown',
            roomId: booking?.roomId || webhookData.roomId || null,
            arrival: booking?.arrival || null,
            departure: booking?.departure || null,
            status: booking?.status || null,
            receivedAt: Firestore.FieldValue.serverTimestamp()
        };

        const docRef = await notificationsCollection.add(notification);
        console.log(`✅ Webhook notification stored: ${docRef.id} (${action})`);

        // 🔴 BROADCAST TO ALL CONNECTED SSE CLIENTS
        if (sseClients.size > 0) {
            broadcastToClients('booking_update', {
                action,
                bookingId: booking?.id || webhookData.bookingId || null,
                guestName: notification.guestName,
                roomId: booking?.roomId || webhookData.roomId || null,
                arrival: booking?.arrival || null,
                departure: booking?.departure || null,
                status: booking?.status || null,
                timestamp: new Date().toISOString(),
                message: `Booking ${action}: ${notification.guestName}`
            });
        }

        res.status(200).json({
            success: true,
            notificationId: docRef.id,
            action,
            sseClientsNotified: sseClients.size,
            processTime: Date.now() - startTime
        });

        // Cleanup old notifications (async)
        cleanupOldNotifications().catch(err => console.error('Cleanup error:', err));

    } catch (error) {
        console.error('Webhook error:', error);
        res.status(200).json({ success: false, error: error.message });
    }
});

async function cleanupOldNotifications() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oldDocs = await notificationsCollection.where('receivedAt', '<', cutoff).limit(100).get();
    if (oldDocs.size > 0) {
        const batch = db.batch();
        oldDocs.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log(`🧹 Cleaned ${oldDocs.size} old notifications`);
    }
}

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
            timestamp: timestamp || getNowBD(),
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
// AUTHENTICATION - Login & System Admin
// ============================================================

// System admin authorized emails
const SYSTEM_ADMIN_EMAILS = ['me.shovon@gmail.com', 'admin@miamibeachresort.com'];

// Session storage
const sessionsCollection = db.collection('sessions');

// Generate random token
function generateToken() {
    return Array.from({ length: 64 }, () =>
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
            .charAt(Math.floor(Math.random() * 62))
    ).join('');
}

// Username/Password Login
app.post('/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username and password required' });
        }

        // Find user by username
        const snapshot = await hkUsersCollection.where('username', '==', username).get();

        if (snapshot.empty) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const userDoc = snapshot.docs[0];
        const user = { id: userDoc.id, ...userDoc.data() };

        // Check password (stored as plain text for simplicity - should be hashed in production)
        if (user.password !== password) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        // Check if user is active
        if (user.active === false) {
            return res.status(403).json({ success: false, error: 'Account disabled' });
        }

        // Create session
        const token = generateToken();
        const session = {
            userId: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
            token,
            createdAt: Firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
        };

        await sessionsCollection.doc(token).set(session);

        // Don't send password back
        delete user.password;

        res.json({
            success: true,
            token,
            user
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// System Admin - Request OTP
app.post('/auth/admin/request-otp', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, error: 'Email required' });
        }

        // Check if email is authorized for system admin
        if (!SYSTEM_ADMIN_EMAILS.includes(email.toLowerCase())) {
            return res.status(403).json({ success: false, error: 'Not authorized for system admin access' });
        }

        // Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // Store OTP
        await otpCollection.doc(`admin_${email}`).set({
            otp,
            email,
            expiresAt,
            attempts: 0,
            type: 'system_admin'
        });

        // Send email
        await transporter.sendMail({
            from: `"Miami Beach Resort" <${emailUser}>`,
            to: email,
            subject: 'System Admin Access Code - Miami Beach Resort',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #D4A853;">🔐 System Admin Access</h2>
                    <p>Your system admin verification code is:</p>
                    <div style="font-size: 36px; font-weight: bold; color: #D4A853; letter-spacing: 8px; padding: 20px; background: #1E293B; border-radius: 8px; text-align: center;">
                        ${otp}
                    </div>
                    <p style="color: #666; margin-top: 20px;">This code expires in 10 minutes.</p>
                    <p style="color: #999; font-size: 12px;">If you didn't request this, please ignore this email.</p>
                </div>
            `
        });

        console.log(`📧 System admin OTP sent to ${email}`);
        res.json({ success: true, message: 'OTP sent to email' });

    } catch (error) {
        console.error('Admin OTP request error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// System Admin - Verify OTP
app.post('/auth/admin/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ success: false, error: 'Email and OTP required' });
        }

        const otpDoc = await otpCollection.doc(`admin_${email}`).get();

        if (!otpDoc.exists) {
            return res.status(400).json({ success: false, error: 'No OTP found. Please request a new one.' });
        }

        const otpData = otpDoc.data();

        // Check expiry
        if (new Date() > otpData.expiresAt.toDate()) {
            await otpCollection.doc(`admin_${email}`).delete();
            return res.status(400).json({ success: false, error: 'OTP expired. Please request a new one.' });
        }

        // Check OTP
        if (otpData.otp !== otp) {
            const attempts = (otpData.attempts || 0) + 1;
            if (attempts >= 3) {
                await otpCollection.doc(`admin_${email}`).delete();
                return res.status(400).json({ success: false, error: 'Too many failed attempts. Please request a new OTP.' });
            }
            await otpCollection.doc(`admin_${email}`).update({ attempts });
            return res.status(400).json({ success: false, error: 'Invalid OTP' });
        }

        // OTP valid - create admin session
        const token = generateToken();
        const session = {
            email,
            role: 'system_admin',
            token,
            createdAt: Firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000) // 4 hours for admin
        };

        await sessionsCollection.doc(token).set(session);
        await otpCollection.doc(`admin_${email}`).delete();

        console.log(`✅ System admin authenticated: ${email}`);
        res.json({ success: true, token });

    } catch (error) {
        console.error('Admin OTP verify error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Verify session middleware
async function verifyAdminSession(req, res, next) {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }

        const sessionDoc = await sessionsCollection.doc(token).get();

        if (!sessionDoc.exists) {
            return res.status(401).json({ success: false, error: 'Invalid session' });
        }

        const session = sessionDoc.data();

        if (session.role !== 'system_admin') {
            return res.status(403).json({ success: false, error: 'System admin access required' });
        }

        if (new Date() > session.expiresAt.toDate()) {
            await sessionsCollection.doc(token).delete();
            return res.status(401).json({ success: false, error: 'Session expired' });
        }

        req.adminSession = session;
        next();
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

// ============================================================
// ADMIN PANEL - User & Session Management
// ============================================================

// Get all users (admin only)
app.get('/admin/users', verifyAdminSession, async (req, res) => {
    try {
        const snapshot = await hkUsersCollection.get();
        const users = snapshot.docs.map(doc => {
            const data = doc.data();
            delete data.password; // Don't expose passwords
            return { id: doc.id, ...data };
        });
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create user (admin only)
app.post('/admin/users', verifyAdminSession, async (req, res) => {
    try {
        const { username, password, name, email, role, active } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username and password required' });
        }

        // Check if username exists
        const existing = await hkUsersCollection.where('username', '==', username).get();
        if (!existing.empty) {
            return res.status(400).json({ success: false, error: 'Username already exists' });
        }

        const user = {
            username,
            password, // Should be hashed in production
            name: name || username,
            email: email || '',
            role: role || 'front_desk',
            active: active !== false,
            createdAt: Firestore.FieldValue.serverTimestamp()
        };

        const docRef = await hkUsersCollection.add(user);

        delete user.password;
        res.json({ success: true, user: { id: docRef.id, ...user } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update user (admin only)
app.put('/admin/users/:id', verifyAdminSession, async (req, res) => {
    try {
        const updates = { ...req.body };
        updates.updatedAt = Firestore.FieldValue.serverTimestamp();

        await hkUsersCollection.doc(req.params.id).update(updates);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete user (admin only)
app.delete('/admin/users/:id', verifyAdminSession, async (req, res) => {
    try {
        await hkUsersCollection.doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get active sessions (admin only)
app.get('/admin/sessions', verifyAdminSession, async (req, res) => {
    try {
        const now = new Date();
        const snapshot = await sessionsCollection.get();

        const sessions = [];
        for (const doc of snapshot.docs) {
            const session = doc.data();
            // Only include non-expired sessions
            if (session.expiresAt.toDate() > now) {
                sessions.push({
                    id: doc.id,
                    userId: session.userId,
                    username: session.username,
                    name: session.name,
                    email: session.email,
                    role: session.role,
                    createdAt: session.createdAt?.toDate?.()?.toISOString() || null
                });
            }
        }

        res.json({ success: true, sessions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Force logout session (admin only)
app.delete('/admin/sessions/:id', verifyAdminSession, async (req, res) => {
    try {
        await sessionsCollection.doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get admin settings
app.get('/admin/settings', verifyAdminSession, async (req, res) => {
    try {
        const doc = await dashboardDataCollection.doc('admin_settings').get();
        res.json({
            success: true,
            settings: doc.exists ? doc.data() : { killSwitch: false }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update admin settings
app.put('/admin/settings', verifyAdminSession, async (req, res) => {
    try {
        await dashboardDataCollection.doc('admin_settings').set({
            ...req.body,
            updatedAt: Firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// USER MANAGEMENT & AUTH (Legacy endpoints)
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
// ROOM CONFIGURATION (Dynamic Total Rooms)
// ============================================================

const ROOM_CONFIG_COLLECTION = 'room_config';

// Get total room count (dynamically configurable for maintenance)
app.get('/room-config', async (req, res) => {
    try {
        const doc = await db.collection(ROOM_CONFIG_COLLECTION).doc('total_rooms').get();
        if (!doc.exists) {
            return res.json({ success: true, totalRooms: 45, source: 'default' });
        }
        const data = doc.data();
        res.json({
            success: true,
            totalRooms: data.count || 45,
            lastUpdated: data.updatedAt?.toDate?.() || null,
            updatedBy: data.updatedBy || null,
            reason: data.reason || null,
            source: 'firestore'
        });
    } catch (error) {
        console.error('Get room config error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update total room count (for admin - when rooms go under maintenance)
app.post('/room-config', async (req, res) => {
    try {
        const { totalRooms, reason, updatedBy } = req.body;
        if (!totalRooms || typeof totalRooms !== 'number' || totalRooms < 1 || totalRooms > 100) {
            return res.status(400).json({
                success: false,
                error: 'totalRooms must be a number between 1 and 100'
            });
        }
        await db.collection(ROOM_CONFIG_COLLECTION).doc('total_rooms').set({
            count: totalRooms,
            reason: reason || 'Manual update',
            updatedBy: updatedBy || 'system',
            updatedAt: Firestore.FieldValue.serverTimestamp()
        });
        console.log(`Room count updated to ${totalRooms} by ${updatedBy || 'system'}: ${reason || 'Manual update'}`);
        res.json({ success: true, totalRooms });
    } catch (error) {
        console.error('Update room config error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
    console.log(`🚀 Miami Beach Resort API v7.0 running on port ${PORT}`);
    console.log(`   Timezone: ${TIMEZONE} (Bangladesh)`);
    console.log(`   Today: ${getTodayBD()}`);
    console.log(`   Strategy: REAL-TIME + SSE for instant push updates`);
    console.log(`   Property ID: ${PROPERTY_ID}`);
    console.log(`   Real-Time Stream:`);
    console.log(`   - GET /api/stream            - SSE connection for live updates`);
    console.log(`   - GET /api/stream/status     - Check connected clients`);
    console.log(`   Specialized Endpoints:`);
    console.log(`   - GET /api/overview?date=     - Today overview`);
    console.log(`   - GET /api/calendar?start=&days= - Calendar view`);
    console.log(`   - GET /api/movements?date=   - Check-ins/outs`);
    console.log(`   - GET /api/housekeeping?date= - HK status`);
    console.log(`   - GET /api/revenue?from=&to= - Revenue/accounting`);
    console.log(`   - GET /api/search?q=         - Search bookings`);
    console.log(`   - GET /api/booking/:id       - Single booking`);
});
