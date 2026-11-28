// Only read-only requests may be replayed automatically. A write with an
// uncertain outcome requires fresh domain state, not a transport-level retry.
export function createGitHubRequestPolicy({ fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, random = Math.random, log = console.log, maxAttempts = 4, budgetMs = 120000 } = {}) {
 const deadline = now() + budgetMs;
 let requests = 0;
 return async (url, options = {}, { readOnly = false, allowNotFound = false, graphql = false } = {}) => {
  for (let attempt = 1; ; attempt++) {
   let response, payload, category;
   const remaining = deadline - now();
   if (remaining <= 0) throw new Error('GITHUB_API_REQUEST_FAILED: deadline exhausted-or-deferred');
   const controller = new AbortController();
   const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
   let timer;
   let timedOut = false;
   try {
    requests++;
    const operation = (async () => {
     const result = await fetchImpl(url, { ...options, signal });
     if ((allowNotFound && result.status === 404) || result.status === 204) return { response: result, payload: null };
     let json;
     try { json = await result.json(); } catch { json = null; }
     return { response: result, payload: json };
    })();
    const timeout = new Promise((_, reject) => {
     timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('deadline')); }, remaining);
    });
    ({ response, payload } = await Promise.race([operation, timeout]));
    if (allowNotFound && response.status === 404) return null;
    if (response.status === 204) return null;
    const message = typeof payload?.message === 'string' ? payload.message : '';
    if (response.status === 429) category = 'rate-limit';
    else if (response.status === 403) category = response.headers?.get('x-ratelimit-remaining') === '0' || /rate limit|secondary rate/i.test(message) ? 'rate-limit' : 'authorization-or-unknown';
    else if (response.status === 401) category = 'authentication';
    else if (response.status >= 500 && response.status <= 599) category = 'server';
    else if (!response.ok) category = 'http';
    else if (graphql && payload?.errors?.length && payload.errors.every((error) => error.type === 'RATE_LIMITED')) category = 'rate-limit';
    else if (graphql && payload?.errors?.length) category = payload.errors.every((error) => /internal|service unavailable|something went wrong/i.test(error.message ?? '')) ? 'graphql-transient' : 'graphql';
    else return graphql ? payload?.data : payload;
   } catch {
    if (timedOut) throw new Error('GITHUB_API_REQUEST_FAILED: deadline exhausted-or-deferred');
    category = 'network';
   } finally { clearTimeout(timer); }
   const retryable = readOnly && ['network', 'server', 'rate-limit', 'graphql-transient'].includes(category);
   const header = (name) => response?.headers?.get(name);
   const retryAfter = header('retry-after');
   const seconds = retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter);
   const date = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
   const reset = Number(header('x-ratelimit-reset'));
   const guidance = Math.max(Number.isFinite(seconds) ? seconds * 1000 : 0, Number.isFinite(date) ? date - now() : 0, category === 'rate-limit' && header('x-ratelimit-remaining') === '0' && Number.isFinite(reset) ? reset * 1000 - now() : 0);
   const delay = Math.max(guidance, 500 * 2 ** (attempt - 1) * (1 + random()));
   const canRetry = retryable && attempt < maxAttempts && now() + delay < deadline;
   const requestId = header('x-github-request-id');
   log(`GitHub request category=${category} status=${response?.status ?? 'network'} requests=${requests} retries=${attempt - 1} request_id=${/^[\w:-]{1,100}$/.test(requestId ?? '') ? requestId : 'unknown'} remaining=${/^\d+$/.test(header('x-ratelimit-remaining') ?? '') ? header('x-ratelimit-remaining') : 'unknown'} outcome=${canRetry ? 'retry' : retryable ? 'exhausted-or-deferred' : 'failed'}`);
   if (!canRetry) throw new Error(`${graphql ? 'GITHUB_GRAPHQL_REQUEST_FAILED' : 'GITHUB_API_REQUEST_FAILED'}: ${category} (${retryable ? 'exhausted-or-deferred' : 'failed'})`);
   await sleep(delay);
  }
 };
}
