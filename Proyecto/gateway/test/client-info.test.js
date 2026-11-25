import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizarIp,
  obtenerIpCliente,
  obtenerClienteInfo,
  aplicarHeadersCliente
} from '../src/client-info.js';

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('normaliza IPv4 escrita como IPv6 y valores vacíos', () => {
  assert.equal(normalizarIp('::ffff:10.0.0.7'), '10.0.0.7');
  assert.equal(normalizarIp('::1'), '::1');
  assert.equal(normalizarIp(''), 'UNKNOWN');
  assert.equal(normalizarIp(undefined), 'UNKNOWN');
});

test('sin proxy de confianza ignora X-Forwarded-For (no se puede falsificar)', () => {
  const r = req('::ffff:201.1.1.1', { 'x-forwarded-for': '6.6.6.6' });
  assert.equal(obtenerIpCliente(r, false), '201.1.1.1');
});

test('con proxy de confianza usa el ÚLTIMO valor de X-Forwarded-For', () => {
  // El cliente mandó "6.6.6.6" inventado y Caddy agregó la IP real al final.
  const r = req('172.18.0.9', { 'x-forwarded-for': '6.6.6.6, 189.2.3.4' });
  assert.equal(obtenerIpCliente(r, true), '189.2.3.4');
});

test('con proxy de confianza pero sin header cae a la IP del socket', () => {
  assert.equal(obtenerIpCliente(req('172.18.0.9'), true), '172.18.0.9');
});

test('el user-agent se recorta a 256 caracteres', () => {
  const info = obtenerClienteInfo(req('1.1.1.1', { 'user-agent': 'x'.repeat(500) }));
  assert.equal(info.userAgent.length, 256);
  assert.equal(obtenerClienteInfo(req('1.1.1.1')).userAgent, null);
});

test('reemplaza los headers que mande el cliente por los calculados', () => {
  const headers = new Headers({
    'x-forwarded-for': '6.6.6.6',
    'x-client-user-agent': 'falso'
  });
  aplicarHeadersCliente(headers, { ip: '189.2.3.4', userAgent: 'okhttp/4.12' });
  assert.equal(headers.get('x-forwarded-for'), '189.2.3.4');
  assert.equal(headers.get('x-client-user-agent'), 'okhttp/4.12');
});

test('sin datos del cliente no deja pasar los headers falsos', () => {
  const headers = new Headers({ 'x-forwarded-for': '6.6.6.6' });
  aplicarHeadersCliente(headers, { ip: 'UNKNOWN', userAgent: null });
  assert.equal(headers.get('x-forwarded-for'), null);
});
