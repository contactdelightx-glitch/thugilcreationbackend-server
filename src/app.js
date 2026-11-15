const express = require('express');
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

const app = express();

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

module.exports = app;
