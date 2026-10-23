// Starts the app: opens the data store first (Postgres needs to connect and load before the
// server can run), then loads server.js. `node server.js` on its own still works, with files.
const path = require('path');
const { openStore } = require('./store');

openStore(path.join(__dirname, 'data'))
  .then((store) => {
    console.log(store.kind === 'postgres' ? `Data: PostgreSQL${store.imported ? ' (imported the JSON files on this first start)' : ''}` : 'Data: JSON files in data/ (set DATABASE_URL to use PostgreSQL)');
    global.__store = store;
    require('./server');
  })
  .catch((e) => {
    console.error('Could not open the database:', e.message);
    process.exit(1);
  });
