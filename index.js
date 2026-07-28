const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// URL base para los links enviables por WhatsApp (Render o dominio propio)
const BASE_URL = process.env.APP_URL || 'https://taller-mecanico-backend-v00a.onrender.com';

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

// ==========================================
// HELPERS PARA UTILIDADES Y WHATSAPP
// ==========================================

// Limpia el número quitando caracteres no numéricos
function sanitizarTelefono(telefono) {
  if (!telefono) return '';
  return telefono.replace(/[^0-9]/g, '');
}

// Genera el enlace oficial de WhatsApp universal (Compatible con Android App y Web)
function construirLinkWhatsApp(telefono, mensaje) {
  const numLimpio = sanitizarTelefono(telefono);
  if (!numLimpio) return null;
  return `https://wa.me/${numLimpio}?text=${encodeURIComponent(mensaje)}`;
}

// Inicialización y actualización automática de la estructura de la BD
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ordenes (
        id SERIAL PRIMARY KEY,
        cliente VARCHAR(255) NOT NULL,
        telefono VARCHAR(100),
        placa VARCHAR(50),
        vehiculo VARCHAR(255),
        marca VARCHAR(100),
        modelo VARCHAR(100),
        diagnostico_inicial TEXT,
        diagnostico TEXT,
        mecanico VARCHAR(255) DEFAULT 'Sin Asignar',
        costo NUMERIC(12, 2) DEFAULT 0,
        costo_estimado NUMERIC(12, 2) DEFAULT 0,
        estado VARCHAR(100) DEFAULT 'En Reparacion',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS mecanico VARCHAR(255) DEFAULT 'Sin Asignar';
      ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS vehiculo VARCHAR(255);
      ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS diagnostico_inicial TEXT;
      ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS costo_estimado NUMERIC(12, 2) DEFAULT 0;
    `);

    console.log('✅ [DATABASE] Base de datos sincronizada y lista.');
  } catch (err) {
    console.error('⚠️ [DATABASE] Error en verificación:', err.message);
  }
}

initDB();

// ==========================================
// RUTAS DE LA API (/api)
// ==========================================

// 1. REPORTES EN TIEMPO REAL PARA EL DUEÑO DEL TALLER
app.get('/api/reportes', async (req, res) => {
  try {
    // Total de autos activos (excluye Entregados y Cancelados)
    const totalTallerRes = await pool.query(`
      SELECT COUNT(*) AS total_en_taller 
      FROM ordenes 
      WHERE estado NOT IN ('Entregado', 'Cancelado')
    `);

    // Detalle de autos por mecánico responsable
    const porMecanicoRes = await pool.query(`
      SELECT 
        COALESCE(mecanico, 'Sin Asignar') AS mecanico,
        COUNT(*) AS total_autos,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', id,
            'cliente', cliente,
            'vehiculo', vehiculo,
            'placa', placa,
            'estado', estado
          )
        ) AS autos_asignados
      FROM ordenes
      WHERE estado NOT IN ('Entregado', 'Cancelado')
      GROUP BY mecanico
      ORDER BY total_autos DESC
    `);

    // Conteo global por estados
    const porEstadoRes = await pool.query(`
      SELECT estado, COUNT(*) AS cantidad 
      FROM ordenes 
      GROUP BY estado
    `);

    res.json({
      total_en_taller: parseInt(totalTallerRes.rows[0].total_en_taller, 10),
      resumen_mecanicos: porMecanicoRes.rows,
      resumen_estados: porEstadoRes.rows
    });
  } catch (err) {
    console.error('Error en GET /api/reportes:', err);
    res.status(500).json({ error: 'Error al obtener reportes del taller.' });
  }
});

// 2. Obtener todas las órdenes (con links de WhatsApp incorporados)
app.get('/api/ordenes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ordenes ORDER BY id DESC');
    
    // Inyectar URLs formateadas para WhatsApp
    const ordenesFormateadas = result.rows.map(o => {
      const urlSeguimiento = `${BASE_URL}/cliente.html?orden=${o.id}`;
      const msgAlta = `Hola *${o.cliente}*, recibimos tu vehículo *${o.vehiculo || o.placa}* en el taller. 🛠️\n\nPuedes ver el estado de tu reparación en tiempo real aquí:\n${urlSeguimiento}`;
      const msgListo = `¡Hola *${o.cliente}*! 🚗🎉\nTu vehículo *${o.vehiculo || o.placa}* ya está listo para ser retirado en el taller.`;

      return {
        ...o,
        url_seguimiento: urlSeguimiento,
        wa_link_alta: construirLinkWhatsApp(o.telefono, msgAlta),
        wa_link_listo: construirLinkWhatsApp(o.telefono, msgListo)
      };
    });

    res.json(ordenesFormateadas);
  } catch (err) {
    console.error('Error en GET /api/ordenes:', err);
    res.status(500).json({ error: 'Error al consultar órdenes.' });
  }
});

// 3. Obtener orden específica por ID (para el Portal del Cliente)
app.get('/api/ordenes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM ordenes WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Orden no encontrada.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error en GET /api/ordenes/:id:', err);
    res.status(500).json({ error: 'Error al consultar la orden.' });
  }
});

// 4. Registrar una nueva orden (Genera mensaje automático de alta)
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

  const valCliente = cliente || 'Cliente General';
  const valTelefono = telefono || '';
  const valPlaca = (placa || '').toUpperCase().trim();
  const valVehiculo = vehiculo || `${marca || ''} ${modelo || ''}`.trim() || 'Vehículo';
  const valMarca = marca || valVehiculo.split(' ')[0] || '';
  const valModelo = modelo || valVehiculo.split(' ').slice(1).join(' ') || valMarca;
  const valDiag = diagnostico_inicial || diagnostico || 'Revisión General';
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
      valCliente, valTelefono, valPlaca, valVehiculo, 
      valMarca, valModelo, valDiag, valDiag, 
      valMecanico, valCosto, valCosto, valEstado
    ];

    const result = await pool.query(query, values);
    const nuevaOrden = result.rows[0];

    // Construir enlace de alta
    const urlSeguimiento = `${BASE_URL}/cliente.html?orden=${nuevaOrden.id}`;
    const msgAlta = `Hola *${valCliente}*, tu vehículo *${valVehiculo}* (${valPlaca}) ha ingresado al taller. 🛠️\n\nPuedes ver su estado en tiempo real aquí:\n${urlSeguimiento}`;
    const waLink = construirLinkWhatsApp(valTelefono, msgAlta);

    res.status(201).json({
      ...nuevaOrden,
      url_seguimiento: urlSeguimiento,
      wa_link_alta: waLink
    });

  } catch (err) {
    console.error('Error al insertar orden:', err);
    res.status(500).json({ error: 'Error al guardar la orden.', detalle: err.message });
  }
});

// 5. Actualizar estado / mecánico y generar link de "Vehículo Listo"
app.put('/api/ordenes/:id', async (req, res) => {
  const { id } = req.params;
  const { estado, mecanico, costo, diagnostico } = req.body;

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
    if (diagnostico !== undefined) {
      updateFields.push(`diagnostico = $${paramIndex++}`);
      queryParams.push(diagnostico);
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

    const ordenActualizada = result.rows[0];

    // Generar enlace de notificación "Vehículo Listo"
    const msgListo = `¡Buenas noticias *${ordenActualizada.cliente}*! 🚗🎉\n\nTu vehículo *${ordenActualizada.vehiculo}* (${ordenActualizada.placa}) ya está reparado y *LISTO PARA RETIRAR*.\n\n¡Te esperamos en el taller!`;
    const waLinkListo = construirLinkWhatsApp(ordenActualizada.telefono, msgListo);

    res.json({
      ...ordenActualizada,
      wa_link_listo: waLinkListo
    });
  } catch (err) {
    console.error('Error al actualizar orden:', err);
    res.status(500).json({ error: 'Error al actualizar el registro.' });
  }
});

// Rutas de las vistas HTML
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/cliente', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cliente.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});