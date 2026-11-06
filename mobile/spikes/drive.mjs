// Evaluates an expression in the app's WebView over CDP. Needs Node 22+ for the
// WebSocket global.  node spikes/drive.mjs "<expr>" [--throttle=4] [--serial=X]
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const expr = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const throttle = Number(flag('throttle') ?? 1);
const serial = flag('serial');
const adb = (...rest) =>
  execFileSync('adb', [...(serial ? ['-s', serial] : []), ...rest], { encoding: 'utf8' }).trim();

const pid = adb('shell', 'pidof', 'dev.sertum.mobile');
if (!pid) throw new Error('dev.sertum.mobile is not running');
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
try {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const reply = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  ws.close();
  if (reply.result?.exceptionDetails) {
    console.error(JSON.stringify(reply.result.exceptionDetails, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(reply.result?.result?.value ?? reply, null, 1));
  }
} finally {
  adb('forward', '--remove', `tcp:${port}`);
}
