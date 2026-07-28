const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-supabase-js'); // Si usas supabase-js
const { Pool } = require('pg'); // Si usas conexión directa PostgreSQL

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estáticos del frontend (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de PostgreSQL en Render / Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Asegurar que la tabla y columnas existan
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ordenes (
        id SERIAL PRIMARY KEY,
        cliente VARCHAR(255),
        telefono VARCHAR(100),
        placa VARCHAR(50),
        vehiculo VARCHAR(255),
        marca VARCHAR(100),
        modelo VARCHAR(100),
        diagnostico_inicial TEXT,
        diagnostico TEXT,
        mecanico VARCHAR(255),
        costo NUMERIC(12, 2) DEFAULT 0,
        costo_estimado NUMERIC(12, 2) DEFAULT 0,
        estado VARCHAR(100) DEFAULT 'En Reparacion',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Agregar columna mecanico por si la tabla ya existía sin ella
    await pool.query(`
      ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS mecanico VARCHAR(255);
      ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS vehiculo VARCHAR(255);
      ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS diagnostico_inicial TEXT;
      ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS costo_estimado NUMERIC(12, 2);
    `);

    console.log('✅ Base de datos verificada y actualizada correctamente.');
  } catch (err) {
    console.error('⚠️ Aviso en base de datos (continuando ejecucion):', err.message);
  }
}

initDB();

// ==========================================
// RUTAS DE LA API (/api/ordenes)
// ==========================================

// 1. Obtener todas las órdenes
app.get('/api/ordenes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ordenes ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error en GET /api/ordenes:', err);
    res.status(500).json({ error: 'Error al consultar las órdenes en la base de datos.' });
  }
});

// 2. Registrar una nueva orden
app.post('/api/ordenes', async (req, res) => {
  const {
    cliente,
    telefono,
    placa,
    vehiculo,
    marca,
    modelo,
    diagnostico_inicial,
    diagnostico,
    mecanico,
    costo,
    costo_estimado,
    estado
  } = req.body;

  // Normalizar valores para evitar NULLs que rompan la base de datos
  const valCliente = cliente || 'Cliente';
  const valTelefono = telefono || '';
  const valPlaca = (placa || '').toUpperCase();
  const valVehiculo = vehiculo || `${marca || ''} ${modelo || ''}`.trim() || 'Vehículo';
  const valMarca = marca || valVehiculo.split(' ')[0] || '';
  const valModelo = modelo || valVehiculo.split(' ').slice(1).join(' ') || valMarca;
  const valDiag = diagnostico_inicial || diagnostico || 'Revision general';
  const valMecanico = mecanico || 'Sin Asignar';
  const valCosto = parseFloat(costo || costo_estimado || 0);
  const valEstado = estado || 'En Reparacion';

  try {
    const query = `
      INSERT INTO ordenes 
      (cliente, telefono, placa, vehiculo, marca, modelo, diagnostico_inicial, diagnostico, mecanico, costo, costo_estimado, estado)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *;
    `;

    const values = [
      valCliente,
      valTelefono,
      valPlaca,
      valVehiculo,
      valMarca,
      valModelo,
      valDiag,
      valDiag,
      valMecanico,
      valCosto,
      valCosto,
      valEstado
    ];

    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error('Error al insertar orden:', err);
    res.status(500).json({ 
      error: 'Error al guardar la orden en la base de datos.',
      detalle: err.message 
    });
  }
});

// 3. Actualizar el estado de una orden (Ej: Cambiar a "Listo" o "Entregado")
app.put('/api/ordenes/:id', async (req, res) => {
  const { id } = req.params;
  const { estado, mecanico, costo } = req.body;

  try {
    let updateFields = [];
    let queryParams = [];
    let paramIndex = 1;

    if (estado !== undefined) {
      updateFields.push(`estado = $${paramIndex++}`);
      queryParams.push(estado);
    }
    if (mecanico !== undefined) {
      updateFields.push(`mecanico = $${paramIndex++}`);
      queryParams.push(mecanico);
    }
    if (costo !== undefined) {
      updateFields.push(`costo = $${paramIndex++}`);
      queryParams.push(parseFloat(costo));
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No hay datos para actualizar.' });
    }

    queryParams.push(id);
    const query = `UPDATE ordenes SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING *;`;

    const result = await pool.query(query, queryParams);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Orden no encontrada.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error al actualizar orden:', err);
    res.status(500).json({ error: 'Error al actualizar el registro.' });
  }
});

// Ruta principal abre el panel de administración
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ruta del portal de clientes
app.get('/cliente', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cliente.html'));
});

// Redireccionar cualquier otra ruta no encontrada a la vista principal
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Arrancar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});