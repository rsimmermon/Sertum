/**
 * Headless PTY smoke test.
 *
 * Runs under Electron (not plain node) because node-pty is rebuilt against
 * Electron's ABI. Proves the native module loads, a PTY spawns, bytes flow
 * both ways, and resize works — the whole of plane 1 without any UI.
 *
 *   npx electron scripts/smoke-pty.js            # default shell
 *   npx electron scripts/smoke-pty.js claude     # a real agent CLI
 */
const { app } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const results = [];
  const fail = (msg) => {
    console.error('FAIL:', msg);
    results.push(false);
  };
  const pass = (msg) => {
    console.log('pass:', msg);
    results.push(true);
  };

  let pty;
  try {
    pty = require('node-pty');
    pass('node-pty loaded against Electron ABI ' + process.versions.modules);
  } catch (e) {
    fail('node-pty failed to load: ' + e.message);
    return finish(results);
  }

  const target = process.argv[2];
  const isAgent = Boolean(target);
  const shell =
    target || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');

  let proc;
  try {
    proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    pass(`spawned ${shell} (pid ${proc.pid})`);
  } catch (e) {
    fail(`spawn ${shell}: ${e.message}`);
    return finish(results);
  }

  let out = '';
  proc.onData((d) => {
    out += d;
  });

  // Give an interactive TUI time to paint; a shell needs almost none.
  await sleep(isAgent ? 6000 : 800);

  if (isAgent) {
    if (out.length > 0) pass(`agent produced ${out.length} bytes of output`);
    else fail('agent produced no output');
    // ANSI escapes mean it is drawing a real TUI, not plain text.
    if (/\x1b\[/.test(out)) pass('output contains ANSI escapes (TUI is drawing)');
    else fail('no ANSI escapes — TUI may not be rendering');
  } else {
    const marker = 'AGENTSTATION_OK';
    proc.write(`echo ${marker}\r`);
    await sleep(900);
    if (out.includes(marker)) pass('round-trip write → read works');
    else fail('marker not echoed back; got: ' + JSON.stringify(out.slice(-200)));
  }

  try {
    proc.resize(60, 20);
    pass('resize accepted');
  } catch (e) {
    fail('resize threw: ' + e.message);
  }

  try {
    proc.kill();
    pass('kill accepted');
  } catch (e) {
    fail('kill threw: ' + e.message);
  }

  finish(results);
});

function finish(results) {
  const failed = results.filter((r) => !r).length;
  console.log(
    `\n${results.length - failed}/${results.length} checks passed` +
      (failed ? ` — ${failed} FAILED` : ''),
  );
  app.exit(failed ? 1 : 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
