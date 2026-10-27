const nativeFetch = globalThis.fetch.bind(globalThis);
const transientStatuses = new Set([502, 503, 504]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isCommercialApi(url) {
  try {
    const target = new URL(typeof url === 'string' ? url : url?.url || String(url));
    const configured = new URL(String(process.env.WPGO_COMMERCIAL_API || 'https://wpgo-commercial-api.onrender.com'));
    return target.origin === configured.origin;
  } catch {
    return false;
  }
}

async function safeCommercialFetch(input, init) {
  let lastResponse;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await nativeFetch(input, init);
      lastResponse = response;
      if (!transientStatuses.has(response.status)) return response;
      if (attempt < 2) {
        // Drain the response before retrying so the connection can be reused cleanly.
        try { await response.arrayBuffer(); } catch {}
        await sleep(attempt === 0 ? 350 : 900);
        continue;
      }
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(attempt === 0 ? 350 : 900);
        continue;
      }
    }
  }

  const status = lastResponse?.status && transientStatuses.has(lastResponse.status)
    ? lastResponse.status
    : 503;
  const body = JSON.stringify({
    error: 'commercial_api_temporarily_unavailable',
    message: 'WPGo is temporarily starting or unavailable. Please try the connection again in a moment.'
  });
  console.error(JSON.stringify({
    event: 'commercial_api_retry_exhausted',
    status,
    error: lastError ? String(lastError?.message || lastError).slice(0, 300) : ''
  }));
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

globalThis.fetch = async (input, init) => {
  if (!isCommercialApi(input)) return nativeFetch(input, init);
  return safeCommercialFetch(input, init);
};
