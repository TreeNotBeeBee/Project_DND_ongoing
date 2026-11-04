import { startServer } from './index.js';

startServer().catch(error => { console.error(error); process.exitCode = 1; });
