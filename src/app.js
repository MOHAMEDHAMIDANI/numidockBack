const express = require('express');
const cors = require('cors');
const config = require('./config');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const parametersRouter = require('./routes/parameters');
const importRouter = require('./routes/import');
const schedulesRouter = require('./routes/schedules');
const driverRouter = require('./routes/driver');
const gateRouter = require('./routes/gate');
const preparationRouter = require('./routes/preparation');
const acdcRouter = require('./routes/acdc');
const usersRouter = require('./routes/users');
const storageRouter = require('./routes/storage');
const demoRouter = require('./routes/demo');

const app = express();

app.use(cors({
  origin: (origin, cb) => {
    // allow any localhost port (covers 5173, 5174, 5175, …) and same-origin requests
    if (!origin || /^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));
app.use(express.json());

app.get('/api', (req, res) => {
  res.json({ app: 'NumiDock', environment: config.nodeEnv });
});

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/parameters', parametersRouter);
app.use('/api/import', importRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/driver', driverRouter);
app.use('/api/gate', gateRouter);
app.use('/api/preparation', preparationRouter);
app.use('/api/acdc', acdcRouter);
app.use('/api/users', usersRouter);
app.use('/api/storage', storageRouter);
app.use('/api/demo', demoRouter);
module.exports = app;