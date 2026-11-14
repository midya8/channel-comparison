'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {waitForDebugger, waitForDownload} = require('./chrome_support.cjs');

// These tests exercise transport readiness, not ChannelLab's result assertions.
test('debugger readiness tolerates transport, HTTP and missing-page starts', async () => {
  let calls = 0, sleeps = 0;
  const page = {type:'page', webSocketDebuggerUrl:'ws://localhost/devtools/page/example'};
  const fetchFn = async () => {
    calls++;
    if (calls === 1) throw Error('not listening yet');
    if (calls === 2) return {ok:false, status:503};
    if (calls === 3) return {ok:true, json:async () => [{type:'background_page'}]};
    return {ok:true, json:async () => [page]};
  };
  const actual = await waitForDebugger('http://localhost/json/list', {
    fetchFn, sleep:async () => {sleeps++;}, attempts:4,
  });
  assert.equal(actual, page);
  assert.equal(calls, 4);
  assert.equal(sleeps, 3);
});

test('debugger readiness has a fixed attempt bound and preserves its cause', async () => {
  const cause = Error('connection refused');
  let calls = 0;
  await assert.rejects(waitForDebugger('http://localhost/json/list', {
    fetchFn:async () => {calls++; throw cause;}, sleep:async () => {}, attempts:3,
  }), error => {
    assert.match(error.message, /Chrome debugger endpoint did not become ready: connection refused/);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(calls, 3);
});

test('debugger readiness stops when the owned browser has exited', async () => {
  let alive = true, calls = 0;
  await assert.rejects(waitForDebugger('http://localhost/json/list', {
    fetchFn:async () => {calls++; return {ok:true, json:async () => []};},
    sleep:async () => {alive = false;}, alive:() => alive, attempts:10,
  }), /debugger has no page target/);
  assert.equal(calls, 1);
});

test('debugger discovery rejects targets without a usable websocket URL', async () => {
  await assert.rejects(waitForDebugger('http://localhost/json/list', {
    fetchFn:async () => ({ok:true, json:async () => [
      {type:'page'}, {type:'page', webSocketDebuggerUrl:42},
      {type:'background_page', webSocketDebuggerUrl:'ws://localhost/background'},
    ]}), sleep:async () => {}, attempts:1,
  }), /debugger has no page target/);
});

async function temporaryDownload(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-download-test-'));
  try { await run(path.join(dir, 'report.json')); }
  finally { fs.rmSync(dir, {recursive:true, force:true}); }
}

test('download readiness accepts exact bytes only after the partial marker disappears', async () => {
  await temporaryDownload(async file => {
    fs.writeFileSync(file, '{}\n');
    fs.writeFileSync(file + '.crdownload', '');
    await assert.rejects(waitForDownload(file, 3, {timeoutMs:20, pollMs:1}), /download did not complete/);
    fs.unlinkSync(file + '.crdownload');
    await waitForDownload(file, 3);
  });
});

test('download readiness rejects oversize, missing and short files', async () => {
  await temporaryDownload(async file => {
    fs.writeFileSync(file, 'too long');
    await assert.rejects(waitForDownload(file, 3), /download exceeds expected byte count/);
    fs.writeFileSync(file, '{}');
    await assert.rejects(waitForDownload(file, 3, {timeoutMs:20, pollMs:1}), /download did not complete/);
    fs.unlinkSync(file);
    await assert.rejects(waitForDownload(file, 3, {timeoutMs:20, pollMs:1}), /download did not complete/);
  });
});

test('download readiness rejects invalid expected byte counts', async () => {
  for (const size of [0, -1, 1.5, NaN, '3', null]) {
    await assert.rejects(waitForDownload('unused-path', size), TypeError);
  }
});
