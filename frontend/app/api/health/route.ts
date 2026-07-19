// frontend/app/api/health/route.ts
export async function GET() {
  return Response.json({
    status: "ok",
    service: "genstory-oss-viewer",
    timestamp: new Date().toISOString(),
  });
}
