const ROLES = [
  { name: 'ADMIN', level: 1, description: 'Administrador del campus' },
  { name: 'PROFESOR', level: 2, description: 'Docente' },
  { name: 'ENTRENADOR', level: 2, description: 'Entrenador deportivo' },
  { name: 'COORDINADOR', level: 2, description: 'Coordinador de actividades' },
  // BECARIO NO es un alumno con beca: es el coordinador que administra las becas
  // de todos los estudiantes becarios. Por eso va en nivel 2, como COORDINADOR.
  { name: 'BECARIO', level: 2, description: 'Coordinador de becas' },
  { name: 'ESTUDIANTE', level: 3, description: 'Alumno regular' }
];

const INHERITS = [
  ['ADMIN', 'PROFESOR'],
  ['ADMIN', 'ENTRENADOR'],
  ['ADMIN', 'COORDINADOR'],
  // ADMIN también hereda lo del coordinador de becas (registrar horas becarias).
  ['ADMIN', 'BECARIO'],
  ['PROFESOR', 'ESTUDIANTE'],
  ['ENTRENADOR', 'ESTUDIANTE'],
  ['COORDINADOR', 'ESTUDIANTE'],
  ['BECARIO', 'ESTUDIANTE']
];

export async function seedRoleHierarchy(driver) {
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      for (const role of ROLES) {
        await tx.run(
          `MERGE (r:Role {name: $name})
           SET r.description = $description, r.level = $level`,
          role
        );
      }

      for (const [superior, inferior] of INHERITS) {
        await tx.run(
          `MATCH (s:Role {name: $superior})
           MATCH (i:Role {name: $inferior})
           MERGE (s)-[:INHERITS]->(i)`,
          { superior, inferior }
        );
      }
    });
  } finally {
    await session.close();
  }
}