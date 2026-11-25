import assert from 'node:assert/strict';
import test from 'node:test';

import { Equipo } from '../src/domain/entities.js';
import { assertCanReadSports, assertCanManageSports } from '../src/domain/authorization.js';

// Antes deportes no tenía pruebas ("test": "echo Error..."). Estas revisan las
// reglas del dominio sin tocar MongoDB.

const practicaExistente = { fecha: '2026-12-01', horaInicio: '10:00', horaFin: '12:00', ubicacionId: 'cancha-1' };
const equipo = () => new Equipo('eq-1', 'Halcones', 'Fútbol', 'Varonil', [practicaExistente]);

test('rechaza una práctica cuya hora de fin no es posterior al inicio', () => {
  assert.throws(
    () => equipo().validarHorarioPractica({ fecha: '2026-12-02', horaInicio: '11:00', horaFin: '10:00' }),
    (e) => e.extensions.code === 'BAD_USER_INPUT' && /posterior/.test(e.message)
  );
});

test('rechaza una práctica que se traslapa el mismo día', () => {
  assert.throws(
    () => equipo().validarHorarioPractica({ fecha: '2026-12-01', horaInicio: '11:00', horaFin: '13:00' }),
    (e) => e.extensions.code === 'BAD_USER_INPUT' && /traslapa/.test(e.message)
  );
});

test('acepta una práctica pegada (termina 12:00, empieza 12:00) o en otro día', () => {
  assert.doesNotThrow(() => equipo().validarHorarioPractica({ fecha: '2026-12-01', horaInicio: '12:00', horaFin: '13:00' }));
  assert.doesNotThrow(() => equipo().validarHorarioPractica({ fecha: '2026-12-02', horaInicio: '10:00', horaFin: '12:00' }));
});

test('leer deportes requiere sesión; administrarlos requiere ADMIN o ENTRENADOR', () => {
  assert.throws(() => assertCanReadSports(null), (e) => e.extensions.code === 'UNAUTHENTICATED');
  assert.doesNotThrow(() => assertCanReadSports({ id: 'a', rol: 'ESTUDIANTE' }));

  assert.throws(() => assertCanManageSports({ id: 'a', rol: 'ESTUDIANTE' }), (e) => e.extensions.code === 'FORBIDDEN');
  assert.doesNotThrow(() => assertCanManageSports({ id: 'e', rol: 'ENTRENADOR' }));
  // ADMIN hereda lo de ENTRENADOR.
  assert.doesNotThrow(() => assertCanManageSports({ id: 'x', rol: 'ADMIN' }));
});

// Antes estas validaciones solo las hacía Mongoose al guardar y salían como
// error interno ("Error interno del servidor." en producción).
test('validarDatos: categoría fuera del catálogo, nombre o deporte vacíos -> BAD_USER_INPUT', () => {
  assert.throws(
    () => new Equipo(null, 'A', 'Fútbol', 'PRUEBA').validarDatos(),
    (e) => e.extensions.code === 'BAD_USER_INPUT' && /VARONIL, FEMENIL, MIXTO/.test(e.message)
  );
  assert.throws(() => new Equipo(null, '  ', 'Fútbol', 'MIXTO').validarDatos(), /nombre/);
  assert.throws(() => new Equipo(null, 'A', '', 'MIXTO').validarDatos(), /deporte/);
  assert.doesNotThrow(() => new Equipo(null, 'A', 'Fútbol', 'MIXTO').validarDatos());
});
