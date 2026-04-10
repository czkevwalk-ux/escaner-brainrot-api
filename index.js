const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 🛠️ UTILIDADES ---
function parseGenValue(text) {
    if (!text) return 0;
    const clean = text.toUpperCase().replace(/\s/g, '');
    const num = parseFloat(clean.match(/\d+\.?\d*/) || 0);
    if (clean.includes('B')) return num * 1000;
    return num;
}

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

// --- 🎯 ASIGNAR SERVIDOR (NUEVA LÓGICA MÁS FUERTE) ---
app.get('/get-server', async (req, res) => {
    // 1. Buscamos un servidor pendiente
    const { data: server, error } = await supabase
        .from('servidores')
        .select('job_id')
        .eq('estado', 'pendiente')
        .limit(1)
        .maybeSingle();

    if (server) {
        // 2. Lo marcamos como 'completado' de una vez para que nadie más lo use
        await supabase
            .from('servidores')
            .update({ estado: 'completado', ultima_revision: new Date() })
            .eq('job_id', server.job_id);
        
        res.json({ job_id: server.job_id });
    } else {
        res.status(404).json({ job_id: null });
    }
});

// --- 📝 REPORTAR HALLAZGOS ---
app.post('/add-server', async (req, res) => {
    const { jobId, brainrots, vps_name } = req.body;
    if (!brainrots) return res.json({status: "no data"});

    // Guardar en Supabase
    const insertData = brainrots.map(p => ({
        pet_name: p.name, valor_gen: p.gen, mutacion: p.mutation || "None", job_id: jobId, vps_name: vps_name
    }));
    await supabase.from('hallazgos').insert(insertData);

    // Enviar a Discord (Filtro 30M)
    const highValue = brainrots.filter(p => parseGenValue(p.gen) >= 30);
    if (highValue.length > 0) {
        const target = getWebhookByVPS(vps_name);
        if (target) {
            let desc = "";
            highValue.forEach(p => { desc += `💎 **${p.name}** | 📈 ${p.gen}\n`; });
            axios.post(target, {
                embeds: [{
                    title: `🚨 HALLAZGO DETECTADO (${vps_name})`,
                    description: desc + `\n🎮 **JobId:** \`${jobId}\``,
                    color: 5793266,
                    timestamp: new Date()
                }]
            }).catch(e => console.log("DC Error"));
        }
    }
    res.json({ status: "ok" });
});

app.post('/add-servers-bulk', async (req, res) => {
    const { job_ids } = req.body;
    const insertData = job_ids.map(id => ({ job_id: id, estado: 'pendiente' }));
    await supabase.from('servidores').upsert(insertData, { onConflict: 'job_id' });
    res.json({ status: "ok" });
});

app.get('/status', async (req, res) => {
    const { count } = await supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente');
    res.json({ servidores_pendientes: count });
});

app.listen(process.env.PORT || 8080);
