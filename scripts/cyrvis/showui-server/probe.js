/*
 * Static probe for the ShowUI sidecar. Sends a screenshot + instruction and
 * prints the translated UI-TARS actions. Does not execute any GUI action.
 */
const fs = require('node:fs');
const http = require('node:http');

const imagePath = process.argv[2];
const instruction = process.argv[3] || '在搜索框输入 PARIS，然后按回车。';
if (!imagePath) {
  console.error('usage: node probe.js <screenshot.png> [instruction]');
  process.exit(1);
}

const image = fs.readFileSync(imagePath).toString('base64');
const body = JSON.stringify({
  model: 'showui-2b',
  messages: [
    { role: 'user', content: `## User Instruction\n${instruction}` },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${image}` },
        },
      ],
    },
  ],
  max_tokens: 256,
  stream: false,
});

const started = Date.now();
const req = http.request(
  {
    host: '127.0.0.1',
    port: 8000,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      console.log(
        JSON.stringify(
          {
            status: res.statusCode,
            elapsedMs: Date.now() - started,
            body: safeParse(data),
          },
          null,
          2,
        ),
      );
    });
  },
);
req.on('error', (error) => {
  console.error('PROBE FAILED:', error.message);
  process.exit(1);
});
req.write(body);
req.end();

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
