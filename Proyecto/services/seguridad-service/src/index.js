
import 'dotenv/config';

import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';

import { parse, GraphQLError } from 'graphql';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import { createClient } from 'redis';

import {
  initRabbitMQ,
  emitirEventoSeguridad
} from './infrastructure/rabbitmq.js';

import {
  UsuarioModel,
  RolModel
} from './infrastructure/mongoose-models.js';

import { runtimeConfig } from './infrastructure/runtime-config.js';
import { getDriver } from './infrastructure/database.js';

import {
  Usuario,
  ROLES_POR_DEFECTO,
  normalizarEmail
} from './domain/entities.js';

import {
  rolSolicitadoEnRegistro,
  puedeRegistrarConRol,
  prohibido,
  requireActor,
  assertPuedeVerUsuario,
  assertPuedeListarUsuarios
} from './domain/authorization.js';

import { ensureRbacConstraints } from './infrastructure/neo4j-constraints.js';

import { seedRoleHierarchy } from './infrastructure/neo4j-role-hierarchy.js';
import { seedRoutesAndAccess } from './infrastructure/neo4j-routes.js';

import {
  clearMenuTree,
  seedMenuTree
} from './infrastructure/neo4j-menu.js';

import {
  syncUsersToGraph,
  upsertUserGraph
} from './infrastructure/neo4j-users.js';

import { rbacService } from './application/rbac.service.js';

// --------------------------------------------------
// CONFIGURACIÓN GENERAL
// --------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const typeDefs = parse(
  fs.readFileSync(
    path.join(__dirname, 'schema.graphql'),
    'utf8'
  )
);

const SESSION_TTL_SECONDS = 3600;

// --------------------------------------------------
// MONGODB
// --------------------------------------------------

async function conectarBaseDatos() {
  try {
    await mongoose.connect(runtimeConfig.mongoUri);

    console.log(
      '🔥 Conexión exitosa a MongoDB (seguridad-service).'
    );

  } catch (error) {
    console.error(
      '❌ Error de conexión a MongoDB:',
      error.message
    );

    process.exit(1);
  }
}

async function sembrarRoles() {
  for (const nombre of ROLES_POR_DEFECTO) {
    await RolModel.updateOne(
      { nombre },
      { nombre },
      { upsert: true }
    );
  }

  console.log('🛡️ Roles por defecto verificados.');
}

// Cuando empecé a normalizar el email en registro y login, 7 usuarios viejos
// tenían mayúsculas (ej. "Juan@test.com") y ya no habrían podido entrar.
// Esto los pasa a minúsculas una sola vez; si ya están bien no toca nada
// (el filtro solo agarra los que tienen mayúsculas o espacios).
// Lo dejo al arrancar para que también se arregle si en la nube se
// restaura un respaldo viejo.
async function normalizarEmailsExistentes() {
  try {
    const resultado = await UsuarioModel.updateMany(
      { email: { $regex: /[A-Z]|^\s|\s$/ } },
      [{ $set: { email: { $toLower: { $trim: { input: '$email' } } } } }],
      // Mongoose 9 no deja mandar un pipeline (el arreglo de arriba) si no
      // se lo pides explícitamente con esta opción.
      { updatePipeline: true }
    );

    if (resultado.modifiedCount > 0) {
      console.log(`📧 Emails normalizados a minúsculas: ${resultado.modifiedCount}.`);
    }

  } catch (error) {
    // Si dos usuarios solo se diferencian por mayúsculas, el índice único
    // truena. No tiro el servicio por eso; aviso para arreglarlo a mano.
    console.warn(
      '⚠️ No se pudieron normalizar los emails (¿duplicados por mayúsculas?):',
      error.message
    );
  }
}

// --------------------------------------------------
// REDIS
// --------------------------------------------------

// La URL ya sale del perfil (local/docker) del runtime-config; antes caía
// en localhost:6379 sin contraseña, que no es el Redis de nuestro compose.
const redisUrl = runtimeConfig.redisUrl;

const redisClient = createClient({
  url: redisUrl
});

redisClient.on('error', (error) => {
  console.error('Redis Client Error:', error.message);
});

await redisClient.connect();

console.log(
  '⚡ Redis Stack (Lista Blanca de Sesiones) conectado exitosamente.'
);

// --------------------------------------------------
// NEO4J
// --------------------------------------------------

const driver = getDriver();

console.log('⚡ Neo4j conectado exitosamente.');

// --------------------------------------------------
// UTILIDADES
// --------------------------------------------------

function obtenerIp(context) {
  return context?.ip || 'UNKNOWN';
}

function enmascararCorreo(correo) {
  if (!correo || typeof correo !== 'string' || !correo.includes('@')) {
    return correo;
  }

  const [parteLocal, dominio] = correo.split('@');
  const enmascarada = parteLocal.charAt(0) + '*'.repeat(Math.max(1, parteLocal.length - 1));

  return `${enmascarada}@${dominio}`;
}

function aDTO(doc) {
  return {
    id: doc._id,
    matricula: doc.matricula,
    nombre: doc.nombre,
    email: doc.email,
    rol: doc.rol,
    activo: doc.activo
  };
}

// --------------------------------------------------
// GRAPHQL RESOLVERS
// --------------------------------------------------

const resolvers = {

  Query: {

    // Antes estas dos consultas no pedían token: cualquiera veía email,
    // matrícula y rol de los 18 usuarios. El RBAC del Gateway solo revisa
    // mutaciones, así que las queries se protegen aquí en el subgrafo
    // (igual que hacen deportes y mapa con sus assert*).

    // Cada quien ve su propio usuario; el ADMIN ve a cualquiera.
    verUsuario: async (_, { id }, context) => {
      assertPuedeVerUsuario(context.currentUser, id);

      // Con un id mal formado Mongoose tronaba con "Cast to ObjectId failed"
      // (y eso le enseñaba al cliente el nombre del modelo). Mejor null.
      if (!mongoose.isValidObjectId(id)) return null;

      const doc = await UsuarioModel.findById(id);

      if (!doc) return null;

      return aDTO(doc);
    },

    // La lista completa solo la ve el ADMIN.
    allUsuarios: async (_, __, context) => {
      assertPuedeListarUsuarios(context.currentUser);

      const docs = await UsuarioModel.find({});

      return docs.map(aDTO);
    },

    // Lista de roles con caché en Redis (5 minutos).
    // No es información sensible, pero tampoco tiene por qué ser pública:
    // basta con tener sesión.
    roles: async (_, __, context) => {
      requireActor(context.currentUser);

      const cached = await redisClient.get('cache:roles');

      if (cached) {
        return JSON.parse(cached);
      }

      const docs = await RolModel.find({})
        .sort({ nombre: 1 });

      const data = docs.map((doc) => ({
        id: doc._id.toString(),
        nombre: doc.nombre
      }));

      await redisClient.setEx(
        'cache:roles',
        300,
        JSON.stringify(data)
      );

      return data;
    },

    validarAccesoRuta: async (_, { path }, context) => {
      if (!context.currentUser) {
        throw new GraphQLError('No autenticado.', {
          extensions: {
            code: 'UNAUTHENTICATED',
            http: { status: 401 }
          }
        });
      }

      return rbacService.validarAccesoRuta(
        context.currentUser.id,
        path
      );
    },

    menuUsuario: async (_, __, context) => {
      if (!context.currentUser) {
        throw new GraphQLError('No autenticado.', {
          extensions: {
            code: 'UNAUTHENTICATED',
            http: { status: 401 }
          }
        });
      }

      return rbacService.obtenerMenuUsuario(
        context.currentUser.id
      );
    }
  },

  Mutation: {

    // ----------------------------------------------
    // REGISTRO DE USUARIO
    // ----------------------------------------------

    registrarUsuario: async (
      _,
      { matricula, nombre, email, password, rol },
      context
    ) => {

      // Si no mandan rol queda ESTUDIANTE (ver domain/authorization.js).
      const rolNormalizado = rolSolicitadoEnRegistro(rol);

      // Antes aquí cualquiera podía mandar rol: "ADMIN" y registrarse como
      // administrador, porque la mutación es pública en el Gateway.
      // Ahora otro rol que no sea ESTUDIANTE solo lo puede pedir un ADMIN
      // logueado (el Gateway nos pasa su identidad aunque la mutación sea
      // pública). El intento se audita igual que en crearRol.
      if (!puedeRegistrarConRol(rolNormalizado, context.currentUser)) {
        emitirEventoSeguridad({
          tipo_evento: 'ASIGNACION_ROL_PERMISO',
          usuario_id: context.currentUser?.id || null,
          ip_origen: obtenerIp(context),
          resultado: 'denegado',
          severidad: 'CRITICAL',
          motivo: 'Intento de registro con rol privilegiado sin ser ADMIN',
          jti: context.jti,
          operacion: 'registrarUsuario',
          metadata: {
            tipo_operacion: 'registrar_con_rol',
            usuario_afectado: null,
            rol_anterior: null,
            nuevo_rol: rolNormalizado,
            realizado_por: context.currentUser?.id || null,
            rol_solicitante: context.currentUser?.rol || 'ANONIMO'
          }
        });

        throw prohibido(
          'Solo un ADMIN puede registrar usuarios con un rol distinto de ESTUDIANTE.'
        );
      }

      const emailNormalizado = normalizarEmail(email);

      const usuarioDominio = new Usuario(
        null,
        matricula,
        nombre,
        emailNormalizado,
        rolNormalizado
      );

      usuarioDominio.validarMatricula();
      usuarioDominio.validarNombre();
      usuarioDominio.validarEmail();
      usuarioDominio.validarRol();
      Usuario.validarPassword(password);

      const rolExiste = await RolModel.findOne({
        nombre: rolNormalizado
      });

      if (!rolExiste) {
        throw new GraphQLError('El rol no existe.', {
          extensions: {
            code: 'BAD_USER_INPUT',
            http: { status: 400 }
          }
        });
      }

      const yaExiste = await UsuarioModel.findOne({
        $or: [
          { matricula },
          { email: emailNormalizado }
        ]
      });

      if (yaExiste) {
        throw new GraphQLError(
          'Ya existe un usuario registrado con esa matrícula o email.',
          {
            extensions: {
              code: 'BAD_REQUEST',
              http: { status: 400 }
            }
          }
        );
      }

      // La contraseña se almacena únicamente como hash.
      const passwordHash = await bcrypt.hash(password, 10);

      const nuevoUsuario = new UsuarioModel({
        matricula,
        nombre: nombre.trim(),
        email: emailNormalizado,
        passwordHash,
        rol: rolNormalizado
      });

      const doc = await nuevoUsuario.save();

      try {
        await upsertUserGraph(driver, doc);

      } catch (error) {
        console.warn(
          'No se pudo sincronizar el usuario en Neo4j:',
          error.message
        );
      }

      // Evento de registro. Nunca incluir password ni passwordHash.
      emitirEventoSeguridad({
        tipo_evento: 'USER_REGISTERED',
        usuario_id: doc._id.toString(),
        email: doc.email,
        ip_origen: obtenerIp(context),
        exito: true,
        motivo: 'Alta en el sistema',
        metadata: {
          rolInicial: doc.rol
        }
      });

      return aDTO(doc);
    },

    // ----------------------------------------------
    // LOGIN
    // ----------------------------------------------

    login: async (_, { email, password }, context) => {

      // Busco con el email normalizado, igual que como se guarda al registrar.
      const doc = await UsuarioModel.findOne({ email: normalizarEmail(email) });

      // Usuario inexistente
      if (!doc) {

        emitirEventoSeguridad({
          tipo_evento: 'AUTENTICACION_USUARIO',
          usuario_id: null,
          ip_origen: obtenerIp(context),
          resultado: 'fallido',
          severidad: 'WARNING',
          motivo: 'Usuario inexistente',
          operacion: 'login',
          metadata: {
            correo_enmascarado: enmascararCorreo(email)
          }
        });

        throw new GraphQLError('Credenciales inválidas.', {
          extensions: {
            code: 'BAD_USER_INPUT',
            http: { status: 401 }
          }
        });
      }

      // Contraseña incorrecta
      const passwordCorrecta = await bcrypt.compare(
        password,
        doc.passwordHash
      );

      if (!passwordCorrecta) {

        emitirEventoSeguridad({
          tipo_evento: 'AUTENTICACION_USUARIO',
          usuario_id: doc._id.toString(),
          ip_origen: obtenerIp(context),
          resultado: 'fallido',
          severidad: 'WARNING',
          motivo: 'Contraseña incorrecta',
          operacion: 'login',
          metadata: {
            rol: doc.rol,
            user_agent: context?.userAgent || 'NO_DISPONIBLE'
          }
        });

        throw new GraphQLError('Credenciales inválidas.', {
          extensions: {
            code: 'BAD_USER_INPUT',
            http: { status: 401 }
          }
        });
      }

      // Usuario deshabilitado
      if (!doc.activo) {

        emitirEventoSeguridad({
          tipo_evento: 'AUTENTICACION_USUARIO',
          usuario_id: doc._id.toString(),
          ip_origen: obtenerIp(context),
          resultado: 'fallido',
          severidad: 'WARNING',
          motivo: 'Usuario deshabilitado',
          operacion: 'login',
          metadata: {
            rol: doc.rol,
            user_agent: context?.userAgent || 'NO_DISPONIBLE'
          }
        });

        throw new GraphQLError(
          'Este usuario está deshabilitado.',
          {
            extensions: {
              code: 'FORBIDDEN',
              http: { status: 403 }
            }
          }
        );
      }

      // Generar identificador único de sesión.
      const jti = crypto.randomUUID();

      const token = jwt.sign(
        {
          id: doc._id.toString(),
          rol: doc.rol,
          jti
        },
        runtimeConfig.jwtSecret,
        {
          expiresIn: SESSION_TTL_SECONDS
        }
      );

      // Registrar sesión en Redis.
      await redisClient.setEx(
        `session:${jti}`,
        SESSION_TTL_SECONDS,
        JSON.stringify({
          userId: doc._id.toString(),
          rol: doc.rol
        })
      );

      // Evento de autenticación de usuario.
      // Severidad INFO para login exitoso. Nunca se envía el JWT completo.
      emitirEventoSeguridad({
        tipo_evento: 'AUTENTICACION_USUARIO',
        usuario_id: doc._id.toString(),
        ip_origen: obtenerIp(context),
        resultado: 'exitoso',
        severidad: 'INFO',
        motivo: 'Credenciales válidas',
        jti,
        operacion: 'login',
        metadata: {
          rol: doc.rol,
          user_agent: context?.userAgent || 'NO_DISPONIBLE'
        }
      });

      console.log(
        `🔑 Sesión iniciada y autorizada en Redis: session:${jti}`
      );

      return {
        token,
        usuario: aDTO(doc)
      };
    },

    // ----------------------------------------------
    // LOGOUT
    // ----------------------------------------------

    logout: async (_, __, context) => {

      if (!context.currentUser || !context.jti) {
        throw new GraphQLError(
          'No hay sesión activa para cerrar.',
          {
            extensions: {
              code: 'UNAUTHENTICATED',
              http: { status: 401 }
            }
          }
        );
      }

      await redisClient.del(
        `session:${context.jti}`
      );

      emitirEventoSeguridad({
        tipo_evento: 'SESION_REVOCADA',
        usuario_id: context.currentUser.id,
        ip_origen: obtenerIp(context),
        resultado: 'exitoso',
        severidad: 'INFO',
        motivo: 'logout_voluntario',
        jti: context.jti,
        operacion: 'logout',
        metadata: {
          usuario_que_revoca: context.currentUser.id,
          rol: context.currentUser.rol
        }
      });

      return true;
    },

    // ----------------------------------------------
    // CREAR ROL
    // ----------------------------------------------

    crearRol: async (_, { nombre }, context) => {

      if (context.currentUser?.rol !== 'ADMIN') {
        emitirEventoSeguridad({
          tipo_evento: 'ASIGNACION_ROL_PERMISO',
          usuario_id: context.currentUser?.id || null,
          ip_origen: obtenerIp(context),
          resultado: 'denegado',
          severidad: 'CRITICAL',
          motivo: 'Intento de creación de rol sin privilegios ADMIN',
          jti: context.jti,
          operacion: 'crearRol',
          metadata: {
            tipo_operacion: 'crear_rol',
            usuario_afectado: null,
            rol_anterior: null,
            nuevo_rol: nombre?.trim().toUpperCase(),
            realizado_por: context.currentUser?.id || null,
            rol_solicitante: context.currentUser?.rol || 'ANONIMO'
          }
        });
        throw new GraphQLError(
          'Solo un ADMIN puede crear roles.',
          {
            extensions: {
              code: 'FORBIDDEN',
              http: { status: 403 }
            }
          }
        );
      }

      const nombreNormalizado = nombre.trim().toUpperCase();

      if (!/^[A-ZÁÉÍÓÚÑ0-9_]{3,30}$/.test(nombreNormalizado)) {
        throw new GraphQLError(
          'El rol debe tener entre 3 y 30 caracteres: letras, números o guion bajo.',
          {
            extensions: {
              code: 'BAD_USER_INPUT',
              http: { status: 400 }
            }
          }
        );
      }

      const existe = await RolModel.findOne({
        nombre: nombreNormalizado
      });

      if (existe) {
        throw new GraphQLError(
          'Ese rol ya existe.',
          {
            extensions: {
              code: 'BAD_REQUEST',
              http: { status: 400 }
            }
          }
        );
      }

      const doc = await RolModel.create({
        nombre: nombreNormalizado
      });

      // Invalidar caché de roles.
      await redisClient.del('cache:roles');

      // Evento de asignación de rol/permiso.
      // usuario_id es el administrador que actúa; no hay usuario afectado en crear rol.
      emitirEventoSeguridad({
        tipo_evento: 'ASIGNACION_ROL_PERMISO',
        usuario_id: context.currentUser.id,
        ip_origen: obtenerIp(context),
        resultado: 'exitoso',
        severidad: 'CRITICAL',
        motivo: 'Creación de rol',
        jti: context.jti,
        operacion: 'crearRol',
        metadata: {
          tipo_operacion: 'crear_rol',
          usuario_afectado: null,
          rol_anterior: null,
          nuevo_rol: doc.nombre,
          realizado_por: context.currentUser.id
        }
      });

      return {
        id: doc._id.toString(),
        nombre: doc.nombre
      };
    },

    // ----------------------------------------------
    // CAMBIAR ROL DE USUARIO
    // ----------------------------------------------

    cambiarRolUsuario: async (_, { userId, nuevoRol }, context) => {

      // 1. Solo ADMIN puede cambiar privilegios.
      if (context.currentUser?.rol !== 'ADMIN') {
        emitirEventoSeguridad({
          tipo_evento: 'ASIGNACION_ROL_PERMISO',
          usuario_id: context.currentUser?.id || null,
          ip_origen: obtenerIp(context),
          resultado: 'denegado',
          severidad: 'CRITICAL',
          motivo: 'Intento de cambio de rol sin privilegios ADMIN',
          jti: context.jti,
          operacion: 'cambiarRolUsuario',
          metadata: {
            tipo_operacion: 'cambiar_rol',
            usuario_afectado: userId,
            rol_anterior: null,
            nuevo_rol: nuevoRol?.trim().toUpperCase(),
            realizado_por: context.currentUser?.id || null,
            rol_solicitante: context.currentUser?.rol || 'ANONIMO'
          }
        });
        throw new GraphQLError(
          'Solo un ADMIN puede cambiar los roles de usuarios.',
          {
            extensions: {
              code: 'FORBIDDEN',
              http: { status: 403 }
            }
          }
        );
      }

      // 2. Normalizar el nuevo rol.
      const rolNormalizado = nuevoRol.trim().toUpperCase();

      if (!/^[A-ZÁÉÍÓÚÑ0-9_]{3,30}$/.test(rolNormalizado)) {
        throw new GraphQLError(
          'El nombre del rol no es válido.',
          {
            extensions: {
              code: 'BAD_USER_INPUT',
              http: { status: 400 }
            }
          }
        );
      }

      // 3. Verificar que el usuario exista.
      if (!mongoose.isValidObjectId(userId)) {
        throw new GraphQLError(
          'El usuario que deseas modificar no existe.',
          {
            extensions: {
              code: 'NOT_FOUND',
              http: { status: 404 }
            }
          }
        );
      }

      const usuario = await UsuarioModel.findById(userId);

      if (!usuario) {
        throw new GraphQLError(
          'El usuario que deseas modificar no existe.',
          {
            extensions: {
              code: 'NOT_FOUND',
              http: { status: 404 }
            }
          }
        );
      }

      // 4. Verificar que el nuevo rol exista.
      const rolExiste = await RolModel.findOne({
        nombre: rolNormalizado
      });

      if (!rolExiste) {
        throw new GraphQLError(
          'El nuevo rol no existe.',
          {
            extensions: {
              code: 'BAD_USER_INPUT',
              http: { status: 400 }
            }
          }
        );
      }

      const rolAnterior = usuario.rol;

      if (rolAnterior === rolNormalizado) {
        throw new GraphQLError(
          'El usuario ya tiene asignado ese rol.',
          {
            extensions: {
              code: 'BAD_USER_INPUT',
              http: { status: 400 }
            }
          }
        );
      }

      // 5. Actualizar el rol en MongoDB.
      usuario.rol = rolNormalizado;
      await usuario.save();

      // 6. Sincronizar el nuevo rol con Neo4j.
      try {
        await upsertUserGraph(driver, usuario);

      } catch (error) {
        console.error(
          'No se pudo sincronizar el cambio de rol en Neo4j:',
          error.message
        );

        try {
          const rollback = await UsuarioModel.updateOne(
            { _id: usuario._id, rol: rolNormalizado },
            { $set: { rol: rolAnterior } }
          );

          if (rollback.matchedCount !== 1) {
            throw new Error('No se encontró el rol actualizado para revertirlo.');
          }

        } catch (rollbackError) {
          console.error(
            'No se pudo revertir el rol en MongoDB:',
            rollbackError.message
          );

          throw new GraphQLError(
            'El rol se actualizó en MongoDB, pero no se pudo sincronizar en Neo4j. Se requiere reconciliación manual.',
            {
              extensions: {
                code: 'SYNC_FAILED',
                http: { status: 500 }
              }
            }
          );
        }

        throw new GraphQLError(
          'No se pudo sincronizar el cambio de rol en Neo4j. El cambio fue revertido en MongoDB.',
          {
            extensions: {
              code: 'SYNC_FAILED',
              http: { status: 500 }
            }
          }
        );
      }

      // 7. Registrar el evento de auditoría.
      // usuario_id es el administrador que actúa; usuario_afectado es el titular del rol cambiado.
      emitirEventoSeguridad({
        tipo_evento: 'ASIGNACION_ROL_PERMISO',
        usuario_id: context.currentUser.id,
        ip_origen: obtenerIp(context),
        resultado: 'exitoso',
        severidad: 'CRITICAL',
        motivo: 'Actualización de privilegios del usuario',
        jti: context.jti,
        operacion: 'cambiarRolUsuario',
        metadata: {
          tipo_operacion: 'cambiar_rol',
          usuario_afectado: usuario._id.toString(),
          rol_anterior: rolAnterior,
          nuevo_rol: rolNormalizado,
          realizado_por: context.currentUser.id
        }
      });

      console.log(
        `🔐 Rol actualizado: ${usuario.email} | ${rolAnterior} → ${rolNormalizado}`
      );

      return aDTO(usuario);
    }
  },

  Usuario: {
    __resolveReference: async (reference) => {
      const doc = await UsuarioModel.findById(reference.id);

      if (!doc) return null;

      return aDTO(doc);
    }
  }
};

// --------------------------------------------------
// ARRANQUE DEL SERVIDOR
// --------------------------------------------------

async function main() {

  await conectarBaseDatos();

  await sembrarRoles();

  await normalizarEmailsExistentes();

  await driver.verifyConnectivity();

  const constraints = await ensureRbacConstraints(driver);

  console.log(
    `🛡️ Constraints RBAC verificadas: ${constraints.join(', ')}`
  );

  await seedRoleHierarchy(driver);

  console.log('🌳 Jerarquía de roles sembrada en Neo4j.');

  await seedRoutesAndAccess(driver);

  console.log('🧭 Rutas y accesos sembrados en Neo4j.');

  await clearMenuTree(driver);

  console.log('🗑️ Árbol de menú limpiado en Neo4j.');

  await seedMenuTree(driver);

  console.log('🗂️ Árbol de menú sembrado en Neo4j.');

  const usuariosSincronizados = await syncUsersToGraph(driver);

  console.log(
    `👤 Usuarios sincronizados en Neo4j: ${usuariosSincronizados}.`
  );

  // Fail-Safe: si RabbitMQ falla, Seguridad puede iniciar.
  await initRabbitMQ(runtimeConfig.rabbitMqUrl);

  const server = new ApolloServer({
    schema: buildSubgraphSchema([
      { typeDefs, resolvers }
    ])
  });

  const port = runtimeConfig.port;

  const { url } = await startStandaloneServer(server, {
    listen: { port },

    context: async ({ req }) => {

      // Antes solo usaba req.socket.remoteAddress, que es la conexión del
      // Gateway, no la del usuario: por eso en auditoría todo salía "::1".
      // Ahora el Gateway nos manda la IP y el user-agent reales en headers
      // (ver gateway/src/client-info.js). Si llaman al subgrafo directo
      // (solo en local, en la nube no está expuesto) cae al socket.
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'UNKNOWN';
      const userAgent = req.headers['x-client-user-agent'] || null;

      const authHeader = req.headers.authorization || '';

      if (authHeader.startsWith('Bearer ')) {

        const token = authHeader.split(' ')[1];

        try {
          const decoded = jwt.verify(
            token,
            runtimeConfig.jwtSecret
          );

          const sesion = await redisClient.get(
            `session:${decoded.jti}`
          );

          if (sesion) {
            return {
              currentUser: {
                id: decoded.id,
                rol: decoded.rol
              },
              jti: decoded.jti,
              ip,
              userAgent
            };
          }

          console.warn(
            `🔒 SESIÓN EXPIRADA/INVALIDADA: jti=${decoded.jti}, userId=${decoded.id}`
          );

        } catch (error) {
          console.warn(
            'Token inválido o expirado:',
            error.message
          );
        }
      }

      return {
        currentUser: null,
        jti: null,
        ip,
        userAgent
      };
    }
  });

  console.log(
    `🔐 Subgrafo de Seguridad levantado exitosamente en: ${url}`
  );
}

main().catch((error) => {
  console.error(
    '❌ Error fatal al iniciar el subgrafo de Seguridad:',
    error
  );

  process.exit(1);
});
