const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Implementação inline para testar o padrão (não importa server.js inteiro)
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

test('writeJson escreve dados corretamente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaflix-test-'));
  const file = path.join(dir, 'test.json');
  writeJsonAtomic(file, { foo: 'bar', n: 42 });
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.foo, 'bar');
  assert.equal(result.n, 42);
  fs.rmSync(dir, { recursive: true });
});

test('writeJson não deixa ficheiro .tmp após sucesso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaflix-test-'));
  const file = path.join(dir, 'test.json');
  writeJsonAtomic(file, { ok: true });
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.rmSync(dir, { recursive: true });
});

test('writeJson cria directório se não existir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaflix-test-'));
  const file = path.join(dir, 'sub', 'nested', 'test.json');
  writeJsonAtomic(file, { nested: true });
  assert.ok(fs.existsSync(file));
  fs.rmSync(dir, { recursive: true });
});
