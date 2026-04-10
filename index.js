const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Conexión con Supabase (Las llaves las pondremos en Railway)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 1. ASIGNAR SERVIDOR (Optimizado para 1500 bots)
app.get('/get-server', async (req, res) => {
    const { data, error } = await supabase.rpc('agarrar_servidor_libre');

    if (data && data.length > 0) {
        res.json({ job_id: data[0].job_id_seleccionado });
    } else {
        res.status(404).json({ job_id: null, message: "No hay servidores libres" });
    }
});

// 2. REPORTAR HALLAZGOS
app.post('/add-server', async (req, res) => {
    const { jobId, brainrots, vps_name } = req.body;

    if (brainrots && brainrots.length > 0) {
        const insertData = brainrots.map(pet => ({
            pet_name: pet.name,
            valor_gen: pet.gen,
            mutacion: pet.mutation || "None",
            job_id: jobId,
            vps_name: vps_name || "Unknown"
        }));
        await supabase.from('hallazgos').insert(insertData);
    }

    // Marcar servidor como completado
    await supabase.from('servidores').update({ estado: 'completado' }).eq('job_id', jobId);
    res.json({ status: "ok" });
});

// 3. AGREGAR SERVIDORES EN MASA (Para el Scraper)
app.post('/add-servers-bulk', async (req, res) => {
    const { job_ids } = req.body;
    if (!job_ids) return res.status(400).send("No IDs provided");

    const insertData = job_ids.map(id => ({ job_id: id, estado: 'pendiente' }));
    await supabase.from('servidores').upsert(insertData, { onConflict: 'job_id' });
    
    res.json({ message: `${job_ids.length} servidores agregados/actualizados` });
});

// 4. ESTADO DEL SISTEMA (Para que tú veas cómo va todo)
app.get('/status', async (req, res) => {
    const { count: pendientes } = await supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente');
    const { count: completados } = await supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'completado');
    const { count: totalHallazgos } = await supabase.from('hallazgos').select('*', { count: 'exact', head: true });

    res.json({
        servidores_pendientes: pendientes,
        servidores_completados: completados,
        total_hallazgos: totalHallazgos
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API Corriendo en puerto ${PORT}`));
