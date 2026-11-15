const app = require('./app');
const migrate = require('./migrate');
const s3 = require('./s3');

const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await migrate(); // creates missing tables, skips ones already applied
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT} (docs: /docs)`);
    s3.warm(); // load the image list in the background
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Try: PORT=<other> npm run dev`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

start();
