import Database from 'better-sqlite3';

const db = new Database('./data/mtgnews.db');

// Get one signal's transcription for testing
const sig = db.prepare('SELECT video_id, transcription FROM signals WHERE video_id = ?').get('icDF_qFXATM');
if (!sig) { console.log('Signal not found'); process.exit(1); }

// Build prompt like llm.ts does
function extractTranscriptionText(transcription) {
  const segments = JSON.parse(transcription);
  if (Array.isArray(segments)) {
    return segments.map((s) => `[T:${Math.floor(s.time / 1000)}] ${s.text}`).join(' ');
  }
  return transcription;
}

const text = extractTranscriptionText(sig.transcription);
console.log(`Transcription text length: ${text.length} chars`);

// Simulate the actual LLM call with retry like llm.ts does
const endpoint = 'http://127.0.0.1:1234/v1/chat/completions';
const model = process.env.LLM_MODEL || 'qwen/qwen3.6-27b';

console.log(`Testing model: ${model}`);

// Test 1: simple hello
console.log('\n--- Test 1: Simple request ---');
try {
  const r1 = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say hi' }], max_tokens: 5 })
  });
  console.log(`Status: ${r1.status} ${r1.statusText}`);
  if (!r1.ok) {
    const errBody = await r1.text();
    console.log('Response:', errBody.substring(0, 200));
  } else {
    const data = await r1.json();
    console.log('OK:', data.choices?.[0]?.message?.content);
  }
} catch (e) {
  console.log('Exception:', e.message);
}

// Test 2: real prompt (one signal)
console.log('\n--- Test 2: Real transcription prompt ---');
try {
  const r2 = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text.substring(0, 5000) }] })
  });
  console.log(`Status: ${r2.status} ${r2.statusText}`);
  if (!r2.ok) {
    const errBody = await r2.text();
    console.log('Response:', errBody.substring(0, 200));
  } else {
    const data = await r2.json();
    console.log('OK - response length:', data.choices?.[0]?.message?.content?.length);
  }
} catch (e) {
  console.log('Exception:', e.message);
}

// Test 3: concurrent requests (3 parallel, simulating real concurrency)
console.log('\n--- Test 3: 3 concurrent requests ---');
const prompts = [
  'summarize this in one sentence: apple banana cherry',
  'what is 2+2?',
  'list three colors'
];

const results = await Promise.allSettled(
  prompts.map((p, i) => 
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: p }], max_tokens: 10 })
    }).then(r => ({ idx: i, ok: r.ok, status: r.status }))
      .catch(e => ({ idx: i, error: e.message }))
  )
);

results.forEach(r => {
  if (r.status === 'fulfilled') console.log(`Request ${r.value.idx}:`, r.value.error || `HTTP ${r.value.status} ${r.value.ok ? 'OK' : 'FAIL'}`);
  else console.log(`Request ${r.reason?.idx}: REJECTED - ${r.reason?.error || r.reason}`);
});

db.close();
console.log('\nDone.');