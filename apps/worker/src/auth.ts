const encoder = new TextEncoder();

// Hash both sides so timingSafeEqual always compares equal-length buffers.
export async function hasBearer(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  const [given, wanted] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(given, wanted);
}
