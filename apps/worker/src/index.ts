import { hasBearer } from "./auth";

const unauthorized = () =>
  new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Bearer realm="magpie"' } });

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") return Response.json({ ok: true });

    if (pathname === "/ingest") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!(await hasBearer(request, env.INGEST_TOKEN))) return unauthorized();
      return new Response("not implemented", { status: 501 }); // replaced in Task 6
    }

    if (pathname === "/mcp") {
      if (!(await hasBearer(request, env.MCP_TOKEN))) return unauthorized();
      return new Response("not implemented", { status: 501 }); // replaced in Task 7
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
