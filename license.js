// Central license/access endpoint. Every deployed client copy of the bot
// (regardless of which Netlify site it lives on) reads its own status here.
// Writes require ADMIN_KEY, set as a Netlify environment variable on THIS
// site only (Site configuration → Environment variables) — never shipped
// in any client's code.

const { getStore } = require('@netlify/blobs');

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

    try {
        const store = getStore({ name: 'clients', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN });

        if (event.httpMethod === 'GET') {
            const params = event.queryStringParameters || {};

            // Admin: list all registered clients.
            if (params.list) {
                if ((params.adminKey || '').trim() !== (process.env.ADMIN_KEY || '').trim()) {
                    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'invalid admin key' }) };
                }
                const index = (await store.get('_index', { type: 'json' })) || [];
                const clients = [];
                for (const id of index) {
                    const c = await store.get('client:' + id, { type: 'json' });
                    if (c) {
                        const stats = await store.get('stats:' + id, { type: 'json' });
                        clients.push({ ...c, stats: stats || null });
                    }
                }
                return { statusCode: 200, headers: CORS, body: JSON.stringify({ clients }) };
            }

            // Client self-check: is this ID active or suspended?
            if (!params.client) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing client id' }) };
            const clientId = params.client.trim();
            const c = await store.get('client:' + clientId, { type: 'json' });
            if (!c) return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'unknown', checkedId: clientId }) };
            return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: c.status, name: c.name, checkedId: clientId }) };
        }

        if (event.httpMethod === 'POST') {
            let body;
            try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid body' }) }; }

            // Public: check the whole-site access password — anyone needs to
            // pass this before reaching the login screen at all. No admin key
            // required here since ordinary users must be able to check it.
            if (body.action === 'check_password') {
                const stored = await store.get('_site_password', { type: 'text' });
                const ok = !!stored && (body.password || '') === stored;
                return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok }) };
            }

            // Admin only: change the whole-site access password.
            if (body.action === 'set_password') {
                if ((body.adminKey || '').trim() !== (process.env.ADMIN_KEY || '').trim()) {
                    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'invalid admin key' }) };
                }
                if (!body.password) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing password' }) };
                await store.set('_site_password', body.password);
                return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
            }

            // Public: a client's bot reports one settled real-money batch.
            // No admin key needed — this is the client's own copy reporting
            // its own results, tagged by their login ID.
            if (body.action === 'report_stats') {
                if (!body.client) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing client' }) };
                const pnl = Number(body.pnl) || 0;
                const won = !!body.won;
                const key = 'stats:' + body.client;
                const s = (await store.get(key, { type: 'json' })) || { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };
                s.totalPnl = Math.round((s.totalPnl + pnl) * 100) / 100;
                s.totalTrades += 1;
                won ? s.wins++ : s.losses++;
                s.lastUpdate = new Date().toISOString();
                await store.setJSON(key, s);
                return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
            }

            // Admin only: permanently remove a client from the registry.
            if (body.action === 'delete_client') {
                if ((body.adminKey || '').trim() !== (process.env.ADMIN_KEY || '').trim()) {
                    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'invalid admin key' }) };
                }
                if (!body.id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing id' }) };
                const delId = body.id.trim();
                await store.delete('client:' + delId);
                await store.delete('stats:' + delId);
                const index = (await store.get('_index', { type: 'json' })) || [];
                await store.setJSON('_index', index.filter(x => x !== delId));
                return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
            }

            if ((body.adminKey || '').trim() !== (process.env.ADMIN_KEY || '').trim()) {
                return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'invalid admin key' }) };
            }
            if (!body.id || !body.name || !body.status) {
                return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing id, name, or status' }) };
            }
            const cleanId = body.id.trim();

            const record = { id: cleanId, name: body.name.trim(), status: body.status };
            await store.setJSON('client:' + cleanId, record);

            const index = (await store.get('_index', { type: 'json' })) || [];
            if (!index.includes(cleanId)) {
                index.push(cleanId);
                await store.setJSON('_index', index);
            }

            return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, client: record }) };
        }

        return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method not allowed' }) };
    } catch (err) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'license function error: ' + err.message }) };
    }
};
