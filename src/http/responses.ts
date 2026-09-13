export const LFS_CONTENT_TYPE = "application/vnd.git-lfs+json";

export const UNAUTHORIZED_HEADERS = { "LFS-Authenticate": 'Basic realm="r2-lfs"' };

export function lfsJson(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": LFS_CONTENT_TYPE, ...headers },
  });
}

export function lfsError(status: number, message: string): Response {
  return lfsJson(status, { message }, status === 401 ? UNAUTHORIZED_HEADERS : {});
}
