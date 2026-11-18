/*
 * Start one GUI task in the running CYRVIS/UI-TARS renderer over CDP.
 * The app must be started with --remote-debugging-port=9222.
 */
const http = require('node:http');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..', '..');
let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  WebSocket = require(path.join(repo, 'node_modules', 'ws'));
}

const instruction = process.argv[2];
const timeoutMs = Number(process.argv[3] || 240000);
if (!instruction) {
  console.error('usage: node run-task.js <instruction> [timeoutMs]');
  process.exit(1);
}

function listTargets() {
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

function cdpEvaluate(wsUrl, expression, awaitPromise, timeout) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP timeout after ${timeout}ms`));
    }, timeout);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression,
            awaitPromise,
            returnByValue: true,
          },
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
}

async function main() {
  const targets = await listTargets();
  const target = targets.find(
    (item) =>
      item.type === 'page' &&
      (item.title === 'UI-TARS Desktop' ||
        (item.url || '').includes('localhost:5173')),
  );
  if (!target) {
    throw new Error(
      `UI-TARS page not found: ${JSON.stringify(
        targets.map((t) => ({ title: t.title, url: t.url })),
      )}`,
    );
  }

  // Do not call stopRun here: it calls showWindow() and would steal focus from
  // the benchmark target. clearHistory resets status/instructions without
  // showing the app window.
  const expression = `(async () => {
    await window.electron.ipcRenderer.invoke('clearHistory');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await window.electron.ipcRenderer.invoke('setInstructions', {
      instructions: ${JSON.stringify(instruction)},
    });
    await window.electron.ipcRenderer.invoke('runAgent');
    return 'done';
  })()`;

  const started = Date.now();
  try {
    const result = await cdpEvaluate(
      target.webSocketDebuggerUrl,
      expression,
      true,
      timeoutMs,
    );
    console.log(
      JSON.stringify({
        ok: true,
        elapsedMs: Date.now() - started,
        result,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        elapsedMs: Date.now() - started,
        error: error.message,
      }),
    );
    try {
      const stopExpression = `window.electron.ipcRenderer.invoke('stopRun')`;
      await cdpEvaluate(target.webSocketDebuggerUrl, stopExpression, false, 5000);
    } catch (stopError) {
      console.error('stopRun failed:', stopError.message);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('RUN FAILED:', error.message || error);
  process.exit(1);
});
