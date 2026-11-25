import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCanViewAudit, effectiveRoles } from '../src/domain/authorization.js';

// Antes auditoría no tenía pruebas ("test": "echo Error..."). Los logs son
// información forense, así que reviso que solo el ADMIN los pueda leer.

test('sin sesión no se pueden ver los logs (401)', () => {
  assert.throws(() => assertCanViewAudit(null), (e) => e.extensions.code === 'UNAUTHENTICATED');
});

test('ningún rol que no sea ADMIN ve los logs (403)', () => {
  for (const rol of ['ESTUDIANTE', 'PROFESOR', 'ENTRENADOR', 'COORDINADOR', 'BECARIO']) {
    assert.throws(
      () => assertCanViewAudit({ id: 'u', rol }),
      (e) => e.extensions.code === 'FORBIDDEN',
      `el rol ${rol} no debería ver auditoría`
    );
  }
});

test('el ADMIN sí ve los logs', () => {
  assert.doesNotThrow(() => assertCanViewAudit({ id: 'admin', rol: 'ADMIN' }));
});

test('la herencia es igual a la de Neo4j: ADMIN hereda a BECARIO y ESTUDIANTE', () => {
  const roles = effectiveRoles({ id: 'admin', rol: 'ADMIN' });
  assert.ok(roles.has('BECARIO'));
  assert.ok(roles.has('ESTUDIANTE'));
  // Y al revés no: un ESTUDIANTE no hereda nada.
  assert.deepEqual([...effectiveRoles({ id: 'a', rol: 'ESTUDIANTE' })], ['ESTUDIANTE']);
});
