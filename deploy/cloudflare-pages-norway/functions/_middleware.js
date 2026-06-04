export async function onRequest(context) {
  const expectedUser = "norway";
  const expectedPass = "norway";

  const unauthorized = () =>
    new Response("Authentication required", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Norway House Census Map"',
        "Cache-Control": "no-store",
      },
    });

  const auth = context.request.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) {
    return unauthorized();
  }

  try {
    const encoded = auth.slice(6).trim();
    const decoded = atob(encoded);
    const sep = decoded.indexOf(":");
    if (sep === -1) {
      return unauthorized();
    }

    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user !== expectedUser || pass !== expectedPass) {
      return unauthorized();
    }
  } catch {
    return unauthorized();
  }

  return context.next();
}
