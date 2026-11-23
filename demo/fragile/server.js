// Tiny demo service with no framework, just node:http.
// The fragile copy has NO restart policy in docker-compose.yml, so when the
// monkey kills this container it stays down and the experiment reports a
// non-recovery. Same code as the resilient service; the difference is purely
// operational, which is exactly the point of the demo.
const http = require('node:http');

const port = Number(process.env.PORT || 3000);
const name = process.env.SERVICE_NAME || 'fragile-api';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: name,
        uptimeSeconds: Math.round(process.uptime()),
      }),
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`${name} is up\n`);
});

server.listen(port, () => {
  console.log(`${name} listening on port ${port}`);
});
