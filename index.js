const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// 🔌 CONEXIÓN CON SUPABASE
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 🧠 CACHÉ PARA EVITAR DUPLICADOS EN DISCORD (5 MINUTOS)
const processedJobs = new Set();

// 🛠️ UTILIDAD: CONVERTIR VALORES (Ej: 1B -> 1000M) PARA FILTRADO
function parseGenValue(text) {
    if (!text) return 0;
    const clean = text.toUpperCase().replace(/\s/g, '');
    const num = parseFloat(clean.match(/\d+\.?\d*/) || 0);
    if (clean.includes('B')) return num * 1000;
    return num;
}

// 🎯 ENRUTADOR: 3 VPS POR CANAL (Soporta hasta 20 VPS)
function getWebhookByVPS(vpsName) {
    if (!vpsName) return process.env.WEBHOOK_1;
    const num = parseInt(vpsName.replace(/\D/g, '') || 0);
    if (num >= 1 && num <= 3) return process.env.WEBHOOK_1;
    if (num >= 4 && num <= 6) return process.env.WEBHOOK_2;
    if (num >= 7 && num <= 9) return process.env.WEBHOOK_3;
    if (num >= 10 && num <= 12) return process.env.WEBHOOK_4;
    if (num >= 13 && num <= 15) return process.env.WEBHOOK_5;
    if (num >= 16) return process.env.WEBHOOK_6;
    return process.env.WEBHOOK_1;
}

// =====================================================
// 🔄 LÓGICA DE RECICLAJE (CORRE CADA 10 SEGUNDOS)
// Independiente de las requests de los bots
// =====================================================
async function manejarReciclaje() {
    try {
        const [
            { count: pendientes },
            { count: frescos },
            { count: usados },
            { count: entregados }
        ] = await Promise.all([
            supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente'),
            supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente_nuevo'),
            supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'usado'),
            supabase.from('servidores').select('*', { count: 'exact', head: true }).eq('estado', 'entregado')
        ]);

        // Si hay 10k+ nuevos → borrar todo lo viejo → activar nuevos
        if (frescos >= 10000) {
            await Promise.all([
                supabase.from('servidores').delete().eq('estado', 'usado'),
                supabase.from('servidores').delete().eq('estado', 'entregado'),
                supabase.from('servidores').delete().eq('estado', 'reciclado')
            ]);
            const { error } = await supabase
                .from('servidores')
                .update({ estado: 'pendiente' })
                .eq('estado', 'pendiente_nuevo');

            if (!error) console.log(`🧹 Ciclo nuevo activado. ${frescos} frescos → pendiente. Viejos borrados.`);
            return;
        }

        // Si hay menos de 500 pendientes → reciclar usados Y entregados huérfanos
        if (pendientes < 500) {
            const total = (usados || 0) + (entregados || 0);
            if (total > 0) {
                await Promise.all([
                    supabase.from('servidores').update({ estado: 'pendiente' }).eq('estado', 'usado'),
                    supabase.from('servidores').update({ estado: 'pendiente' }).eq('estado', 'entregado')
                ]);
                console.log(`♻️ Reciclados ${total} servidores (${usados} usados + ${entregados} huérfanos) → pendiente. Frescos nuevos: ${frescos}`);
            }
        }

    } catch (err) {
        console.log('❌ Error en manejarReciclaje:', err.message);
    }
}

// ✅ CORRE CADA 10 SEGUNDOS — no depende de los bots
setInterval(manejarReciclaje, 10000);

// =====================================================
// 📥 RUTA: RECIBIR HALLAZGO DESDE LOS BOTS
// =====================================================
app.post('/add-server', async (req, res) => {
    const { jobId, brainrots, vps_name, players } = req.body;

    if (processedJobs.has(jobId)) return res.json({ status: "skipped" });

    if (brainrots && brainrots.length > 0) {
        const petNames = brainrots.map(p => p.name).join(', ');
        const topPet = brainrots[0];
        await supabase.from('hallazgos').insert({
            pet_name: petNames,
            valor_gen: topPet.gen || topPet.value,
            mutacion: topPet.mutation || "None",
            job_id: jobId,
            vps_name: vps_name
        });

        const highValue = brainrots.filter(p => parseGenValue(p.gen || p.value) >= 30);

        if (highValue.length > 0) {
            const target = getWebhookByVPS(vps_name);
            if (target) {
                processedJobs.add(jobId);
                setTimeout(() => processedJobs.delete(jobId), 300000);

                let petList = "";
                highValue.forEach(p => {
                    const price = p.gen || p.value;
                    const mutationText = (p.mutation && p.mutation !== "None") ? ` (${p.mutation})` : "";
                    petList += `💎 **${p.name}${mutationText}** ${price}\n`;
                    if (p.inDuel) {
                        petList += `⚠️ **EN DUELO**\n`;
                    }
                });

                const joinerUrl = `https://plsbrainrot.me/joiner?placeId=109983668079237&gameInstanceId=${jobId}`;
                const joinScript = `game:GetService("TeleportService"):TeleportToPlaceInstance(109983668079237, "${jobId}", game.Players.LocalPlayer)`;

                const payload = {
                    embeds: [{
                        author: { name: 'Brainrot Notify | MidJourney' },
                        title: `🔎 PET DETECTED (${highValue.length} Found)`,
                        description: `**DETECTED PETS**\n\n${petList}\n` +
                                     `🆔 **Job ID (PC)**\n\`${jobId}\`\n\n` +
                                     `🆔 **Job ID (Mobile)**\n\`${jobId}\`\n\n` +
                                     `🎮 **Players Online**\n${players || 1}/8\n\n` +
                                     `🤖 **Bot**\n${vps_name}\n\n` +
                                     `🔗 **Quick Join**\n[Click to Join](${joinerUrl})\n\n` +
                                     `📜 **Join Script**\n\`\`\`lua\n${joinScript}\n\`\`\``,
                        color: 5793266,
                        timestamp: new Date()
                    }]
                };

                axios.post(target, payload).catch(e => console.log("Error Discord"));
            }
        }
    }

    // ✅ Marca como usado (no borra)
    await supabase.from('servidores').update({ estado: 'usado' }).eq('job_id', jobId);

    res.json({ status: "ok" });
});

// =====================================================
// 📤 RUTA: ENTREGAR SERVIDOR ÚNICO (GET-SERVER)
// =====================================================
app.get('/get-server', async (req, res) => {
    try {
        const { data, error } = await supabase.rpc('entregar_servidor_v3');
        if (error) throw error;
        if (data && data.length > 0) {
            res.json({ job_id: data[0].id_servidor });
        } else {
            res.json({ job_id: null });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================================
// ⚡ RUTA: INYECTAR SERVIDORES NUEVOS (ADD-BULK)
// Nuevos entran como 'pendiente_nuevo' para no mezclarse
// con el ciclo actual que está corriendo
// =====================================================
app.post('/add-servers-bulk', async (req, res) => {
    const { job_ids } = req.body;
    if (!job_ids || job_ids.length === 0) return res.json({ status: "empty" });

    const { count: pendientes } = await supabase
        .from('servidores')
        .select('*', { count: 'exact', head: true })
        .eq('estado', 'pendiente');

    const estadoEntrada = pendientes === 0 ? 'pendiente' : 'pendiente_nuevo';

    const { error } = await supabase
        .from('servidores')
        .upsert(
            job_ids.map(id => ({ job_id: id, estado: estadoEntrada })),
            { onConflict: 'job_id' }
        );

    if (error) return res.status(500).json(error);
    res.json({ status: "ok", added: job_ids.length });
});

// =====================================================
// 📊 RUTA: VER ESTADO DE LA COLA
// =====================================================
app.get('/status', async (req, res) => {
    const { data, error } = await supabase.rpc('contar_pendientes');
    if (error) return res.status(500).json(error);
    res.json({ servidores_pendientes: data });
});

app.get('/', (req, res) => {
    res.send('🛰️ Sistema de Escaneo Industrial Activo');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    manejarReciclaje();
});
