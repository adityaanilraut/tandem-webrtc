export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function requestJson<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
  const signal = options?.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  let response: Response;
  try {
    response = await fetch(path, { ...options, signal });
  } catch {
    throw new Error(
      "Couldn’t reach the call server. Check your connection and try again.",
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new HttpError(
      response.status,
      typeof data?.message === "string"
        ? data.message
        : "The call server couldn’t complete your request. Try again shortly.",
    );
  if (data === null)
    throw new Error(
      "The call server sent an unexpected response. Try again shortly.",
    );
  return data as T;
}
