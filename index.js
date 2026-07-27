 require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 1. REGISTRO RECEPCIÓN Y ORDEN COMPLETA
app.post('/api/recepcion-completa', async (req, res) => {
  const { nombre, telefono, placa, marca, modelo, mecanico, diagnostico, costo, aprobado } = req.body;

  if (!aprobado) {
    return res.status(400).json({ error: 'El cliente no aprobó el presupuesto. Orden cancelada.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Registrar o recuperar cliente
    let clienteRes = await client.query('SELECT id FROM clientes WHERE telefono = $1', [telefono]);
    let clienteId;
    if (clienteRes.rows.length === 0) {
      const nuevoCliente = await client.query(
        'INSERT INTO clientes (nombre, telefono) VALUES ($1, $2) RETURNING id',
        [nombre, telefono]
      );
      clienteId = nuevoCliente.rows[0].id;
    } else {
      clienteId = clienteRes.rows[0].id;
    }

    // Registrar o recuperar vehículo
    let vehiculoRes = await client.query('SELECT id FROM vehiculos WHERE placa = $1', [placa]);
    let vehiculoId;
    if (vehiculoRes.rows.length === 0) {
      const nuevoVehiculo = await client.query(
        'INSERT INTO vehiculos (cliente_id, marca, modelo, placa) VALUES ($1, $2, $3, $4) RETURNING id',
        [clienteId, marca, modelo, placa]
      );
      vehiculoId = nuevoVehiculo.rows[0].id;
    } else {
      vehiculoId = vehiculoRes.rows[0].id;
    }

    // Crear orden de trabajo activa
    const nuevaOrden = await client.query(
      `INSERT INTO ordenes_trabajo (vehiculo_id, diagnostico_inicial, mecanico_asignado, costo, estado) 
       VALUES ($1, $2, $3, $4, 'En Reparacion') RETURNING id`,
      [vehiculoId, diagnostico, mecanico, costo]
    );

    await client.query('COMMIT');
    res.json({ mensaje: 'Vehículo e ingreso procesado exitosamente', orden_id: nuevaOrden.rows[0].id });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al procesar ingreso:', error);
    res.status(500).json({ error: 'Error interno del servidor al registrar' });
  } finally {
    client.release();
  }
});

// 2. OBTENER ORDENES ACTIVAS
app.get('/api/ordenes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         o.id,
         o.estado,
         o.diagnostico_inicial,
         o.costo,
         v.marca,
         v.modelo,
         v.placa,
         c.nombre as cliente,
         c.telefono
       FROM ordenes_trabajo o
       JOIN vehiculos v ON o.vehiculo_id = v.id
       JOIN clientes c ON v.cliente_id = c.id
       ORDER BY o.id DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. CAMBIAR ESTADO A LISTO
app.put('/api/ordenes/:id/listo', async (req, res) => {
  try {
    await pool.query("UPDATE ordenes_trabajo SET estado = 'Listo' WHERE id = $1", [req.params.id]);
    res.json({ mensaje: 'Orden actualizada a LISTO.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. ENTREGAR Y COBRAR (SISTEMA DE BAJA DEL TALLER)
app.put('/api/ordenes/:id/entregar', async (req, res) => {
  try {
    await pool.query("UPDATE ordenes_trabajo SET estado = 'Entregado' WHERE id = $1", [req.params.id]);
    res.json({ mensaje: 'Orden entregada y cobrada con éxito.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. REPORTES DEL DUEÑO POR RANGO DE FECHAS
app.get('/api/reportes/personalizado', async (req, res) => {
  const { desde, hasta } = req.query;

  try {
    const fechaInicio = desde ? `${desde} 00:00:00` : 'NOW()::date';
    const fechaFin = hasta ? `${hasta} 23:59:59` : 'NOW()::date + interval \'1 day\'';

    const balanceQuery = await pool.query(
      `SELECT 
         COUNT(*) as entregados,
         COALESCE(SUM(costo), 0) as ingresos_totales
       FROM ordenes_trabajo 
       WHERE estado = 'Entregado' 
         AND created_at >= $1 AND created_at <= $2`,
      [fechaInicio, fechaFin]
    );

    const activosQuery = await pool.query(
      `SELECT COUNT(*) as en_proceso FROM ordenes_trabajo WHERE estado != 'Entregado'`
    );

    const detalleQuery = await pool.query(
      `SELECT 
         o.id,
         o.created_at,
         v.marca,
         v.modelo,
         v.placa,
         c.nombre as cliente,
         o.diagnostico_inicial,
         o.costo
       FROM ordenes_trabajo o
       JOIN vehiculos v ON o.vehiculo_id = v.id
       JOIN clientes c ON v.cliente_id = c.id
       WHERE o.estado = 'Entregado' 
         AND o.created_at >= $1 AND o.created_at <= $2
       ORDER BY o.created_at DESC`,
      [fechaInicio, fechaFin]
    );

    res.json({
      entregados: balanceQuery.rows[0].entregados,
      ingresos_totales: balanceQuery.rows[0].ingresos_totales,
      en_proceso: activosQuery.rows[0].en_proceso,
      servicios: detalleQuery.rows
    });
  } catch (error) {
    console.error('Error al generar reporte:', error);
    res.status(500).json({ error: 'Error al consultar reporte' });
  }
});

// 6. CONSULTA PARA PORTAL CLIENTE
app.get('/api/consulta-cliente/:placa', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         o.id,
         o.estado,
         o.diagnostico_inicial,
         o.costo,
         v.marca,
         v.modelo,
         v.placa,
         c.nombre as cliente
       FROM ordenes_trabajo o
       JOIN vehiculos v ON o.vehiculo_id = v.id
       JOIN clientes c ON v.cliente_id = c.id
       WHERE UPPER(v.placa) = UPPER($1) AND o.estado != 'Entregado'
       ORDER BY o.id DESC LIMIT 1`,
      [req.params.placa]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No se encontró un vehículo activo con esa placa.' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});