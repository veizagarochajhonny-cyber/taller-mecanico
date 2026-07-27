const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Error al conectar a Supabase:', err.stack);
  }
  console.log('⚡ Conexión exitosa a la base de datos PostgreSQL en Supabase');
  release();
});

module.exports = pool;