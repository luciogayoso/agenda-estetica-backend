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

const SERVICES = [
  { id: 1, name: 'Perfilado de Cejas & Henna', deposit_amount: 3000 },
  { id: 2, name: 'Lifting de Pestañas + Nutrición', deposit_amount: 4000 },
  { id: 3, name: 'Limpieza Facial Profunda Glow', deposit_amount: 5000 },
  { id: 4, name: 'Soft Gel Nails Art', deposit_amount: 4000 }
]

// 1. Ruta para reservar e iniciar pago
app.post('/api/appointments/reserve', async (req, res) => {
  try {
    const { client_name, client_phone, service_id, appointment_date } = req.body

    const service = SERVICES.find(s => s.id === Number(service_id))
    if (!service) {
      return res
        .status(404)
        .json({ status: 'error', message: 'Servicio no encontrado' })
    }

    // Guardar reserva inicial en Supabase
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

    if (dbError) {
      console.error('Error al guardar en Supabase:', dbError)
      return res
        .status(500)
        .json({ status: 'error', message: 'Error al guardar la reserva' })
    }

    let paymentUrl = ''

    if (mpAccessToken) {
      try {
        const preference = new Preference(client)

        const clientUrl =
          process.env.CLIENT_URL ||
          'https://agenda-estetica-fronend-xunf.vercel.app'

        // Objeto de la preferencia de pago
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
            failure: `${clientUrl}/reserva-exito`,
            pending: `${clientUrl}/reserva-exito`
          },
          auto_return: 'approved',
          notification_url: 'https://agenda-estetica-backend.onrender.com/api/webhooks/mercadopago'
        }

        // Si existe BACKEND_URL en el entorno y no es localhost, sobrescribe notification_url
        if (
          process.env.BACKEND_URL &&
          !process.env.BACKEND_URL.includes('localhost')
        ) {
          preferenceBody.notification_url = `${process.env.BACKEND_URL}/api/webhooks/mercadopago`
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
    res
      .status(500)
      .json({ status: 'error', message: 'Error interno del servidor' })
  }
})

// Obtener la lista de servicios dinámicos
app.get('/api/services', async (req, res) => {
  try {
    const { data: services, error } = await supabase
      .from('services')
      .select('id, name, duration_minutes, price, deposit_amount, description, icon')
      .order('id', { ascending: true })

    if (error) {
      console.error('Error de Supabase al consultar servicios:', error)
      throw error
    }

    return res.json(services)
  } catch (error) {
    console.error('Error interno al obtener servicios:', error)
    return res.status(500).json({ error: 'Error al obtener los servicios' })
  }
})

// 2. Webhook de Mercado Pago para confirmación automática
app.post('/api/webhooks/mercadopago', async (req, res) => {
  try {
    const type = req.body?.type || req.query?.type || req.query?.topic
    const paymentId = req.body?.data?.id || req.query?.id || req.query?.['data.id']

    if (
      (type === 'payment' || type === 'payment.created') &&
      paymentId &&
      mpAccessToken
    ) {
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

    res.sendStatus(200)
  } catch (error) {
    console.error('❌ Error procesando Webhook de Mercado Pago:', error)
    res.sendStatus(500)
  }
})

// 3. Confirmación manual por ID (desde el frontend de éxito como respaldo)
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
    console.error('Error al confirmar reserva manualmente:', error)
    return res.status(500).json({ status: 'error', message: 'Error interno del servidor' })
  }
})

// 4. Obtener todos los turnos para el Admin Dashboard
app.get('/api/appointments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({ status: 'success', data })
  } catch (error) {
    console.error('Error al consultar Supabase:', error)
    res
      .status(500)
      .json({ status: 'error', message: 'Error al obtener las reservas' })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 Servidor backend escuchando en http://localhost:${PORT}`)
})