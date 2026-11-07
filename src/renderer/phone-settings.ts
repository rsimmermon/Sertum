import qrcode from 'qrcode-generator';
import type { GatewayDevice, GatewayPairing, GatewayStatus } from '../shared/types';

const api = window.sertum;

function el(tag: string, cls: string, content?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content !== undefined) node.textContent = content;
  return node;
}

function action(label: string, cls: string, run: () => void | Promise<void>): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = cls;
  node.textContent = label;
  node.onclick = () => void run();
  return node;
}

/** Drawn module by module. A phone's camera needs the quiet zone around it. */
function qrCanvas(payload: string): HTMLCanvasElement {
  const code = qrcode(0, 'M');
  code.addData(payload, 'Byte');
  code.make();
  const QUIET = 4;
  const SCALE = 4;
  const count = code.getModuleCount();
  const canvas = document.createElement('canvas');
  canvas.className = 'phone-qr';
  canvas.width = canvas.height = (count + QUIET * 2) * SCALE;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (code.isDark(row, column)) {
        context.fillRect((column + QUIET) * SCALE, (row + QUIET) * SCALE, SCALE, SCALE);
      }
    }
  }
  return canvas;
}

function when(at: number | null): string {
  return at === null ? 'never' : new Date(at).toLocaleString();
}

function deviceRow(device: GatewayDevice, revoke: (id: string) => void): HTMLElement {
  const row = el('div', 'rule-row');
  const label = el('div', 'phone-device');
  label.append(
    el('span', 'setting-name', device.name),
    el('span', 'setting-hint', device.connected ? 'Connected now' : `Last seen ${when(device.lastSeenAt)}`),
  );
  row.append(label, action('Remove', 'btn ghost', () => revoke(device.id)));
  return row;
}

/**
 * Phones: whether this PC listens for them, pairing one, and removing one.
 *
 * `leave` withdraws a pairing code still on screen, so an offer never outlasts
 * the person looking at it.
 */
export function phonesPane(): { element: HTMLElement; leave: () => void } {
  const element = el('div', 'set-pane');
  let status: GatewayStatus | null = null;
  let pairing: GatewayPairing | null = null;
  let failure: string | null = null;
  let countdown: ReturnType<typeof setInterval> | null = null;

  const attempt = async (run: () => Promise<void>): Promise<void> => {
    failure = null;
    try {
      await run();
    } catch (err) {
      failure = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
    }
    draw();
  };
  const stopCounting = (): void => {
    if (countdown) clearInterval(countdown);
    countdown = null;
  };
  const withdraw = (): void => {
    stopCounting();
    if (pairing) void api.cancelGatewayPairing().catch(() => undefined);
    pairing = null;
  };

  function pairingBlock(offer: GatewayPairing): HTMLElement {
    const block = el('div', 'phone-pairing');
    const left = el('div', 'setting-hint');
    const tick = (): void => {
      const seconds = Math.max(0, Math.ceil((offer.expiresAt - Date.now()) / 1000));
      left.textContent = `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}. It works once.`;
      if (seconds === 0) {
        withdraw();
        draw();
      }
    };
    tick();
    stopCounting();
    countdown = setInterval(tick, 1000);
    const side = el('div', 'phone-pairing-side');
    side.append(
      el('div', 'setting-name', 'Scan this with the Sertum app'),
      left,
      el('div', 'set-note', 'Anyone who can see this code can pair during that time, so keep it to yourself.'),
      action('Copy as text', 'btn ghost', () => navigator.clipboard.writeText(offer.payload)),
      action('Cancel', 'btn ghost', () => {
        withdraw();
        draw();
      }),
    );
    block.append(qrCanvas(offer.payload), side);
    return block;
  }

  function draw(): void {
    element.replaceChildren();
    element.append(el('div', 'setting-section', 'Phone access'));
    element.append(el(
      'div',
      'set-note',
      'A paired phone can do what you can do here: start and end sessions, tell agents to run ' +
        'commands, approve them, and set Full Access. It listens on your local network only, ' +
        'and is off until you turn it on.',
    ));
    if (!status) {
      element.append(el('div', 'set-note', failure ?? 'Reading…'));
      return;
    }
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = status.enabled;
    box.onchange = () => void attempt(async () => {
      if (!box.checked) withdraw();
      status = await api.setGatewayEnabled(box.checked);
    });
    const wrap = el('label', 'check');
    wrap.append(box, el('span', '', 'On'));
    const row = el('div', 'setting-row');
    const label = el('div', 'setting-label');
    label.append(el('span', 'setting-name', 'Allow phones to connect'));
    if (status.listening) {
      label.append(el('span', 'setting-hint', `Listening on port ${status.port}`));
    }
    row.append(label, wrap);
    element.append(row);
    if (status.error) element.append(el('div', 'set-note phone-error', status.error));
    if (failure) element.append(el('div', 'set-note phone-error', failure));

    if (status.listening) {
      element.append(el('div', 'setting-section', 'Pair a phone'));
      if (pairing) element.append(pairingBlock(pairing));
      else {
        element.append(action('Show pairing code', 'btn', () => attempt(async () => {
          pairing = await api.beginGatewayPairing();
        })));
      }
      if (status.addresses.length) {
        element.append(el(
          'div',
          'set-note',
          `This PC's addresses: ${status.addresses.join(', ')}. If a phone finds this PC but cannot ` +
            'connect, Windows Firewall is the likely cause: allow Sertum on private networks.',
        ));
      }
    }

    element.append(el('div', 'setting-section', 'Paired phones'));
    if (!status.devices.length) element.append(el('div', 'set-note', 'None yet.'));
    for (const device of status.devices) {
      element.append(deviceRow(device, (id) => void attempt(async () => {
        status = await api.revokeGatewayDevice(id);
      })));
    }
  }

  // A phone just paired, so its code has been spent.
  const stopListening = api.onGatewayChanged((next) => {
    const paired = status !== null && next.devices.length > status.devices.length;
    status = next;
    if (paired && pairing) {
      stopCounting();
      pairing = null;
    }
    draw();
  });
  draw();
  void attempt(async () => {
    status = await api.gatewayStatus();
  });

  return {
    element,
    leave: () => {
      stopListening();
      withdraw();
    },
  };
}
