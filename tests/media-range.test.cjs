const { test } = require('node:test');
const assert = require('node:assert/strict');
const rangeModule = import('../media-range.mjs');

test('audio requests support bounded, open-ended, and suffix ranges', async () => {
  const { parseByteRange } = await rangeModule;
  assert.equal(parseByteRange(undefined, 1000), undefined);
  assert.deepEqual(parseByteRange('bytes=100-299', 1000), { start: 100, end: 299 });
  assert.deepEqual(parseByteRange('bytes=100-', 1000), { start: 100, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-200', 1000), { start: 800, end: 999 });
  assert.deepEqual(parseByteRange('bytes=900-1200', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-1200', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseByteRange('bytes=0-0', 1000), { start: 0, end: 0 });
});

test('invalid or unsatisfiable audio ranges are rejected', async () => {
  const { parseByteRange } = await rangeModule;
  for (const header of ['bytes=', 'bytes=-', 'bytes=-0', 'bytes=1000-', 'bytes=300-100', 'bytes=0-1,4-5', 'items=1-2', 'bytes=99999999999999999999-']) {
    assert.equal(parseByteRange(header, 1000), null, header);
  }
  assert.equal(parseByteRange('bytes=0-', 0), null);
});
