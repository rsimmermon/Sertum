// Run with Electron as Node and SERTUM_DEBUG_PORT set for the local app.
async function main() {
  const pages = await (await fetch(`http://127.0.0.1:${process.env.SERTUM_DEBUG_PORT || 9333}/json/list`)).json();
  const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => ws.onopen = resolve);
  let next = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const listener = event => {
      const data = JSON.parse(event.data);
      if (data.id !== id) return;
      ws.removeEventListener('message', listener);
      data.error ? reject(data.error) : resolve(data.result);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:10,y:10,button:'left',clickCount:1});
  const position = await evaluate(`(() => {
    window.getSelection().removeAllRanges();
    window.selectionEvents = [];
    for (const type of ['pointerdown','mousedown','selectstart','dragstart','mouseup']) {
      document.addEventListener(type,e=>window.selectionEvents.push({type,target:e.target.className,prevented:e.defaultPrevented}),{once:true});
    }
    const bubble = document.querySelector('.chat-user .chat-bubble');
    bubble.scrollIntoView({block:'center'});
    const node = bubble.firstChild;
    const range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 4);
    const rect=range.getBoundingClientRect();
    return { x:rect.x+1, end:rect.right-1, y:rect.y+rect.height/2,text:node.textContent.slice(0,4) };
  })()`);
  await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:position.x,y:position.y});
  await send('Input.dispatchMouseEvent', {type:'mousePressed',x:position.x,y:position.y,button:'left',clickCount:1});
  const moves=[];
  for(let i=1;i<=5;i++) moves.push(send('Input.dispatchMouseEvent',{type:'mouseMoved',x:position.x+(position.end-position.x)*i/5,y:position.y,button:'left',buttons:1}));
  moves.push(send('Input.dispatchMouseEvent',{type:'mouseReleased',x:position.end,y:position.y,button:'left',clickCount:1}));
  await Promise.all(moves);
  console.log(JSON.stringify({position,result:await evaluate(`({text:window.getSelection().toString(),events:window.selectionEvents,active:document.activeElement.className})`)},null,2));
  const assert = require('node:assert/strict');
  assert.equal(await evaluate('window.getSelection().toString()'),position.text);
  const original = await evaluate('document.documentElement.getAttribute("data-theme")');
  try {
    for (const theme of ['dark','light']) {
      const colors = await evaluate(`(() => {
        document.documentElement.setAttribute('data-theme', '${theme}');
        const e=document.querySelector('.chat-user .chat-bubble');
        return {bubble:getComputedStyle(e).backgroundColor,highlight:getComputedStyle(e,'::selection').backgroundColor,text:getComputedStyle(e,'::selection').color};
      })()`);
      assert.notEqual(colors.bubble,colors.highlight);
      assert.notEqual(colors.text,colors.highlight);
      console.log(theme, colors);
      const shot=await send('Page.captureScreenshot',{});
      require('node:fs').writeFileSync(`.vite/selection-${theme}.png`,Buffer.from(shot.data,'base64'));
    }
  } finally {
    await evaluate(original === null ? 'document.documentElement.removeAttribute("data-theme")' : `document.documentElement.setAttribute('data-theme',${JSON.stringify(original)})`);
  }
  ws.close();
}
main().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
