const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Conexión directa
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 🎯 ASIGNAR SERVIDOR ---
app.get('/get-server', async (req, res) => {
    // Buscamos un servidor pendiente de forma ultra simple
    const { data, error } = await supabase
        .from('servidores')
        .select('job_id')
        .eq('estado', 'pendiente')
        .limit(1);

    if (error) {
        console.error("Error DB:", error.message);
        return res.status(500).json({ job_id: null });
    }

    if (data && data.length > 0) {
        const targetId = data[0].job_id;
        // Lo marcamos como 'completado' para que el próximo bot no lo use
        await supabase.from('servidores').update({ estado: 'completado' }).eq('job_id', targetId);
        return res.status(200).json({ job_id: targetId });
    } else {
        return res.status(200).json({ job_id: null });
    }
});

// --- 📝 REPORTAR HALLAZGOS ---
app.post('/add-server', async (req, res) => {
    const { jobId, brainrots, vps_name } = req.body;
    if (!brainrots || brainrots.length === 0) return res.json({ status: "ok" });

    // Guardar en Supabase
    await supabase.from('hallazgos').insert(brainrots.map(p => ({
        pet_name: p.name, valor_gen: p.gen, mutacion: p.mutation || "None", job_id: jobId, vps_name: vps_name
    })));

    // Enrutador de Discord
    const vpsNum = parseInt(vps_name.replace(/\D/g, '') || 0);
    let webhook = process.env.WEBHOOK_1;
    if (vpsNum >= 4 && vpsNum <= 6) webhook = process.env.WEBHOOK_2;
    if (vpsNum >= 7 && vpsNum <= 9) webhook = process.env.WEBHOOK_3;
    if (vpsNum >= 10 && vpsNum <= 12) webhook = process.env.WEBHOOK_4;
    if (vpsNum >= 13 && vpsNum <= 15) webhook = process.env.WEBHOOK_5;
    if (vpsNum >= 16) webhook = process.env.WEBHOOK_6;

    // Solo enviamos a Discord si es valioso (Filtro 30M)
    const highValue = brainrots.filter(p => {
        const v = parseFloat(p.gen.match(/\d+\.?\d*/) || 0);
        return p.gen.includes('B') ? v * 1000 >= 30 : v >= 30;
    });

    if (highValue.length > 0 && webhook) {
        let desc = "";
        highValue.forEach(p => { desc += `💎 **${p.name}** [${p.gen}]\n`; });
        axios.post(webhook, {
            embeds: [{
                title: `🚨 HALLAZGO EN ${vps_name}`,
                description: desc + `\n🎮 **ID:** \`${jobId}\``,
                color: 5793266,
                timestamp: new Date()
            }]
        }).catch(() => {});
    }
    res.json({ status: "ok" });
});

app.post('/add-servers-bulk', async (req, res) => {
    const { job_ids } = req.body;
    await supabase.from('servidores').upsert(job_ids.map(id => ({ job_id: id, estado: 'pendiente' })), { onConflict: 'job_id' });
    res.json({ status: "ok" });
});

app.get('/status', async (req, res) => {
    const { count } = await supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente');
    res.json({ servidores_pendientes: count });
});

app.listen(process.env.PORT || 8080, () => console.log("Cerebro listo"));
