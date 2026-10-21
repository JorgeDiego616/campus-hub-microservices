import assert from 'node:assert/strict';
import test from 'node:test';

import { AcademicUseCases } from '../src/application/academic-use-cases.js';

test('miHorario aplica cache-aside: MongoDB en MISS y Redis en HIT', async () => {
  const values = new Map();
  let assignmentQueries = 0;
  const cache = {
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async del(keys) {
      for (const key of keys) values.delete(key);
    }
  };
  const useCases = new AcademicUseCases({
    repositories: {
      asignaciones: {
        async findByStudent() {
          assignmentQueries += 1;
          return [{ id: 'asignacion-1', materiaId: 'materia-1', grupo: 'A' }];
        }
      },
      horarios: {
        async findByAsignaciones() {
          return [{
            id: 'horario-1',
            asignacionMateriaId: 'asignacion-1',
            diaSemana: 1,
            horaInicio: '08:00',
            horaFin: '10:00',
            aula: 'A-101',
            carreraIds: []
          }];
        }
      },
      materias: {
        async findByIds() {
          return [{ id: 'materia-1', nombre: 'Cálculo' }];
        }
      }
    },
    eventPublisher: { async publish() {} },
    cache,
    horarioTtlSeconds: 60
  });

  const first = await useCases.miHorario(
    { id: 'alumno-1', rol: 'ESTUDIANTE' },
    'periodo-1'
  );
  const second = await useCases.miHorario(
    { id: 'alumno-1', rol: 'ESTUDIANTE' },
    'periodo-1'
  );

  assert.deepEqual(first, second);
  assert.equal(assignmentQueries, 1);
  assert.equal(first[0].materia, 'Cálculo');
});
