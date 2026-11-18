import type {
  McpServerAction,
  McpServerView,
  SessionSnapshot,
} from '../shared/types';

const api = window.sertum;

/** Session-scoped MCP inventory and controls, shared by desktop and phone. */
export function openMcpDialog(session: SessionSnapshot): void {
  const overlay = el('div', 'overlay');
  const dialog = el('div', 'dialog wide mcp-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', `MCP servers for ${session.label}`);
  overlay.append(dialog);

  dialog.append(text('h3', `${session.label} · MCP servers`));
  dialog.append(text('p', `Effective configuration for ${session.cwd}`, 'dialog-sub'));

  const notice = text('div', 'Reading this session’s MCP servers…', 'mcp-notice');
  const body = el('div', 'mcp-manager-body');
  const list = el('div', 'mcp-server-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Configured MCP servers');
  const detail = el('div', 'mcp-server-detail');
  body.append(list, detail);
  dialog.append(notice, body);

  const actions = el('div', 'dialog-actions mcp-dialog-actions');
  const refresh = button('Refresh', 'btn ghost', () => void load());
  const close = button('Close', 'btn primary', finish);
  actions.append(refresh, close);
  dialog.append(actions);

  let servers: McpServerView[] = [];
  let selected: string | null = null;
  let loading = false;
  let acting = false;
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => void load(true), 4_000);

  function finish(): void {
    if (timer) clearInterval(timer);
    timer = null;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    finish();
  }

  async function load(quiet = false): Promise<void> {
    if (loading || acting) return;
    loading = true;
    refresh.disabled = true;
    if (!quiet) setNotice('Reading this session’s MCP servers…');
    try {
      const result = await api.listMcpServers(session.id);
      if (!result.ok) {
        servers = [];
        selected = null;
        render();
        setNotice(result.reason, 'error');
        return;
      }
      servers = result.servers;
      if (!selected || !servers.some((server) => server.name === selected)) {
        selected = servers[0]?.name ?? null;
      }
      render();
      setNotice(
        servers.length
          ? `${servers.length} server${servers.length === 1 ? '' : 's'} visible to this ${session.agent} session.`
          : 'No MCP servers are configured for this session.',
      );
    } catch (error) {
      setNotice(`Could not read MCP servers — ${String(error)}`, 'error');
    } finally {
      loading = false;
      refresh.disabled = false;
    }
  }

  function render(): void {
    list.replaceChildren();
    if (!servers.length) {
      list.append(text('div', 'No configured servers', 'mcp-empty'));
      detail.replaceChildren(text('div', 'This list comes from the running session, not from another folder.', 'mcp-empty'));
      return;
    }
    for (const server of servers) {
      const row = button('', `mcp-server-row${server.name === selected ? ' selected' : ''}`, () => {
        selected = server.name;
        render();
      });
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(server.name === selected));
      const first = el('span', 'mcp-server-row-main');
      first.append(statusMark(server.status), text('span', server.title || server.name, 'mcp-server-name'));
      row.append(
        first,
        text('span', server.scope.label, `mcp-scope scope-${server.scope.kind}`),
        text('span', readable(server.status), 'mcp-server-state'),
      );
      list.append(row);
    }
    const server = servers.find((row) => row.name === selected) ?? servers[0];
    if (server) renderDetail(server);
  }

  function renderDetail(server: McpServerView): void {
    detail.replaceChildren();
    const heading = el('div', 'mcp-detail-heading');
    const name = el('div', 'mcp-detail-name');
    name.append(text('h4', server.title || server.name), statusMark(server.status));
    if (server.title && server.title !== server.name) name.append(text('code', server.name));
    heading.append(name, text('span', server.scope.label, `mcp-scope scope-${server.scope.kind}`));
    detail.append(heading);
    if (server.description) detail.append(text('p', server.description, 'mcp-description'));
    if (server.error) detail.append(text('div', server.error, 'mcp-error'));

    const facts = el('dl', 'mcp-facts');
    fact(facts, 'Status', readable(server.status));
    fact(facts, 'Authentication', readable(server.authStatus));
    fact(facts, 'Configured in', server.scope.label);
    if (server.scope.detail) fact(facts, 'Source', server.scope.detail);
    if (server.transport) fact(facts, 'Transport', server.transport);
    if (server.endpoint) fact(facts, 'Endpoint', server.endpoint);
    if (server.version) fact(facts, 'Version', server.version);
    fact(facts, 'Resources', String(server.resourceCount));
    detail.append(facts);

    const tools = el('section', 'mcp-detail-section');
    tools.append(text('h5', `Tools · ${server.tools.length}`));
    tools.append(server.tools.length
      ? chips(server.tools)
      : text('div', 'No tools reported.', 'mcp-empty compact'));
    detail.append(tools);
    if (server.capabilities.length) {
      const capabilities = el('section', 'mcp-detail-section');
      capabilities.append(text('h5', 'Capabilities'), chips(server.capabilities));
      detail.append(capabilities);
    }

    const controls = el('div', 'mcp-server-actions');
    controls.append(actionButton('Reconnect', 'reconnect', server.actions.reconnect, server));
    controls.append(actionButton('Authenticate', 'authenticate', server.actions.authenticate, server));
    controls.append(actionButton(
      'Reauthenticate',
      'reauthenticate',
      server.actions.authenticate && server.actions.clearAuthentication,
      server,
    ));
    controls.append(actionButton(
      'Clear authentication',
      'clear-authentication',
      server.actions.clearAuthentication,
      server,
      'danger',
    ));
    detail.append(controls);
  }

  function actionButton(
    label: string,
    action: McpServerAction,
    available: boolean,
    server: McpServerView,
    tone = 'ghost',
  ): HTMLButtonElement {
    const control = button(label, `btn small ${tone}`, () => void act(server, action));
    control.disabled = acting || !available;
    if (!available) control.title = `${session.agent} does not offer this action for this server.`;
    return control;
  }

  async function act(server: McpServerView, action: McpServerAction): Promise<void> {
    if (acting) return;
    acting = true;
    render();
    setNotice(`${actionLabel(action)} ${server.name}…`);
    try {
      const result = await api.manageMcpServer(session.id, server.name, action);
      setNotice(result.message, result.ok ? undefined : 'error');
      if (result.authorizationUrl) {
        const opened = await api.openExternal(result.authorizationUrl);
        if (!opened) setNotice('Authentication started, but the browser URL could not be opened.', 'error');
      }
      if (result.ok) setTimeout(() => void load(true), 500);
    } catch (error) {
      setNotice(`MCP action failed — ${String(error)}`, 'error');
    } finally {
      acting = false;
      render();
    }
  }

  function setNotice(message: string, tone?: 'error'): void {
    notice.textContent = message;
    notice.classList.toggle('is-error', tone === 'error');
  }

  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  close.focus();
  void load();
}

function statusMark(status: string): HTMLElement {
  return text('span', '', `mcp-status status-${status.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
}

function fact(list: HTMLElement, label: string, value: string): void {
  list.append(text('dt', label), text('dd', value));
}

function chips(values: string[]): HTMLElement {
  const wrap = el('div', 'mcp-chip-list');
  for (const value of values) wrap.append(text('code', value, 'mcp-chip'));
  return wrap;
}

function readable(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase();
}

function actionLabel(action: McpServerAction): string {
  switch (action) {
    case 'reconnect': return 'Reconnecting';
    case 'authenticate': return 'Authenticating';
    case 'reauthenticate': return 'Reauthenticating';
    case 'clear-authentication': return 'Clearing authentication for';
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function text(tag: string, value: string, className = ''): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.onclick = action;
  return node;
}
