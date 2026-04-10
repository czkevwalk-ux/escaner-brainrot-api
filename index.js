const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 🛠️ FUNCIÓN PARA CONVERTIR VALOR (Ej: "35M/s" -> 35) ---
function parseGenValue(text) {
    if (!text) return 0;
    const clean = text.toUpperCase().replace(/\s/g, '');
    const num = parseFloat(clean.match(/\d+\.?\d*/) || 0);
    if (clean.includes('B')) return num * 1000; 
    if (clean.includes('K')) return num / 1000; 
    return num; 
}

// --- 🎯 ENRUTADOR: 3 VPS POR CANAL ---
function getWebhookByVPS(vpsName) {
    const num = parseInt(vpsName.replace(/\D/g, '') || 0);
    if (num >= 1 && num <= 3) return process.env.WEBHOOK_1;
    if (num >= 4 && num <= 6) return process.env.WEBHOOK_2;
    if (num >= 7 && num <= 9) return process.env.WEBHOOK_3;
    if (num >= 10 && num <= 12) return process.env.WEBHOOK_4;
    if (num >= 13 && num <= 15) return process.env.WEBHOOK_5;
    if (num >= 16) return process.env.WEBHOOK_6;
    return process.env.WEBHOOK_1; 
}

app.post('/add-server', async (req, res) => {
    const { jobId, brainrots, vps_name } = req.body;

    // 1. Guardar TODO en Supabase (Historial privado)
    const insertData = brainrots.map(p => ({
        pet_name: p.name, valor_gen: p.gen, mutacion: p.mutation || "None", job_id: jobId, vps_name: vps_name
    }));
    await supabase.from('hallazgos').insert(insertData);

    // 2. Filtrar animales de 30M o más
    const highValuePets = brainrots.filter(p => parseGenValue(p.gen) >= 30);

    // 3. Enviar a Discord a través de tus Workers
    if (highValuePets.length > 0) {
        const targetWorker = getWebhookByVPS(vps_name);
        if (targetWorker) {
            let description = "";
            highValuePets.forEach(p => {
                description += `💎 **${p.name}** | 📈 ${p.gen} | ✨ ${p.mutation || "None"}\n`;
            });

            const payload = {
                embeds: [{
                    title: `🔎 HALLAZGO DETECTADO (${vps_name})`,
                    description: description + `\n🎮 **JobId:** \`${jobId}\``,
                    color: 5793266,
                    timestamp: new Date()
                }]
            };
            axios.post(targetWorker, payload).catch(e => console.log("Error Worker:", e.message));
        }
    }

    await supabase.from('servidores').update({ estado: 'completado' }).eq('job_id', jobId);
    res.json({ status: "ok" });
});

app.get('/get-server', async (req, res) => {
    const { data } = await supabase.rpc('agarrar_servidor_libre');
    if (data && data.length > 0) res.json({ job_id: data[0].job_id_seleccionado });
    else res.status(404).json({ job_id: null });
});

app.post('/add-servers-bulk', async (req, res) => {
    const { job_ids } = req.body;
    const insertData = job_ids.map(id => ({ job_id: id, estado: 'pendiente' }));
    await supabase.from('servidores').upsert(insertData, { onConflict: 'job_id' });
    res.json({ status: "ok" });
});

app.get('/status', async (req, res) => {
    const { count: pendientes } = await supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente');
    res.json({ servidores_pendientes: pendientes });
});

app.listen(process.env.PORT || 8080);
