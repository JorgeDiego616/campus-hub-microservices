import { UsuarioModel } from './mongoose-models.js';

async function upsertUserTx(tx, user) {
  const id = user._id.toString();
  const role = user.rol;

  await tx.run(
    `MATCH (u:User {id: $id})-[old:HAS_ROLE]->(:Role)
     DELETE old`,
    { id }
  );

  await tx.run(
    `MERGE (u:User {id: $id})
     SET u.role = $role
     MERGE (r:Role {name: $role})
     MERGE (u)-[:HAS_ROLE]->(r)`,
    { id, role }
  );
}

export async function upsertUserGraph(driver, user) {
  const session = driver.session();
  try {
    await session.executeWrite((tx) => upsertUserTx(tx, user));
  } finally {
    await session.close();
  }
}

export async function syncUsersToGraph(driver) {
  const users = await UsuarioModel.find({}, { rol: 1 }).lean();
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      for (const user of users) {
        await upsertUserTx(tx, user);
      }
    });
  } finally {
    await session.close();
  }
  return users.length;
}
