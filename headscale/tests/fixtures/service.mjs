import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const options = JSON.parse(process.argv[2]);
appendFileSync(options.marker, `${options.name}:start:${process.pid}\n`);
const readyAt = Date.now() + (options.delayReady ?? 0);
const server = createServer((_req, res) => {
  res.statusCode = Date.now() >= readyAt ? 200 : 503;
  res.end('health');
});
server.listen(options.port, '127.0.0.1');
if (options.exitAfter) setTimeout(() => process.exit(options.exitCode ?? 1), options.exitAfter);
process.on('SIGTERM', () => {
  appendFileSync(options.marker, `${options.name}:stop\n`);
  server.close(() => process.exit(0));
});
