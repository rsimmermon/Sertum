/**
 * Evaluate JavaScript inside the running Sertum renderer.
 *
 * Requires the app to be started with SERTUM_DEBUG_PORT set:
 *   SERTUM_DEBUG_PORT=9222 npm start
 *
 *   node scripts/drive.js "document.querySelectorAll('.tab').length"
 *
 * Used for headless verification on machines where screen capture is not
 * available, and as the basis for cross-platform smoke checks.
 */
const PORT = process.env.SERTUM_DEBUG_PORT || '9222';

async function main() {
  const expr = process.argv.slice(2).join(' ');
  if (!expr) {
    console.error('usage: node scripts/drive.js "<expression>"');
    process.exit(2);
  }

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) {
    console.error('no renderer page found on port ' + PORT);
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  const timeoutMs = Number(process.env.DRIVE_TIMEOUT_MS || 45000);
  const result = await Promise.race([
    send(ws, 'Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    }),
    new Promise((_r, rej) =>
      setTimeout(
        () => rej(new Error(`evaluate timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
  ws.close();

  if (result.exceptionDetails) {
    console.error(
      'EXCEPTION:',
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
    process.exit(1);
  }
  const v = result.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

let nextId = 1;
function send(ws, method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
