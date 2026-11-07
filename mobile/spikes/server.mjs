// Spike 2's far end: a TLS 1.3 WebSocket echo with a fresh self-signed key,
// plus a plain ws:// port to see what the WebView does with one. Sends nothing
// but echoes and filler. Loopback by default, since an emulator reaches the
// host's loopback as 10.0.2.2; pass --host <ip> for a real phone.
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import selfsigned from 'selfsigned';
import { WebSocketServer } from 'ws';

const hostArg = process.argv.indexOf('--host');
const host = hostArg > 0 ? process.argv[hostArg + 1] : '127.0.0.1';

const made = await selfsigned.generate(
  [{ name: 'commonName', value: 'sertum-spike' }],
  { keyType: 'ec', curve: 'P-256', algorithm: 'sha256', days: 2 },
);
const key = made.private;
const cert = made.cert;
const pin = crypto
  .createHash('sha256')
  .update(new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');

function echo(wss) {
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const text = data.toString();
      if (text.startsWith('{"blob"')) ws.send('x'.repeat(JSON.parse(text).blob));
      else ws.send(text);
    });
  });
}

const tls = https.createServer({ key, cert, minVersion: 'TLSv1.3' });
echo(new WebSocketServer({ server: tls, maxPayload: 16 * 1024 * 1024 }));
tls.listen(8843, host);

const plain = http.createServer();
echo(new WebSocketServer({ server: plain }));
plain.listen(8844, host);

console.log(JSON.stringify({ host, tlsPort: 8843, plainPort: 8844, pin }));
