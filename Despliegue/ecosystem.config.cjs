// Configuración de pm2: los mismos 6 procesos que en mi PC abro en 6
// terminales con "npm start", pero aquí los deja corriendo en segundo plano
// y los reinicia si se caen.
//
// Cada servicio lee su propio .env (dotenv) porque pm2 lo arranca dentro de
// su carpeta (cwd). Esos .env los crea generar-env.sh.
const path = require('path');

const proyecto = path.join(__dirname, '..', 'Proyecto');

function servicio(nombre, carpeta) {
  return {
    name: nombre,
    cwd: path.join(proyecto, carpeta),
    script: 'src/index.js',
    // Si truena (ej. seguridad arrancó antes que Mongo), espera 5 s y reintenta.
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 50,
    time: true, // pone la hora en cada línea del log
    env: { NODE_ENV: 'production' }
  };
}

module.exports = {
  apps: [
    servicio('seguridad', 'services/seguridad-service'),
    servicio('academico', 'services/academico-service'),
    servicio('deportes', 'services/deportes-service'),
    servicio('mapa', 'services/mapa-service'),
    servicio('auditoria', 'services/auditoria-service'),
    // El gateway espera solo hasta ~1 min a que respondan los subgrafos
    // (esperar-subgrafos.js); si no, truena y pm2 lo vuelve a intentar.
    servicio('gateway', 'gateway')
  ]
};
