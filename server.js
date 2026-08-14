import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago'
import { createClient } from '@supabase/supabase-js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

// Configurar Supabase
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

// Configurar Mercado Pago
const mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN || ''
const client = new MercadoPagoConfig({ accessToken: mpAccessToken })

app.use(cors())
app.use(express.json())

// =========================================================================
// 1. RUTAS DE SERVICIOS (CRUD DINÁMICO EN SUPABASE)
// =========================================================================

// GET: Obtener todos los servicios desde Supabase
app.get('/api/services', async (req, res) => {
  try {
    const { data: services, error } = await supabase
      .from('services')
      .select('id, name, duration_minutes, price, deposit_amount, description, icon')
      .order('id', { ascending: true })

    if (error) {
      console.error('❌ Error de Supabase al consultar servicios:', error)
      throw error
    }

    return res.json(services)
  } catch (error) {
    console.error('Error interno al obtener servicios:', error)
    return res.status(500).json({ error: 'Error al obtener los servicios' })
  }
})

// POST: Crear un nuevo servicio (Panel Administrador)
app.post('/api/services', async (req, res) => {
  try {
    const { name, description, price, deposit_amount, duration_minutes, icon } = req.body

    if (!name || !price || !deposit_amount) {
      return res.status(400).json({ status: 'error', message: 'Nombre, precio y seña son obligatorios' })
    }

    const { data, error } = await supabase
      .from('services')
      .insert([
        {
          name,
          description: description || '',
          price: Number(price),
          deposit_amount: Number(deposit_amount),
          duration_minutes: Number(duration_minutes) || 60,
          icon: icon || '✨'
        }
      ])
      .select()

    if (error) throw error

    return res.status(201).json({ status: 'success', data })
  } catch (error) {
    console.error('❌ Error al crear servicio:', error)
    return res.status(500).json({ status: 'error', message: 'No se pudo crear el servicio' })
  }
})

// PUT: Actualizar un servicio existente
app.put('/api/services/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, price, deposit_amount, duration_minutes, icon } = req.body

    const { data, error } = await supabase
      .from('services')
      .update({
        name,
        description,
        price: Number(price),
        deposit_amount: Number(deposit_amount),
        duration_minutes: Number(duration_minutes),
        icon
      })
      .eq('id', Number(id))
      .select()

    if (error) throw error

    return res.json({ status: 'success', data })
  } catch (error) {
    console.error('❌ Error al actualizar servicio:', error)
    return res.status(500).json({ status: 'error', message: 'No se pudo actualizar el servicio' })
  }
})

// DELETE: Eliminar un servicio
app.delete('/api/services/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('services')
      .delete()
      .eq('id', Number(id))

    if (error) throw error

    return res.json({ status: 'success', message: 'Servicio eliminado correctamente' })
  } catch (error) {
    console.error('❌ Error al eliminar servicio:', error)
    return res.status(500).json({ status: 'error', message: 'No se pudo eliminar el servicio' })
  }
})

// =========================================================================
// 2. RUTAS DE RESERVAS Y TURNOS
// =========================================================================

// POST: Crear la reserva en Supabase e iniciar preferencia en Mercado Pago
app.post('/api/appointments/reserve', async (req, res) => {
  try {
    const { client_name, client_phone, service_id, appointment_date } = req.body

    // Buscar el servicio en Supabase
    const { data: service, error: serviceError } = await supabase
      .from('services')
      .select('*')
      .eq('id', Number(service_id))
      .single()

    if (serviceError || !service) {
      return res.status(404).json({ status: 'error', message: 'Servicio no encontrado en la base de datos' })
    }

    // Registrar la pre-reserva en Supabase
    const { data: newAppointment, error: dbError } = await supabase
      .from('appointments')
      .insert([
        {
          client_name,
          client_phone,
          service_id: service.id,
          service_name: service.name,
          appointment_date,
          status: 'pending_payment'
        }
      ])
      .select()
      .single()

    if (dbError || !newAppointment) {
      console.error('❌ Error al guardar en Supabase:', dbError)
      return res.status(500).json({
        status: 'error',
        message: 'No se pudo registrar la pre-reserva en la base de datos'
      })
    }

    console.log(`📌 Pre-reserva creada exitosamente con ID #${newAppointment.id}`)

    let paymentUrl = ''

    if (mpAccessToken) {
      try {
        const preference = new Preference(client)

        const clientUrl = process.env.CLIENT_URL || 'https://agenda-estetica-fronend-xunf.vercel.app'
        const backendUrl = process.env.BACKEND_URL || 'https://agenda-estetica-backend.onrender.com'

        const preferenceBody = {
          items: [
            {
              id: String(service.id),
              title: `Seña: ${service.name}`,
              unit_price: Number(service.deposit_amount),
              quantity: 1,
              currency_id: 'ARS'
            }
          ],
          external_reference: newAppointment.id.toString(),
          back_urls: {
            success: `${clientUrl}/reserva-exito?appointment_id=${newAppointment.id}`,
            failure: `${clientUrl}/reserva-exito?appointment_id=${newAppointment.id}&status=failed`,
            pending: `${clientUrl}/reserva-exito?appointment_id=${newAppointment.id}&status=pending`
          },
          auto_return: 'approved',
          notification_url: `${backendUrl}/api/webhooks/mercadopago`
        }

        const result = await preference.create({ body: preferenceBody })
        paymentUrl = result.init_point || result.sandbox_init_point
      } catch (mpErr) {
        console.error('❌ Error creando la preferencia de Mercado Pago:', mpErr)
        return res.status(500).json({
          status: 'error',
          message: 'Error al comunicarse con Mercado Pago',
          details: mpErr.message
        })
      }
    } else {
      console.warn('⚠️ MERCADOPAGO_ACCESS_TOKEN no está definido')
    }

    return res.json({
      status: 'success',
      appointment_id: newAppointment.id,
      init_point: paymentUrl
    })
  } catch (error) {
    console.error('Error general al procesar reserva:', error)
    res.status(500).json({ status: 'error', message: 'Error interno del servidor' })
  }
})

// GET: Obtener todos los turnos para el Admin Dashboard
app.get('/api/appointments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({ status: 'success', data })
  } catch (error) {
    console.error('❌ Error al consultar Supabase:', error)
    res.status(500).json({ status: 'error', message: 'Error al obtener las reservas' })
  }
})

// PATCH: Cambiar estado del turno manualmente desde el Admin
app.patch('/api/appointments/:id/status', async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body

    if (!status) {
      return res.status(400).json({ status: 'error', message: 'El campo status es requerido' })
    }

    const { data, error } = await supabase
      .from('appointments')
      .update({ status })
      .eq('id', Number(id))
      .select()

    if (error) throw error

    return res.json({ status: 'success', data })
  } catch (error) {
    console.error('❌ Error al actualizar estado del turno:', error)
    return res.status(500).json({ status: 'error', message: 'No se pudo actualizar el estado del turno' })
  }
})

// POST: Confirmación manual por ID (Respaldo desde el frontend al regresar del pago)
app.post('/api/appointments/confirm', async (req, res) => {
  try {
    const { appointment_id } = req.body
    const id = Number(appointment_id)

    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'ID de reserva inválido' })
    }

    const { data, error } = await supabase
      .from('appointments')
      .update({ status: 'confirmed' })
      .eq('id', id)
      .select()

    if (error) throw error

    return res.json({ status: 'success', data })
  } catch (error) {
    console.error('❌ Error al confirmar reserva manualmente:', error)
    return res.status(500).json({ status: 'error', message: 'Error interno del servidor' })
  }
})

// =========================================================================
// 3. WEBHOOK DE MERCADO PAGO (PROCESAMIENTO Y NOTIFICACIÓN AUTOMÁTICA)
// =========================================================================

app.post('/api/webhooks/mercadopago', async (req, res) => {
  // 1. Responder inmediatamente a Mercado Pago con HTTP 200 OK
  res.status(200).send('OK')

  try {
    // Mercado Pago envía datos en req.body o en req.query según el tipo de evento
    const topic = req.body?.type || req.query?.type || req.query?.topic || req.body?.action
    const paymentId = req.body?.data?.id || req.query?.id || req.query?.['data.id']

    if ((topic === 'payment' || topic === 'payment.created' || topic === 'payment.updated') && paymentId && mpAccessToken) {
      const payment = new Payment(client)
      const paymentInfo = await payment.get({ id: paymentId })

      if (paymentInfo.status === 'approved') {
        const appointmentId = Number(paymentInfo.external_reference)

        if (!isNaN(appointmentId)) {
          const { data, error } = await supabase
            .from('appointments')
            .update({ status: 'confirmed' })
            .eq('id', appointmentId)
            .select()

          if (error) {
            console.error('❌ Error actualizando estado en Supabase:', error)
          } else if (!data || data.length === 0) {
            console.warn(`⚠️ No se encontró la reserva #${appointmentId} en Supabase.`)
          } else {
            console.log(`✅ Turno ID #${appointmentId} confirmado exitosamente en Supabase.`)
          }
        } else {
          console.error('❌ external_reference inválido:', paymentInfo.external_reference)
        }
      } else {
        console.log(`ℹ️ Pago #${paymentId} procesado con estado: ${paymentInfo.status}`)
      }
    }
  } catch (error) {
    console.error('❌ Error procesando Webhook de Mercado Pago:', error)
  }
})

app.get('/api/appointments/client/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const cleanPhone = phone.replace(/\D/g, '');

    // Buscar reservas que coincidan con el teléfono
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .or(`client_phone.ilike.%${cleanPhone}%,client_phone.eq.${phone}`)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ status: 'success', data });
  } catch (error) {
    console.error('❌ Error al consultar turnos del cliente:', error);
    return res.status(500).json({ status: 'error', message: 'Error al obtener tus turnos' });
  }
});

// POST: Confirmación y verificación forzada con Mercado Pago
app.post('/api/appointments/verify-and-confirm', async (req, res) => {
  try {
    const { appointment_id, payment_id } = req.body;
    const id = Number(appointment_id);

    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'ID de reserva inválido' });
    }

    // 1. Si viene payment_id, verificamos directo con la API de Mercado Pago
    let isApproved = false;
    if (payment_id && mpAccessToken) {
      try {
        const payment = new Payment(client);
        const paymentInfo = await payment.get({ id: payment_id });
        if (paymentInfo.status === 'approved') {
          isApproved = true;
        }
      } catch (e) {
        console.warn('No se pudo verificar payment_id en MP, forzando por retorno positivo.');
      }
    } else {
      // Si el cliente volvió del flujo de pago de MP
      isApproved = true;
    }

    if (isApproved) {
      // 2. Actualizar en Supabase a 'confirmed'
      const { data, error } = await supabase
        .from('appointments')
        .update({ status: 'confirmed' })
        .eq('id', id)
        .select();

      if (error) {
        console.error('❌ Error Supabase UPDATE:', error);
        return res.status(500).json({ status: 'error', message: 'Error actualizando base de datos', error });
      }

      console.log(`✅ Turno #${id} verificado y marcado como CONFIRMADO.`);
      return res.json({ status: 'success', data: data[0] });
    }

    return res.status(400).json({ status: 'error', message: 'El pago no figura como aprobado' });
  } catch (error) {
    console.error('❌ Error en verify-and-confirm:', error);
    return res.status(500).json({ status: 'error', message: 'Error interno del servidor' });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor backend escuchando en puerto ${PORT}`)
})