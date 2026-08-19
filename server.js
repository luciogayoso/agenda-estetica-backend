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
// 1. RUTAS DE SERVICIOS
// =========================================================================

// GET: Obtener todos los servicios desde Supabase
app.get('/api/services', async (req, res) => {
  try {
    const { data: services, error } = await supabase
      .from('services')
      .select('*, service_professionals(professional_id, professionals(id, name))')
      .order('id', { ascending: true })

    if (error) {
      console.error('❌ Error de Supabase al consultar servicios:', error)
      throw error
    }

    const formattedServices = services.map(s => ({
      ...s,
      professionals: s.service_professionals ? s.service_professionals.map(sp => sp.professionals) : []
    }))

    return res.json(formattedServices)
  } catch (error) {
    console.error('Error interno al obtener servicios:', error)
    return res.status(500).json({ error: 'Error al obtener los servicios' })
  }
})

// POST: Crear un nuevo servicio
app.post('/api/services', async (req, res) => {
  try {
    const { name, description, price, deposit_amount, deposit, duration_minutes, duration, icon, professionalIds } = req.body

    const finalPrice = Number(price) || 0
    const finalDeposit = Number(deposit_amount || deposit) || 0
    const finalDuration = Number(duration_minutes || duration) || 60

    if (!name || !finalPrice) {
      return res.status(400).json({ status: 'error', message: 'Nombre y precio son obligatorios' })
    }

    const { data: newService, error } = await supabase
      .from('services')
      .insert([
        {
          name,
          description: description || '',
          price: finalPrice,
          deposit_amount: finalDeposit,
          duration_minutes: finalDuration,
          icon: icon || '✨'
        }
      ])
      .select()
      .single()

    if (error) throw error

    if (professionalIds && professionalIds.length > 0) {
      const relations = professionalIds.map(profId => ({
        service_id: newService.id,
        professional_id: Number(profId)
      }))
      await supabase.from('service_professionals').insert(relations)
    }

    return res.status(201).json({ status: 'success', data: newService })
  } catch (error) {
    console.error('❌ Error al crear servicio:', error)
    return res.status(500).json({ status: 'error', message: 'No se pudo crear el servicio' })
  }
})

// PUT: Actualizar un servicio existente
app.put('/api/services/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, price, deposit_amount, deposit, duration_minutes, duration, icon, professionalIds } = req.body

    const { data, error } = await supabase
      .from('services')
      .update({
        name,
        description,
        price: Number(price),
        deposit_amount: Number(deposit_amount || deposit),
        duration_minutes: Number(duration_minutes || duration),
        icon
      })
      .eq('id', Number(id))
      .select()

    if (error) throw error

    await supabase.from('service_professionals').delete().eq('service_id', Number(id))

    if (professionalIds && professionalIds.length > 0) {
      const relations = professionalIds.map(profId => ({
        service_id: Number(id),
        professional_id: Number(profId)
      }))
      await supabase.from('service_professionals').insert(relations)
    }

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

// GET: Obtener lista de profesionales
app.get('/api/professionals', async (req, res) => {
  try {
    const { data: professionals, error } = await supabase
      .from('professionals')
      .select('*')
      .order('name', { ascending: true })

    if (error) throw error
    return res.json({ status: 'success', professionals: professionals || [] })
  } catch (error) {
    console.error('❌ Error obteniendo profesionales:', error)
    return res.status(500).json({ status: 'error', message: 'Error al obtener profesionales' })
  }
})

// =========================================================================
// 2. RUTAS DE RESERVAS Y TURNOS (ADAPTADAS CON EMAIL)
// =========================================================================

// POST: Crear reserva guardando el client_email
app.post('/api/appointments/reserve', async (req, res) => {
  try {
    const { client_name, client_phone, client_email, service_id, appointment_date } = req.body

    // Buscar el servicio en Supabase
    const { data: service, error: serviceError } = await supabase
      .from('services')
      .select('*')
      .eq('id', Number(service_id))
      .single()

    if (serviceError || !service) {
      return res.status(404).json({ status: 'error', message: 'Servicio no encontrado en la base de datos' })
    }

    // Registrar la pre-reserva incluyendo client_email
    const { data: newAppointment, error: dbError } = await supabase
      .from('appointments')
      .insert([
        {
          client_name,
          client_phone,
          client_email: client_email || '', // Se guarda el email de Google
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

    console.log(`📌 Pre-reserva creada exitosamente con ID #${newAppointment.id} para el email ${client_email}`)

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
              unit_price: Number(service.deposit_amount || service.deposit || 0),
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

// GET: Buscar las reservas de un cliente filtrando únicamente por su client_email
app.get('/api/appointments/client/:email', async (req, res) => {
  try {
    const { email } = req.params;

    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('client_email', email)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ status: 'success', data });
  } catch (error) {
    console.error('❌ Error al consultar turnos por email:', error);
    return res.status(500).json({ status: 'error', message: 'Error al obtener tus turnos' });
  }
});

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

// POST: Confirmación manual por ID
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

// POST: Verificar y confirmar retorno desde Mercado Pago
app.post('/api/appointments/verify-and-confirm', async (req, res) => {
  try {
    const { appointment_id, payment_id } = req.body;
    const id = Number(appointment_id);

    if (!id || isNaN(id)) {
      return res.status(400).json({ status: 'error', message: 'ID de reserva inválido' });
    }

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
      isApproved = true;
    }

    if (isApproved) {
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

// =========================================================================
// 3. WEBHOOK DE MERCADO PAGO
// =========================================================================

app.post('/api/webhooks/mercadopago', async (req, res) => {
  res.status(200).send('OK')

  try {
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
          } else {
            console.log(`✅ Turno ID #${appointmentId} confirmado exitosamente.`)
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Error procesando Webhook de Mercado Pago:', error)
  }
})

// =========================================================================
// 4. RUTAS DE BLOQUEO DE DÍAS Y HORARIOS
// =========================================================================

app.get('/api/schedules/blocks', async (req, res) => {
  try {
    const { data: dates } = await supabase.from('blocked_dates').select('*').order('date', { ascending: true });
    const { data: slots } = await supabase.from('blocked_slots').select('*').order('id', { ascending: true });

    return res.json({ status: 'success', blockedDates: dates || [], blockedSlots: slots || [] });
  } catch (error) {
    console.error('❌ Error obteniendo bloqueos:', error);
    return res.status(500).json({ status: 'error', message: 'Error interno del servidor' });
  }
});

app.post('/api/schedules/blocked-dates', async (req, res) => {
  try {
    const { date, reason } = req.body;
    const { data, error } = await supabase
      .from('blocked_dates')
      .insert([{ date, reason: reason || 'Día Bloqueado' }])
      .select();

    if (error) throw error;
    return res.status(201).json({ status: 'success', data: data[0] });
  } catch (error) {
    console.error('❌ Error al guardar fecha bloqueada:', error);
    return res.status(500).json({ status: 'error', message: 'Error al bloquear el día' });
  }
});

app.delete('/api/schedules/blocked-dates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('blocked_dates').delete().eq('id', Number(id));
    if (error) throw error;
    return res.json({ status: 'success' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: 'Error al eliminar el bloqueo' });
  }
});

app.post('/api/schedules/blocked-slots', async (req, res) => {
  try {
    const { day, startTime, endTime, reason } = req.body;
    const { data, error } = await supabase
      .from('blocked_slots')
      .insert([{ day, start_time: startTime, end_time: endTime, reason: reason || 'Pausa' }])
      .select();

    if (error) throw error;
    return res.status(201).json({ status: 'success', data: data[0] });
  } catch (error) {
    console.error('❌ Error al guardar franja bloqueada:', error);
    return res.status(500).json({ status: 'error', message: 'Error al bloquear la franja' });
  }
});

app.delete('/api/schedules/blocked-slots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('blocked_slots').delete().eq('id', Number(id));
    if (error) throw error;
    return res.json({ status: 'success' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: 'Error al eliminar la franja' });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor backend escuchando en puerto ${PORT}`)
})