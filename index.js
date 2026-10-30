/**
 * Hot Rides Divas — server entry shim
 * -----------------------------------
 * Purpose: Keep Render / npm start (`node index.js`) and any `node server.js`
 *          path working the same way.
 * Main functions: none (side-effect require).
 * Connections: loads ./server.js which owns Express, legacy ws, and socket.io.
 */
'use strict';
require('./server.js');
