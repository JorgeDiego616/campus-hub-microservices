import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rolSolicitadoEnRegistro,
  puedeRegistrarConRol,
  assertPuedeListarUsuarios,
  assertPuedeVerUsuario
} from '../src/domain/authorization.js';
import { Usuario, normalizarEmail } from '../src/domain/entities.js';

// Estas pruebas no necesitan Mongo ni Redis: solo revisan las reglas del dominio.

const admin = { id: 'admin-1', rol: 'ADMIN' };
const estudiante = { id: 'alumno-1', rol: 'ESTUDIANTE' };

test('sin rol (o vacío) el registro queda como ESTUDIANTE', () => {
  assert.equal(rolSolicitadoEnRegistro(undefined), 'ESTUDIANTE');
  assert.equal(rolSolicitadoEnRegistro(null), 'ESTUDIANTE');
  assert.equal(rolSolicitadoEnRegistro('   '), 'ESTUDIANTE');
  assert.equal(rolSolicitadoEnRegistro(' profesor '), 'PROFESOR');
});

test('un anónimo solo se puede registrar como ESTUDIANTE (el bug era pedir ADMIN)', () => {
  assert.equal(puedeRegistrarConRol('ESTUDIANTE', null), true);
  assert.equal(puedeRegistrarConRol('ADMIN', null), false);
  assert.equal(puedeRegistrarConRol('PROFESOR', null), false);
});

test('un ESTUDIANTE logueado tampoco puede dar de alta a un ADMIN', () => {
  assert.equal(puedeRegistrarConRol('ADMIN', estudiante), false);
});

test('un ADMIN sí puede registrar usuarios con cualquier rol', () => {
  assert.equal(puedeRegistrarConRol('PROFESOR', admin), true);
  assert.equal(puedeRegistrarConRol('ADMIN', admin), true);
});

test('el email se normaliza a minúsculas y sin espacios', () => {
  assert.equal(normalizarEmail('  Ana@Test.COM '), 'ana@test.com');
  assert.equal(normalizarEmail(undefined), '');
});

test('validaciones de registro: email, nombre y contraseña', () => {
  const valido = new Usuario(null, '20260001', 'Ana', 'ana@test.com', 'ESTUDIANTE');
  assert.doesNotThrow(() => valido.validarEmail());
  assert.doesNotThrow(() => valido.validarNombre());

  assert.throws(() => new Usuario(null, '20260001', 'Ana', 'hola', 'ESTUDIANTE').validarEmail(), /email/);
  assert.throws(() => new Usuario(null, '20260001', '  ', 'a@b.com', 'ESTUDIANTE').validarNombre(), /nombre/);

  assert.throws(() => Usuario.validarPassword('12345'), /al menos 6/);
  assert.doesNotThrow(() => Usuario.validarPassword('123456'));
});

// --------------------------------------------------
// Consultas de usuarios (antes cualquiera sin token veía a todos)
// --------------------------------------------------

test('allUsuarios: sin sesión es 401 y un ESTUDIANTE es 403', () => {
  assert.throws(() => assertPuedeListarUsuarios(null), (e) => e.extensions.code === 'UNAUTHENTICATED');
  assert.throws(() => assertPuedeListarUsuarios(estudiante), (e) => e.extensions.code === 'FORBIDDEN');
  assert.doesNotThrow(() => assertPuedeListarUsuarios(admin));
});

test('verUsuario: cada quien ve el suyo y el ADMIN ve cualquiera', () => {
  assert.throws(() => assertPuedeVerUsuario(null, 'alumno-1'), (e) => e.extensions.code === 'UNAUTHENTICATED');
  assert.doesNotThrow(() => assertPuedeVerUsuario(estudiante, 'alumno-1'));
  assert.throws(() => assertPuedeVerUsuario(estudiante, 'otro-id'), (e) => e.extensions.code === 'FORBIDDEN');
  assert.doesNotThrow(() => assertPuedeVerUsuario(admin, 'otro-id'));
});

test('los errores de validación salen como BAD_USER_INPUT (antes INTERNAL_SERVER_ERROR)', () => {
  assert.throws(
    () => new Usuario(null, 'abc', 'Ana', 'ana@test.com', 'ESTUDIANTE').validarMatricula(),
    (e) => e.extensions.code === 'BAD_USER_INPUT' && /matrícula/.test(e.message)
  );
});
