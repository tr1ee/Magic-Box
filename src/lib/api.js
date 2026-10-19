export async function api(path, options) {
  const response = await fetch(path, options);

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || payload.message || `Request failed (${response.status}).`);
    error.status = response.status;
    if (typeof payload.code === "string") error.code = payload.code;
    if (typeof payload.canVerifyInBrowser === "boolean") error.canVerifyInBrowser = payload.canVerifyInBrowser;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// Retry observation of an existing job, never the operation that created it.
export function retryableStatusError(error) {
  return !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
}
