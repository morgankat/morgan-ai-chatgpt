// Central AI relay. The model, endpoint, and API key are configured ONLY
// as environment variables on THIS site (Site configuration → Environment
// variables: AI_ENDPOINT, AI_API_KEY, AI_MODEL) — never sent by, or visible
// to, any client's copy of the bot. Every deployed client bot calls this
// one shared URL; nothing secret ever reaches their browser.

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method not allowed' }) };
    }

    const endpoint = process.env.AI_ENDPOINT;
    const apiKey = process.env.AI_API_KEY;
    const model = process.env.AI_MODEL;
    if (!endpoint || !apiKey || !model) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'AI_ENDPOINT, AI_API_KEY, or AI_MODEL not configured on the server' }) };
    }

    let systemPrompt, userPrompt, history;
    try {
        ({ systemPrompt, userPrompt, history } = JSON.parse(event.body || '{}'));
    } catch {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'invalid request body' }) };
    }
    if (!userPrompt) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing userPrompt' }) };
    }

    try {
        const messages = [{ role: 'system', content: systemPrompt || '' }];
        if (Array.isArray(history)) {
            for (const turn of history) {
                if (turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string') {
                    messages.push({ role: turn.role, content: turn.content });
                }
            }
        }
        messages.push({ role: 'user', content: userPrompt });

        const res = await fetch(endpoint.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify({ model, messages }),
        });

        const text = await res.text();
        return { statusCode: res.status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: text };
    } catch (err) {
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'relay fetch failed: ' + err.message }) };
    }
};
