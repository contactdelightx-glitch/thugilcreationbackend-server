require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
const healthRoutes = require('./routes/health');
const userRoutes = require('./routes/users');
const designRoutes = require('./routes/designs');
const imageRoutes = require('./routes/images');
const designerRoutes = require('./routes/designers');
const orderRoutes = require('./routes/orders');
const studentRoutes = require('./routes/students');
const coursePaymentRoutes = require('./routes/coursePayments');
const courseRoutes = require('./routes/courses');
const certificateRoutes = require('./routes/certificates');
const ratingRoutes = require('./routes/ratings');
const dashboardRoutes = require('./routes/dashboard');
const storeRoutes = require('./routes/store');
const authRoutes = require('./routes/auth');
const checkoutRoutes = require('./routes/checkout');
const doubtRoutes = require('./routes/doubts');

const app = express();

// Which websites may call this API from a browser (needed when the admin is hosted at a different address).
// CORS_ORIGIN = comma-separated addresses, e.g. https://thugilcreationadmin-v2.onrender.com ; "*" allows any site.
// Not set (the default, used in development with the Vite proxy) = no cross-site access.
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
if (corsOrigins.includes('*')) app.use(cors());
else if (corsOrigins.length) app.use(cors({ origin: corsOrigins }));

app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/openapi.json', (req, res) => res.json(swaggerSpec));
app.use(healthRoutes);
app.use(userRoutes);
app.use(designRoutes);
app.use(imageRoutes);
app.use(designerRoutes);
app.use(orderRoutes);
app.use(studentRoutes);
app.use(coursePaymentRoutes);
app.use(courseRoutes);
app.use(certificateRoutes);
app.use(ratingRoutes);
app.use(dashboardRoutes);
app.use(storeRoutes);
app.use(authRoutes);
app.use(checkoutRoutes);
app.use(doubtRoutes);

module.exports = app;
