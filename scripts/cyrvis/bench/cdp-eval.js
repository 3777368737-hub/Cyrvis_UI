/* Evaluate an expression in the running UI-TARS renderer (dev debugging). */
const http = require('node:http');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..', '..');
const WebSocket = require(path.join(repo, 'node_modules', 'ws'));
const expression = process.argv[2];
if (!expression) {
  console.error('usage: node cdp-eval.js "<js expression>"');
  process.exit(1);
}

function targets() {
  return new Promise((resolve, reject) => {
    http
      .get('http://127.0.0.1:9222/json/list', (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

async function main() {
  const list = await targets();
  const target = list.find(
    (item) =>
      item.type === 'page' &&
      (item.title === 'UI-TARS Desktop' ||
        (item.url || '').includes('localhost:5173')),
  );
  if (!target) throw new Error('UI-TARS page not found');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 15000);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id === 1) {
        clearTimeout(timer);
        resolve(message);
        ws.close();
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('CDP EVAL FAILED:', error.message || error);
  process.exit(1);
});
