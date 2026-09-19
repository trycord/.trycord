const http = require('http');

const data = JSON.stringify({ username: 'bob', displayName: 'Bob', password: 'secret123' });
const opts = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/auth/register',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
};
const req = http.request(opts, (res) => {
  let d = '';
  res.on('data', (c) => (d += c));
  res.on('end', () => {
    console.log(res.statusCode, d);
    try {
      const j = JSON.parse(d);
      console.log('token', j.token);
    } catch (e) {
      console.error('non-JSON response');
    }
  });
});
req.on('error', (e) => console.error(e.message));
req.write(data);
req.end();
