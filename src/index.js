export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API test
    if (url.pathname === "/api/test") {
      try {
        const result = await env.DB
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all();

        return Response.json({
          success: true,
          message: "Srilatha Creations backend is working",
          database: "Connected",
          tables: result.results
        });
      } catch (error) {
        return Response.json(
          {
            success: false,
            error: error.message
          },
          { status: 500 }
        );
      }
    }

    // Products API
    if (url.pathname === "/api/products" && request.method === "GET") {
      try {
        const products = await env.DB
          .prepare(
            "SELECT * FROM products WHERE is_active = 1 ORDER BY id DESC"
          )
          .all();

        return Response.json(products.results);
      } catch (error) {
        return Response.json(
          { success: false, error: error.message },
          { status: 500 }
        );
      }
    }

    // All other requests -> existing website
    return env.ASSETS.fetch(request);
  }
};
