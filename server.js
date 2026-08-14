import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configurar Mercado Pago
const mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
const client = new MercadoPagoConfig({ accessToken: mpAccessToken });

app.use(cors());
app.use(express.json());

const SERVICES = [
  { id: 1, name: 'Perfilado de Cejas & Henna', deposit_amount: 3000 },
  { id: 2, name: 'Lifting de Pestañas + Nutrición', deposit_amount: 4000 },
  { id: 3, name: 'Limpieza Facial Profunda Glow', deposit_amount: 5000 },
  { id: 4, name: 'Soft Gel Nails Art', deposit_amount: 4000 }
];

// 1. Ruta para reservar e iniciar pago
app.post('/api/appointments/reserve', async (req, res) => {
  try {
    const { client_name, client_phone, service_id, appointment_date } = req.body;

    const service = SERVICES.find(s => s.id === Number(service_id));
    if (!service) {
      return res.status(404).json({ status: 'error', message: 'Servicio no encontrado' });
    }

    // Guardar reserva inicial en Supabase
    const { data: appointment, error: dbError } = await supabase
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
      .single();

    if (dbError) {
      console.error('Error al guardar en Supabase:', dbError);
      return res.status(500).json({ status: 'error', message: 'Error al guardar la reserva' });
    }

    let paymentUrl = '';

    if (mpAccessToken) {
      try {
        const preference = new Preference(client);

        const clientFrontendUrl = process.env.CLIENT_URL || 'http://localhost:5173';

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
          external_reference: String(appointment.id),
          back_urls: {
            success: `${clientUrl}/reserva-exito`,
            failure: `${clientUrl}/reserva-exito`,
            pending: `${clientUrl}/reserva-exito`,
          },
          auto_return: 'approved',
        };

        // Mercado Pago no acepta 'localhost' en notification_url
        if (process.env.BACKEND_URL && !process.env.BACKEND_URL.includes('localhost')) {
          preferenceBody.notification_url = `${process.env.BACKEND_URL}/api/webhooks/mercadopago`;
        }

        const result = await preference.create({ body: preferenceBody });

        // URL para redirigir al checkout
        paymentUrl = result.init_point || result.sandbox_init_point;

      } catch (mpErr) {
        console.error('❌ Error creando la preferencia de Mercado Pago:', mpErr);
        return res.status(500).json({ 
          status: 'error', 
          message: 'Error al comunicarse con Mercado Pago',
          details: mpErr.message 
        });
      }
    } else {
      console.warn('⚠️ MERCADOPAGO_ACCESS_TOKEN no está definido en el archivo .env');
    }

    return res.json({
      status: 'success',
      appointment_id: appointment.id,
      init_point: paymentUrl
    });

  } catch (error) {
    console.error('Error general al procesar reserva:', error);
    res.status(500).json({ status: 'error', message: 'Error interno del servidor' });
  }
});

// 2. Webhook de Mercado Pago para confirmación automática
app.post('/api/webhooks/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment' && data?.id && mpAccessToken) {
      const payment = new Payment(client);
      const paymentInfo = await payment.get({ id: data.id });

      if (paymentInfo.status === 'approved') {
        const appointmentId = paymentInfo.external_reference;

        if (appointmentId) {
          const { error } = await supabase
            .from('appointments')
            .update({ status: 'confirmed' })
            .eq('id', appointmentId);

          if (error) {
            console.error('Error actualizando estado en Supabase:', error);
          } else {
            console.log(`✅ Turno ID #${appointmentId} confirmado exitosamente por Mercado Pago.`);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error procesando Webhook:', error);
    res.sendStatus(500);
  }
});

// 3. Confirmación manual desde la pantalla de éxito
app.post('/api/appointments/confirm-manual', async (req, res) => {
  try {
    const { appointment_id } = req.body;

    if (!appointment_id) {
      return res.status(400).json({ status: 'error', message: 'Falta el ID del turno' });
    }

    const { error } = await supabase
      .from('appointments')
      .update({ status: 'confirmed' })
      .eq('id', appointment_id);

    if (error) throw error;

    console.log(`✅ Turno #${appointment_id} actualizado a 'confirmed' exitosamente.`);
    return res.json({ status: 'success' });
  } catch (err) {
    console.error('Error al confirmar reserva:', err);
    return res.status(500).json({ status: 'error' });
  }
});

// 4. Obtener todos los turnos
app.get('/api/appointments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ status: 'success', data });
  } catch (error) {
    console.error('Error al consultar Supabase:', error);
    res.status(500).json({ status: 'error', message: 'Error al obtener las reservas' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor backend escuchando en http://localhost:${PORT}`);
});